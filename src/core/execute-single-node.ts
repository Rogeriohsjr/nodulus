import { randomUUID } from "node:crypto";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import type { IntakeRequest, IntakeResult } from "./intake-request.js";
import type { ArtifactValidator } from "./ports/artifact-validator.js";
import type { IntakeStorage, RunFiles } from "./ports/intake-storage.js";
import type { ProviderPort } from "./ports/provider.js";
import { NodulusError } from "./shared/nodulus-error.js";

type Node = {
  id: string;
  providerProfile: string;
  inputs: Record<string, unknown>;
  instructions: string[];
  expectedOutputs: Array<{ name: string; contract: string; validator?: string; validatorTimeoutMs?: number }>;
};
type DefinitionContext = {
  workflow: { id: string; nodes: string[] };
  nodes: Node[];
  contracts: Record<string, unknown>;
  providerProfiles: Record<string, Record<string, unknown>>;
};
type CapturedInputs = {
  request: string;
  instructions: Array<{ path: string; content: string }>;
};
type OutputArtifact = { name: string; contract: string; data: unknown };
type ProviderOutcome =
  | { status: "success"; artifacts: OutputArtifact[] }
  | { status: "needs_input"; request: { id: string; questions: Array<{ id: string; message: string }>; answerContract: unknown } }
  | { status: "error"; error: { code: string; message: string } };
type RunResponse = { runId: string; status: "success" | "needs_input" | "error"; result: unknown };

const successSchema = {
  type: "object",
  required: ["status", "artifacts"],
  properties: {
    status: { const: "success" },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "contract", "data"],
        properties: {
          name: { type: "string", minLength: 1 },
          contract: { type: "string", minLength: 1 },
          data: {},
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const needsInputSchema = {
  type: "object",
  required: ["status", "request"],
  properties: {
    status: { const: "needs_input" },
    request: {
      type: "object",
      required: ["id", "questions", "answerContract"],
      properties: {
        id: { type: "string", minLength: 1 },
        questions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "message"],
            properties: { id: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1 } },
            additionalProperties: false,
          },
        },
        answerContract: { anyOf: [{ type: "object" }, { type: "boolean" }] },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const errorSchema = {
  type: "object",
  required: ["status", "error"],
  properties: {
    status: { const: "error" },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const ajv = new Ajv2020({ strict: false });
const validateSuccess = ajv.compile(successSchema);
const validateNeedsInput = ajv.compile(needsInputSchema);
const validateError = ajv.compile(errorSchema);

export async function executeSingleNode(
  request: IntakeRequest,
  intake: IntakeResult,
  provider: ProviderPort,
  storage: IntakeStorage,
  artifactValidator: ArtifactValidator,
): Promise<RunResponse> {
  const runId = intake.runId;
  const runDirectory = intake.runDirectory;
  const context = JSON.parse(await storage.readRunFile(request.projectRoot, runId, "context/definitions.json")) as DefinitionContext;
  const inputs = JSON.parse(await storage.readRunFile(request.projectRoot, runId, "inputs.json")) as CapturedInputs;
  if (context.nodes.length !== 1) {
    return finishError(request.projectRoot, runId, runDirectory, storage, "WORKFLOW_SEQUENCE_REQUIRED", "Folder 03 executes one-node workflows only.");
  }
  const node = context.nodes[0];
  const contracts = context.contracts;
  const profile = context.providerProfiles[node.providerProfile];
  const prompt = buildPrompt(context, node, inputs);
  const invocation = {
    runId,
    workflow: context.workflow.id,
    nodeId: node.id,
    prompt,
  };
  const attemptRoot = `nodes/${node.id}/attempt-001`;
  const startedAt = new Date().toISOString();
  const invocationRecord = {
    runId,
    workflow: context.workflow.id,
    nodeId: node.id,
    attempt: 1,
    startedAt,
    providerProfile: node.providerProfile,
    resolvedProviderProfile: profile,
    inputs: node.inputs,
    expectedOutputs: node.expectedOutputs,
    validator: node.expectedOutputs.find((output) => output.validator)?.validator,
  };

  await storage.writeRunFiles(request.projectRoot, runId, {
    "run.json": json({ schemaVersion: 1, runId, phase: "execution", status: "running", activeNode: node.id, attempt: 1 }),
    [`${attemptRoot}/invocation.json`]: json(invocationRecord),
    [`${attemptRoot}/prompt.md`]: prompt,
    [`${attemptRoot}/stderr.log`]: "",
  });
  await appendEvent(request.projectRoot, runId, storage, { event: "node.started", runId, nodeId: node.id, attempt: 1 });

  let raw: string;
  try {
    raw = await provider.invoke(invocation);
    if (typeof raw !== "string") throw new Error("Provider returned a non-string response.");
  } catch (error) {
    const diagnostic = { code: "PROVIDER_FAILURE", message: messageOf(error) };
    const validation = { valid: false, code: diagnostic.code, errors: [diagnostic.message] };
    await storage.writeRunFiles(request.projectRoot, runId, {
      [`${attemptRoot}/response.raw.txt`]: "",
      [`${attemptRoot}/stderr.log`]: diagnostic.message,
      [`${attemptRoot}/validation.json`]: json(validation),
    });
    await appendEvent(request.projectRoot, runId, storage, { event: "node.failed", runId, nodeId: node.id, code: diagnostic.code });
    return finishError(request.projectRoot, runId, runDirectory, storage, diagnostic.code, diagnostic.message, attemptRoot, validation);
  }

  await storage.writeRunFiles(request.projectRoot, runId, { [`${attemptRoot}/response.raw.txt`]: raw });
  const parsed = parseProviderOutcome(raw);
  if (!parsed.valid) {
    const validation = { valid: false, code: parsed.code, errors: parsed.errors };
    await storage.writeRunFiles(request.projectRoot, runId, { [`${attemptRoot}/validation.json`]: json(validation) });
    await appendEvent(request.projectRoot, runId, storage, { event: "node.rejected", runId, nodeId: node.id, code: parsed.code });
    return finishError(request.projectRoot, runId, runDirectory, storage, parsed.code, parsed.errors.join("; "), attemptRoot, validation);
  }

  if (parsed.outcome.status === "error") {
    const validation = { valid: true, outcome: "error", errors: [] };
    const result = { runId, status: "error", error: parsed.outcome.error };
    await storage.writeRunFiles(request.projectRoot, runId, {
      [`${attemptRoot}/validation.json`]: json(validation),
      [`${attemptRoot}/result.json`]: json({ status: "error", error: parsed.outcome.error }),
      "run.json": json({ schemaVersion: 1, runId, phase: "execution", status: "error", activeNode: node.id, attempt: 1 }),
      "result.json": json(result),
    });
    await appendEvent(request.projectRoot, runId, storage, { event: "node.error", runId, nodeId: node.id, error: parsed.outcome.error });
    return { runId, status: "error", result: { error: parsed.outcome.error } };
  }

  if (parsed.outcome.status === "needs_input") {
    const requestId = randomUUID();
    const pending = { ...parsed.outcome.request, id: requestId };
    try {
      new Ajv2020({ strict: false }).compile(pending.answerContract as AnySchema);
    } catch (error) {
      const validation = { valid: false, code: "INVALID_ANSWER_CONTRACT", errors: [messageOf(error)] };
      await storage.writeRunFiles(request.projectRoot, runId, { [`${attemptRoot}/validation.json`]: json(validation) });
      return finishError(request.projectRoot, runId, runDirectory, storage, "INVALID_ANSWER_CONTRACT", messageOf(error), attemptRoot, validation);
    }
    const validation = { valid: true, outcome: "needs_input", errors: [] };
    await storage.writeRunFiles(request.projectRoot, runId, {
      [`${attemptRoot}/validation.json`]: json(validation),
      [`${attemptRoot}/result.json`]: json({ status: "needs_input", request: pending }),
      "pending/request.json": json(pending),
      "run.json": json({ schemaVersion: 1, runId, phase: "execution", status: "needs_input", activeNode: node.id, attempt: 1, requestId }),
    });
    await appendEvent(request.projectRoot, runId, storage, { event: "node.needs_input", runId, nodeId: node.id, requestId });
    return { runId, status: "needs_input", result: { request: pending } };
  }

  const outputCheck = validateOutputSet(parsed.outcome.artifacts, node.expectedOutputs, contracts);
  if (!outputCheck.valid) {
    const validation = { valid: false, code: outputCheck.code, errors: outputCheck.errors };
    await storage.writeRunFiles(request.projectRoot, runId, { [`${attemptRoot}/validation.json`]: json(validation) });
    await appendEvent(request.projectRoot, runId, storage, { event: "node.rejected", runId, nodeId: node.id, code: outputCheck.code });
    return finishError(request.projectRoot, runId, runDirectory, storage, outputCheck.code, outputCheck.errors.join("; "), attemptRoot, validation);
  }

  const validatorResults: unknown[] = [];
  for (const artifact of parsed.outcome.artifacts) {
    const expected = node.expectedOutputs.find((output) => output.name === artifact.name)!;
    if (!expected.validator) continue;
    const scriptPath = path.resolve(request.projectRoot, expected.validator);
    let processResult;
    try {
      processResult = await artifactValidator.execute(
        request.projectRoot,
        scriptPath,
        json(artifact.data),
        expected.validatorTimeoutMs ?? 5000,
      );
    } catch (error) {
      const validation = { valid: false, code: "VALIDATOR_EXECUTION_FAILED", errors: [messageOf(error)] };
      await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation);
      return finishError(request.projectRoot, runId, runDirectory, storage, validation.code, validation.errors.join("; "), attemptRoot, validation);
    }
    if (processResult.timedOut) {
      const validation = { valid: false, code: "VALIDATOR_TIMEOUT", errors: [`Validator '${expected.validator}' exceeded its timeout.`] };
      await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, processResult.stderr);
      return finishError(request.projectRoot, runId, runDirectory, storage, validation.code, validation.errors.join("; "), attemptRoot, validation);
    }
    if (processResult.outputLimitExceeded || processResult.exitCode !== 0) {
      const validation = { valid: false, code: "VALIDATOR_EXECUTION_FAILED", errors: [processResult.stderr || "Validator exited unsuccessfully or exceeded output limit."] };
      await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, processResult.stderr);
      return finishError(request.projectRoot, runId, runDirectory, storage, validation.code, validation.errors.join("; "), attemptRoot, validation);
    }
    let verdict: unknown;
    try {
      verdict = JSON.parse(processResult.stdout) as unknown;
    } catch {
      const validation = { valid: false, code: "VALIDATOR_INVALID_RESPONSE", errors: ["Validator stdout must be a JSON verdict."] };
      await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, processResult.stderr);
      return finishError(request.projectRoot, runId, runDirectory, storage, validation.code, validation.errors.join("; "), attemptRoot, validation);
    }
    const checkedVerdict = validateValidatorVerdict(verdict);
    if (!checkedVerdict.valid) {
      const validation = { valid: false, code: "VALIDATOR_INVALID_RESPONSE", errors: checkedVerdict.errors };
      await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, processResult.stderr);
      return finishError(request.projectRoot, runId, runDirectory, storage, validation.code, validation.errors.join("; "), attemptRoot, validation);
    }
    validatorResults.push({ name: artifact.name, valid: checkedVerdict.validity, errors: checkedVerdict.errors });
    if (!checkedVerdict.validity) {
      const validation = { valid: false, code: "ARTIFACT_REJECTED", errors: checkedVerdict.errors };
      await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, processResult.stderr);
      return finishError(request.projectRoot, runId, runDirectory, storage, validation.code, validation.errors.join("; "), attemptRoot, validation);
    }
  }

  const validation = { valid: true, outcome: "success", validators: validatorResults, errors: [] };
  const result = { runId, status: "success", artifacts: parsed.outcome.artifacts };
  const persisted: RunFiles = {
    [`${attemptRoot}/validation.json`]: json(validation),
    [`${attemptRoot}/result.json`]: json({ status: "success", artifacts: parsed.outcome.artifacts }),
  };
  for (const artifact of parsed.outcome.artifacts) {
    persisted[`nodes/${node.id}/artifacts/${artifact.name}.json`] = json(artifact);
  }
  await storage.writeRunFiles(request.projectRoot, runId, persisted);
  await storage.writeRunFiles(request.projectRoot, runId, {
    "run.json": json({ schemaVersion: 1, runId, phase: "execution", status: "success", activeNode: null, completedNodes: [node.id], attempt: 1 }),
  });
  await storage.writeRunFiles(request.projectRoot, runId, { "result.json": json(result) });
  await appendEvent(request.projectRoot, runId, storage, { event: "node.succeeded", runId, nodeId: node.id, artifactNames: parsed.outcome.artifacts.map((artifact) => artifact.name) });
  return { runId, status: "success", result: { artifacts: parsed.outcome.artifacts } };
}

function parseProviderOutcome(raw: string):
  | { valid: true; outcome: { status: "success"; artifacts: OutputArtifact[] } | { status: "needs_input"; request: { id: string; questions: Array<{ id: string; message: string }>; answerContract: unknown } } | { status: "error"; error: { code: string; message: string } } }
  | { valid: false; code: string; errors: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    return { valid: false, code: "INVALID_NODE_RESPONSE", errors: [`Provider response is not valid JSON: ${messageOf(error)}`] };
  }
  if (!isRecord(value) || typeof value.status !== "string") {
    return { valid: false, code: "INVALID_NODE_OUTCOME", errors: ["Provider response must have a recognized system outcome status."] };
  }
  const validator = value.status === "success" ? validateSuccess : value.status === "needs_input" ? validateNeedsInput : value.status === "error" ? validateError : undefined;
  if (!validator) return { valid: false, code: "INVALID_NODE_OUTCOME", errors: [`Unknown outcome status '${value.status}'.`] };
  if (!validator(value)) return { valid: false, code: "INVALID_NODE_OUTCOME", errors: ajv.errorsText(validator.errors, { separator: "; " }).split("; ") };
  return { valid: true, outcome: value as ProviderOutcome };
}

function validateOutputSet(
  artifacts: OutputArtifact[],
  expected: Node["expectedOutputs"],
  schemas: Record<string, unknown>,
): { valid: true } | { valid: false; code: string; errors: string[] } {
  const errors: string[] = [];
  const byName = new Map<string, OutputArtifact>();
  for (const artifact of artifacts) {
    if (byName.has(artifact.name)) errors.push(`Artifact '${artifact.name}' was returned more than once.`);
    else byName.set(artifact.name, artifact);
    if (!expected.some((item) => item.name === artifact.name)) errors.push(`Unexpected artifact '${artifact.name}'.`);
  }
  for (const output of expected) {
    const artifact = byName.get(output.name);
    if (!artifact) {
      errors.push(`Expected artifact '${output.name}' is missing.`);
      continue;
    }
    if (artifact.contract !== output.contract) {
      errors.push(`Artifact '${output.name}' must use contract '${output.contract}'.`);
      continue;
    }
    const schema = schemas[output.contract];
    try {
      const validate = new Ajv2020({ strict: false }).compile(schema as AnySchema);
      if (!validate(artifact.data)) errors.push(`Artifact '${output.name}' violates ${output.contract}: ${ajv.errorsText(validate.errors)}.`);
    } catch (error) {
      errors.push(`Could not validate artifact '${output.name}': ${messageOf(error)}`);
    }
  }
  return errors.length === 0 ? { valid: true } : { valid: false, code: "ARTIFACT_VALIDATION_FAILED", errors };
}

function validateValidatorVerdict(value: unknown): { valid: boolean; validity?: boolean; errors: string[] } {
  if (!isRecord(value) || typeof value.valid !== "boolean" || !Array.isArray(value.errors) || !value.errors.every((item) => typeof item === "string") || Object.keys(value).some((key) => !["valid", "errors"].includes(key))) {
    return { valid: false, errors: ["Validator verdict must be exactly {valid:boolean,errors:string[]}."] };
  }
  return { valid: true, validity: value.valid, errors: value.errors as string[] };
}

function buildPrompt(context: DefinitionContext, node: Node, inputs: CapturedInputs): string {
  const nodeSchemas = Object.fromEntries(node.expectedOutputs.map((output) => [output.contract, context.contracts[output.contract]]));
  const instructions = inputs.instructions.map((item) => `## ${item.path}\n${item.content}`).join("\n\n");
  return [
    `Workflow: ${context.workflow.id}`,
    `Node: ${node.id}`,
    "## Request",
    inputs.request,
    "## Instructions",
    instructions,
    "## Inputs",
    JSON.stringify(node.inputs, null, 2),
    "## Required output contracts",
    JSON.stringify(nodeSchemas, null, 2),
    "Return one JSON object matching the package outcome protocol. Do not include runtime metadata.",
  ].join("\n\n");
}

async function finishError(
  projectRoot: string,
  runId: string,
  _runDirectory: string,
  storage: IntakeStorage,
  code: string,
  message: string,
  attemptRoot?: string,
  validation?: unknown,
): Promise<RunResponse> {
  const result = { runId, status: "error", error: { code, message } };
  const files: RunFiles = {
    "run.json": json({ schemaVersion: 1, runId, phase: "execution", status: "error", error: { code, message } }),
    "result.json": json(result),
  };
  if (attemptRoot) files[`${attemptRoot}/result.json`] = json({ status: "error", error: { code, message } });
  if (attemptRoot && validation !== undefined) files[`${attemptRoot}/validation.json`] = json(validation);
  await storage.writeRunFiles(projectRoot, runId, files);
  await appendEvent(projectRoot, runId, storage, { event: "run.failed", runId, code });
  return { runId, status: "error", result: { error: { code, message } } };
}

async function storeValidation(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage,
  attemptRoot: string,
  validation: unknown,
  stderr?: string,
): Promise<void> {
  await storage.writeRunFiles(projectRoot, runId, {
    [`${attemptRoot}/validation.json`]: json(validation),
    ...(stderr === undefined ? {} : { [`${attemptRoot}/stderr.log`]: stderr }),
  });
}

async function appendEvent(projectRoot: string, runId: string, storage: IntakeStorage, event: unknown): Promise<void> {
  const current = await storage.readRunFile(projectRoot, runId, "events.jsonl");
  await storage.writeRunFiles(projectRoot, runId, { "events.jsonl": `${current}${JSON.stringify(event)}\n` });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

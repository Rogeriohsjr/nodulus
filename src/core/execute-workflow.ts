import type { ProviderTelemetry } from "./ports/provider-telemetry.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import type { IntakeRequest, IntakeResult } from "./intake-request.js";
import type { ArtifactValidator } from "./ports/artifact-validator.js";
import type { IntakeStorage, RunFiles } from "./ports/intake-storage.js";
import type { ProviderCallContext, ProviderCallMetric, ProviderInvocation, ProviderPort, ProviderUsage } from "./ports/provider.js";
import { resolveOutputReference } from "./workflow-mapping.js";
import { appendRunEvent, recordValidationEvent, traceProviderCall } from "./execution-events.js";
import { feedbackArtifactReferences, type FeedbackRegionState } from "./feedback-routing.js";

type Node = {
  id: string;
  providerProfile: string;
  inputs: Record<string, unknown>;
  instructions: string[];
  expectedOutputs: Array<{ name: string; contract: string; validator?: string; validatorTimeoutMs?: number }>;
};
type DefinitionContext = {
  workflow: { id: string; nodes: string[]; inputs?: Record<string, { contract: string }>; feedbackRouting?: import("./feedback-definition.js").FeedbackRoutingDefinition };
  nodes: Node[];
  contracts: Record<string, unknown>;
  providerProfiles: Record<string, Record<string, unknown>>;
};
type CapturedInputs = {
  request: string;
  callerInputs?: Record<string, unknown>;
  instructions: Array<{ path: string; content: string }>;
};
type OutputArtifact = { name: string; contract: string; data: unknown };
type ProviderOutcome =
  | { status: "success"; artifacts: OutputArtifact[] }
  | { status: "needs_input"; request: { id: string; questions: Array<{ id: string; message: string }>; answerContract: unknown } }
  | { status: "error"; error: { code: string; message: string } };
type RunResponse = { runId: string; status: "success" | "needs_input" | "error"; result: unknown };
type MappedInputsResult = { valid: true; values: Record<string, unknown> } | { valid: false; code: string; message: string };
export type WorkflowExecutionState = {
  startNodeId?: string;
  completedNodes?: string[];
  answers?: Record<string, unknown>;
  callerInputs?: Record<string, unknown>;
  attempt?: number;
};

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

export async function executeWorkflow(
  request: IntakeRequest,
  intake: IntakeResult,
  provider: ProviderPort,
  storage: IntakeStorage,
  artifactValidator: ArtifactValidator,
  state: WorkflowExecutionState = {},
): Promise<RunResponse> {
  const runId = intake.runId;
  const context = JSON.parse(await storage.readRunFile(request.projectRoot, runId, "context/definitions.json")) as DefinitionContext;
  const inputs = JSON.parse(await storage.readRunFile(request.projectRoot, runId, "inputs.json")) as CapturedInputs;
  const contracts = context.contracts;
  const acceptedOutputs = new Map<string, Map<string, OutputArtifact>>();
  const completedNodes: string[] = [...(state.completedNodes ?? [])];
  const callerInputs = state.callerInputs ?? inputs.callerInputs ?? {};
  const resumeIndex = state.startNodeId ? context.nodes.findIndex((node) => node.id === state.startNodeId) : 0;
  if (state.startNodeId && resumeIndex < 0) {
    return finishError(request.projectRoot, runId, storage, "RUN_STATE_INVALID", `Paused node '${state.startNodeId}' is absent from the saved workflow.`, undefined, undefined, completedNodes);
  }
  if (!state.startNodeId) {
    const missing = missingCallerInputs(context.workflow.inputs ?? {}, callerInputs, contracts);
    if (missing.length > 0) {
      const requestId = randomUUID();
      const pending = {
        id: requestId,
        questions: missing.map(({ name }) => ({ id: name, message: `Provide the required '${name}' input.` })),
        answerContract: callerAnswerContract(missing, contracts),
      };
      await storage.writeRunFiles(request.projectRoot, runId, {
        "pending/request.json": json(pending),
        "run.json": json({ schemaVersion: 1, engineVersion: "1.0.0", runId, phase: "execution", status: "needs_input", activeNode: null, completedNodes, attempt: 0, requestId, pendingKind: "caller_inputs" }),
      });
      await appendEvent(request.projectRoot, runId, storage, { event: "run.needs_input", runId, requestId, kind: "caller_inputs" });
      return { runId, status: "needs_input", result: { request: pending } };
    }
  }

  const route = context.workflow.feedbackRouting;
  let routingSegmentStartedAt = performance.now();
  const attempts = new Map<string, number>();
  let providerCalls = 0;
  let elapsedBeforeSegment = 0;
  const persistRoutingElapsed = async (): Promise<void> => {
    if (!route) return;
    elapsedBeforeSegment += performance.now() - routingSegmentStartedAt;
    routingState.elapsedMs = elapsedBeforeSegment;
    routingState.providerCalls = providerCalls;
    routingSegmentStartedAt = performance.now();
    try {
      const checkpoint = JSON.parse(await storage.readRunFile(request.projectRoot, runId, "run.json")) as Record<string, unknown>;
      const feedbackRouting = checkpoint.feedbackRouting as { regions?: Record<string, FeedbackRegionState> } | undefined;
      await storage.writeRunFiles(request.projectRoot, runId, { "run.json": json({ ...checkpoint, feedbackRouting: { ...feedbackRouting, regions: { ...feedbackRouting?.regions, [route.regionId]: routingState } } }) });
    } catch { /* the caller still writes its complete checkpoint */ }
  };
  let routingState: FeedbackRegionState = { iteration: 1, generationHistory: [], invalidatedSuffixes: [], reusedPrefix: [], eligibleNodes: [] };
  let feedback: Record<string, unknown> | undefined;
  if (route) {
    try {
      const checkpoint = JSON.parse(await storage.readRunFile(request.projectRoot, runId, "run.json")) as { feedbackRouting?: { regions?: Record<string, FeedbackRegionState> } };
      const saved = checkpoint.feedbackRouting?.regions?.[route.regionId];
      if (saved && Number.isInteger(saved.iteration) && Array.isArray(saved.generationHistory)) routingState = saved;
      feedback = routingState.feedback;
      providerCalls = routingState.providerCalls ?? 0;
      elapsedBeforeSegment = routingState.elapsedMs ?? 0;
      routingSegmentStartedAt = performance.now();
      for (const record of routingState.generationHistory) {
        const nodeId = String(record.nodeId);
        const attempt = /attempt-(\d+)/.exec(String(record.attemptPath))?.[1];
        if (attempt) attempts.set(nodeId, Math.max(attempts.get(nodeId) ?? 0, Number(attempt)));
      }
      // Generation history covers routed artifacts, but not decision nodes. Restore
      // every node's high-water attempt from the durable execution event stream.
      const events = await storage.readRunFile(request.projectRoot, runId, "events.jsonl");
      for (const line of events.split(/\r?\n/)) {
        if (!line) continue;
        const event = JSON.parse(line) as { event?: string; nodeId?: string; attempt?: number };
        if (event.event === "node.started" && event.nodeId && Number.isInteger(event.attempt)) {
          attempts.set(event.nodeId, Math.max(attempts.get(event.nodeId) ?? 0, event.attempt as number));
        }
      }
    } catch { /* a new run has no prior routing checkpoint */ }
  }
  for (let index = 0; index < context.nodes.length; index += 1) {
    const node = context.nodes[index];
    if (state.startNodeId && index < resumeIndex) {
      if (completedNodes.includes(node.id)) {
        const priorArtifacts = await readAcceptedArtifacts(request.projectRoot, runId, node, storage);
        acceptedOutputs.set(node.id, new Map(priorArtifacts.map((artifact) => [artifact.name, artifact])));
      }
      continue;
    }
    if (completedNodes.includes(node.id)) {
      const priorArtifacts = await readAcceptedArtifacts(request.projectRoot, runId, node, storage);
      acceptedOutputs.set(node.id, new Map(priorArtifacts.map((artifact) => [artifact.name, artifact])));
      continue;
    }
    const profile = context.providerProfiles[node.providerProfile];
    if (route && node.id === route.startNode && routingState.iteration === 1) routingState.reusedPrefix = context.nodes.slice(0, index).map(({ id }) => id);
    const mapped = resolveMappedInputs(node, inputs.request, callerInputs, context.nodes.slice(0, index), acceptedOutputs, contracts);
    if (!mapped.valid) {
      return finishError(request.projectRoot, runId, storage, mapped.code, mapped.message, undefined, undefined, completedNodes, node.id);
    }
    const nodeInstructions = inputs.instructions.filter((item) =>
      node.instructions.some((instruction) => path.resolve(request.projectRoot, instruction) === path.resolve(item.path)),
    );
    if (route && node.id === route.decisionNode) mapped.values.artifactReferences = feedbackArtifactReferences(runId, route, context.nodes, acceptedOutputs, routingState.iteration, routingState);
    if (route && feedback && node.id === route.routes[(feedback.decisionCode as string)] ) mapped.values.feedback = feedback;
    const nodeAnswers = state.startNodeId === node.id ? state.answers ?? {} : {};
    const prompt = buildPrompt(context, node, nodeInstructions, mapped.values, nodeAnswers);
    let attempt = state.startNodeId === node.id ? state.attempt ?? 2 : (attempts.get(node.id) ?? 0) + 1;
    attempts.set(node.id, attempt);
    let activeCall: ProviderCallContext = { callId: randomUUID(), attempt, operation: "invoke" };
    const invocation: ProviderInvocation = {
      call: activeCall,
      providerProfileId: node.providerProfile,
      runId,
      attempt,
      workflow: context.workflow.id,
      nodeId: node.id,
      prompt,
      inputs: mapped.values,
      providerProfile: profile,
      ...(Object.keys(nodeAnswers).length ? { answers: nodeAnswers } : {}),
    };
    let attemptRoot = `nodes/${node.id}/attempt-${String(attempt).padStart(3, "0")}`;
    const startedAt = new Date().toISOString();
    const invocationRecord = {
      callId: activeCall.callId,
      operation: activeCall.operation,
      runId,
      workflow: context.workflow.id,
      nodeId: node.id,
      attempt,
      startedAt,
      providerProfile: node.providerProfile,
      resolvedProviderProfile: profile,
      inputs: mapped.values,
      inputMappings: node.inputs,
      expectedOutputs: node.expectedOutputs,
      validator: node.expectedOutputs.find((output) => output.validator)?.validator,
    };

    await storage.writeRunFiles(request.projectRoot, runId, {
      "run.json": json({ schemaVersion: 1, engineVersion: "1.0.0", runId, phase: "execution", status: "running", activeNode: node.id, completedNodes, attempt, answers: nodeAnswers, pendingKind: null, ...(route ? { feedbackRouting: { regions: { [route.regionId]: routingState } } } : {}) }),
      [`${attemptRoot}/invocation.json`]: json(invocationRecord),
      [`${attemptRoot}/prompt.md`]: prompt,
      [`${attemptRoot}/stderr.log`]: "",
    });
    await appendEvent(request.projectRoot, runId, storage, { event: "node.started", runId, nodeId: node.id, attempt });

    let raw: string;
    const callStartedAt = performance.now();
    try {
      if (route && (providerCalls >= route.limits.maxProviderCalls || elapsedBeforeSegment + performance.now() - routingSegmentStartedAt > route.limits.maxElapsedMs)) return finishError(request.projectRoot, runId, storage, "FEEDBACK_LIMIT_EXCEEDED", "Feedback routing provider-call or elapsed-time limit was reached.", undefined, undefined, completedNodes, node.id);
      providerCalls += 1;
      if (route) { routingState.providerCalls = providerCalls; await persistRoutingElapsed(); }
      raw = await traceProviderCall(request.projectRoot, runId, storage, { nodeId: node.id, ...activeCall }, async () => {
        const response = await provider.invoke(invocation);
        if (typeof response !== "string") throw new Error("Provider returned a non-string response.");
        return response;
      });
    } catch (error) {
      await persistRoutingElapsed();
      await recordProviderMetric(request.projectRoot, runId, storage, provider, node.id, attempt, performance.now() - callStartedAt, activeCall);
      const diagnostic = { code: "PROVIDER_FAILURE", message: messageOf(error) };
      const validation = { valid: false, code: diagnostic.code, errors: [diagnostic.message] };
      await storage.writeRunFiles(request.projectRoot, runId, {
        [`${attemptRoot}/response.raw.txt`]: "",
        [`${attemptRoot}/stderr.log`]: diagnostic.message,
        [`${attemptRoot}/validation.json`]: json(validation),
      });
      await appendEvent(request.projectRoot, runId, storage, { event: "node.failed", runId, nodeId: node.id, code: diagnostic.code });
      return finishError(request.projectRoot, runId, storage, diagnostic.code, diagnostic.message, attemptRoot, validation, completedNodes, node.id);
    }

    await persistRoutingElapsed();
    await recordProviderMetric(request.projectRoot, runId, storage, provider, node.id, attempt, performance.now() - callStartedAt, activeCall);
    await storage.writeRunFiles(request.projectRoot, runId, { [`${attemptRoot}/response.raw.txt`]: raw });
    let parsed = parseProviderOutcome(raw);
    let repairCount = 0;
    let currentAttempt = attempt;
    let currentAttemptRoot = attemptRoot;
    let outputCheck: ReturnType<typeof validateOutputSet> | undefined;
    const responseIssue = (): { code: string; errors: string[] } | undefined => {
      if (!parsed.valid) return { code: parsed.code, errors: parsed.errors };
      if (parsed.outcome.status !== "success") return undefined;
      outputCheck = validateOutputSet(parsed.outcome.artifacts, node.expectedOutputs, contracts);
      return outputCheck.valid ? undefined : { code: outputCheck.code, errors: outputCheck.errors };
    };
    const requestCorrection = async (code: string, errors: string[]): Promise<RunResponse | undefined> => {
      const validation = { valid: false, code, errors };
      await storage.writeRunFiles(request.projectRoot, runId, { [`${currentAttemptRoot}/validation.json`]: json(validation) });
      const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : [];
      const repair = provider.repairResponse?.bind(provider);
      if (!capabilities.includes("responseRepair") || !repair) {
        const message = "Safe response-only repair is unavailable; the full provider action will not be replayed.";
        return finishError(request.projectRoot, runId, storage, "RESPONSE_REPAIR_UNAVAILABLE", message, currentAttemptRoot, validation, completedNodes, node.id);
      }
      if (repairCount >= 2) {
        const message = "The provider response remained invalid after two response-only repairs.";
        return finishError(request.projectRoot, runId, storage, "REPAIR_EXHAUSTED", message, currentAttemptRoot, validation, completedNodes, node.id);
      }
      if (route && (providerCalls >= route.limits.maxProviderCalls || elapsedBeforeSegment + performance.now() - routingSegmentStartedAt > route.limits.maxElapsedMs)) {
        await persistRoutingElapsed();
        return finishError(request.projectRoot, runId, storage, "FEEDBACK_LIMIT_EXCEEDED", "Feedback routing provider-call or elapsed-time limit was reached before response repair.", currentAttemptRoot, validation, completedNodes, node.id);
      }
      await recordValidationEvent(request.projectRoot, runId, storage, currentAttemptRoot);
      repairCount += 1;
      currentAttempt += 1;
      activeCall = { callId: randomUUID(), attempt: currentAttempt, operation: "repair_response", parentCallId: activeCall.callId };
      currentAttemptRoot = `nodes/${node.id}/attempt-${String(currentAttempt).padStart(3, "0")}`;
      attempts.set(node.id, currentAttempt);
      if (route) { providerCalls += 1; routingState.providerCalls = providerCalls; await persistRoutingElapsed(); }
      const repairRecord = {
        ...invocationRecord,
        callId: activeCall.callId,
        parentCallId: activeCall.parentCallId,
        attempt: currentAttempt,
        operation: "response_repair",
        previousAttempt: currentAttempt - 1,
        previousResponse: raw,
        validationErrors: errors,
        startedAt: new Date().toISOString(),
      };
      await storage.writeRunFiles(request.projectRoot, runId, {
        "run.json": json({ schemaVersion: 1, engineVersion: "1.0.0", runId, phase: "execution", status: "running", activeNode: node.id, completedNodes, attempt: currentAttempt, answers: nodeAnswers, pendingKind: null, ...(route ? { feedbackRouting: { regions: { [route.regionId]: routingState } } } : {}) }),
        [`${currentAttemptRoot}/invocation.json`]: json(repairRecord),
        [`${currentAttemptRoot}/prompt.md`]: prompt,
        [`${currentAttemptRoot}/response.raw.txt`]: "",
        [`${currentAttemptRoot}/stderr.log`]: "",
      });
      await appendEvent(request.projectRoot, runId, storage, { event: "node.repair.started", runId, nodeId: node.id, attempt: currentAttempt });
      await appendEvent(request.projectRoot, runId, storage, { event: "node.started", runId, nodeId: node.id, attempt: currentAttempt });
      const repairStartedAt = performance.now();
      try {
        const previousRaw = raw;
        raw = await traceProviderCall(request.projectRoot, runId, storage, { nodeId: node.id, ...activeCall }, async () => {
          const response = await repair({ ...invocation, call: activeCall }, previousRaw, errors);
          if (typeof response !== "string") throw new Error("Provider repair returned a non-string response.");
          return response;
        });
      } catch (error) {
        await persistRoutingElapsed();
        await recordProviderMetric(request.projectRoot, runId, storage, provider, node.id, currentAttempt, performance.now() - repairStartedAt, activeCall);
        const message = messageOf(error);
        const repairValidation = { valid: false, code: "RESPONSE_REPAIR_FAILED", errors: [message] };
        await storage.writeRunFiles(request.projectRoot, runId, {
          [`${currentAttemptRoot}/response.raw.txt`]: "",
          [`${currentAttemptRoot}/stderr.log`]: message,
          [`${currentAttemptRoot}/validation.json`]: json(repairValidation),
        });
        return finishError(request.projectRoot, runId, storage, "RESPONSE_REPAIR_FAILED", message, currentAttemptRoot, repairValidation, completedNodes, node.id);
      }
      await persistRoutingElapsed();
      await recordProviderMetric(request.projectRoot, runId, storage, provider, node.id, currentAttempt, performance.now() - repairStartedAt, activeCall);
      await storage.writeRunFiles(request.projectRoot, runId, { [`${currentAttemptRoot}/response.raw.txt`]: raw });
      parsed = parseProviderOutcome(raw);
      outputCheck = undefined;
      await appendEvent(request.projectRoot, runId, storage, { event: "node.repaired", runId, nodeId: node.id, attempt: currentAttempt });
      return undefined;
    };

    let issue = responseIssue();
    while (issue) {
      const correctionFailure = await requestCorrection(issue.code, issue.errors);
      if (correctionFailure) return correctionFailure;
      issue = responseIssue();
    }
    if (!parsed.valid) {
      return finishError(request.projectRoot, runId, storage, parsed.code, parsed.errors.join("; "), currentAttemptRoot, undefined, completedNodes, node.id);
    }
    attempt = currentAttempt;
    attemptRoot = currentAttemptRoot;

    if (parsed.outcome.status === "error") {
      const validation = { valid: true, outcome: "error", errors: [] };
      const result = { runId, status: "error", error: parsed.outcome.error };
      await storage.writeRunFiles(request.projectRoot, runId, {
        [`${attemptRoot}/validation.json`]: json(validation),
        [`${attemptRoot}/result.json`]: json({ status: "error", error: parsed.outcome.error }),
        "run.json": json({ schemaVersion: 1, engineVersion: "1.0.0", runId, phase: "execution", status: "error", activeNode: node.id, completedNodes, attempt, ...(route ? { feedbackRouting: { regions: { [route.regionId]: routingState } } } : {}) }),
        "result.json": json(result),
      });
      await recordValidationEvent(request.projectRoot, runId, storage, attemptRoot);
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
        return finishError(request.projectRoot, runId, storage, "INVALID_ANSWER_CONTRACT", messageOf(error), attemptRoot, validation, completedNodes, node.id);
      }
      const validation = { valid: true, outcome: "needs_input", errors: [] };
      if (route) await persistRoutingElapsed();
      await storage.writeRunFiles(request.projectRoot, runId, {
        [`${attemptRoot}/validation.json`]: json(validation),
        [`${attemptRoot}/result.json`]: json({ status: "needs_input", request: pending }),
        "pending/request.json": json(pending),
        "run.json": json({
          schemaVersion: 1,
          engineVersion: "1.0.0",
          runId,
          phase: "execution",
          status: "needs_input",
          activeNode: node.id,
          completedNodes,
          attempt,
          requestId,
          pendingKind: "node",
          pendingNodeId: node.id,
          answers: nodeAnswers,
          ...(route ? { feedbackRouting: { regions: { [route.regionId]: routingState } } } : {}),
        }),
      });
      await recordValidationEvent(request.projectRoot, runId, storage, attemptRoot);
      await appendEvent(request.projectRoot, runId, storage, { event: "node.needs_input", runId, nodeId: node.id, requestId });
      return { runId, status: "needs_input", result: { request: pending } };
    }

    const finalOutputCheck = outputCheck ?? validateOutputSet(parsed.outcome.artifacts, node.expectedOutputs, contracts);
    if (!finalOutputCheck.valid) {
      const validation = { valid: false, code: finalOutputCheck.code, errors: finalOutputCheck.errors };
      await storage.writeRunFiles(request.projectRoot, runId, { [`${attemptRoot}/validation.json`]: json(validation) });
      await appendEvent(request.projectRoot, runId, storage, { event: "node.rejected", runId, nodeId: node.id, code: finalOutputCheck.code });
      return finishError(request.projectRoot, runId, storage, finalOutputCheck.code, finalOutputCheck.errors.join("; "), attemptRoot, validation, completedNodes, node.id);
    }

    const validatorResults: unknown[] = [];
    while (true) {
      validatorResults.length = 0;
      let semanticRejection: { errors: string[]; stderr: string } | undefined;
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
        return finishError(request.projectRoot, runId, storage, validation.code, validation.errors.join("; "), attemptRoot, validation, completedNodes, node.id);
      }
      if (processResult.timedOut) {
        const validation = { valid: false, code: "VALIDATOR_TIMEOUT", errors: [`Validator '${expected.validator}' exceeded its timeout.`] };
        await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, processResult.stderr);
        return finishError(request.projectRoot, runId, storage, validation.code, validation.errors.join("; "), attemptRoot, validation, completedNodes, node.id);
      }
      if (processResult.outputLimitExceeded || processResult.exitCode !== 0) {
        const validation = { valid: false, code: "VALIDATOR_EXECUTION_FAILED", errors: [processResult.stderr || "Validator exited unsuccessfully or exceeded output limit."] };
        await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, processResult.stderr);
        return finishError(request.projectRoot, runId, storage, validation.code, validation.errors.join("; "), attemptRoot, validation, completedNodes, node.id);
      }
      let verdict: unknown;
      try {
        verdict = JSON.parse(processResult.stdout) as unknown;
      } catch {
        const validation = { valid: false, code: "VALIDATOR_INVALID_RESPONSE", errors: ["Validator stdout must be a JSON verdict."] };
        await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, processResult.stderr);
        return finishError(request.projectRoot, runId, storage, validation.code, validation.errors.join("; "), attemptRoot, validation, completedNodes, node.id);
      }
      const checkedVerdict = validateValidatorVerdict(verdict);
      if (!checkedVerdict.valid) {
        const validation = { valid: false, code: "VALIDATOR_INVALID_RESPONSE", errors: checkedVerdict.errors };
        await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, processResult.stderr);
        return finishError(request.projectRoot, runId, storage, validation.code, validation.errors.join("; "), attemptRoot, validation, completedNodes, node.id);
      }
      validatorResults.push({ name: artifact.name, valid: checkedVerdict.validity, errors: checkedVerdict.errors });
      if (!checkedVerdict.validity) {
        semanticRejection = { errors: checkedVerdict.errors, stderr: processResult.stderr };
        break;
      }
      }
      if (!semanticRejection) break;
      const validation = { valid: false, code: "ARTIFACT_REJECTED", errors: semanticRejection.errors };
      await storeValidation(request.projectRoot, runId, storage, attemptRoot, validation, semanticRejection.stderr);
      const correctionFailure = await requestCorrection(validation.code, validation.errors);
      if (correctionFailure) return correctionFailure;
      let repairedIssue = responseIssue();
      while (repairedIssue) {
        const repairFailure = await requestCorrection(repairedIssue.code, repairedIssue.errors);
        if (repairFailure) return repairFailure;
        repairedIssue = responseIssue();
      }
      const repairedParse: ReturnType<typeof parseProviderOutcome> = parsed;
      if (!repairedParse.valid || repairedParse.outcome.status !== "success") {
        const errors = (repairedParse as { errors?: string[] }).errors ?? ["A response repair must return a success artifact outcome."];
        return finishError(request.projectRoot, runId, storage, "INVALID_REPAIRED_OUTCOME", errors.join("; "), currentAttemptRoot, { valid: false, code: "INVALID_REPAIRED_OUTCOME", errors }, completedNodes, node.id);
      }
      attempt = currentAttempt;
      attemptRoot = currentAttemptRoot;
    }

    const validation = { valid: true, outcome: "success", validators: validatorResults, errors: [] };
    const persisted: RunFiles = {
      [`${attemptRoot}/validation.json`]: json(validation),
      [`${attemptRoot}/result.json`]: json({ status: "success", artifacts: parsed.outcome.artifacts }),
    };
    for (const artifact of parsed.outcome.artifacts) {
      persisted[`nodes/${node.id}/artifacts/${artifact.name}.json`] = json(artifact);
    }
    if (route && context.nodes.findIndex(({ id }) => id === node.id) >= context.nodes.findIndex(({ id }) => id === route.startNode) && context.nodes.findIndex(({ id }) => id === node.id) < context.nodes.findIndex(({ id }) => id === route.decisionNode)) {
      for (const artifact of parsed.outcome.artifacts) routingState.generationHistory.push({ runId, nodeId: node.id, outputName: artifact.name, contract: artifact.contract, generationId: randomUUID(), sha256: createHash("sha256").update(JSON.stringify(artifact.data)).digest("hex"), iteration: routingState.iteration, attemptPath: `${attemptRoot}/result.json`, status: "accepted" });
    }
    await storage.writeRunFiles(request.projectRoot, runId, persisted);
    await recordValidationEvent(request.projectRoot, runId, storage, attemptRoot);
    acceptedOutputs.set(node.id, new Map(parsed.outcome.artifacts.map((artifact) => [artifact.name, artifact])));
    completedNodes.push(node.id);

    if (route && node.id === route.decisionNode) {
      const decisionArtifact = parsed.outcome.artifacts.find(({ name }) => name === route.decisionOutput.name);
      const decision = decisionArtifact?.data as { decisionCode?: unknown; reason?: unknown; findings?: unknown } | undefined;
      const code = typeof decision?.decisionCode === "string" ? decision.decisionCode : "";
      const target = route.routes[code];
      if (!target) return finishError(request.projectRoot, runId, storage, "FEEDBACK_DECISION_INVALID", `Feedback decision code '${code}' has no declared route.`, attemptRoot, { valid: false, code: "FEEDBACK_DECISION_INVALID", errors: [`Unknown decision code '${code}'.`] }, completedNodes, node.id);
      if (target !== route.continuationNode) {
        if (routingState.iteration >= route.limits.maxIterations) return finishError(request.projectRoot, runId, storage, "FEEDBACK_LIMIT_EXCEEDED", "Feedback routing iteration limit was reached.", attemptRoot, { valid: false, code: "FEEDBACK_LIMIT_EXCEEDED", errors: ["Feedback routing iteration limit was reached."] }, completedNodes, node.id);
        const targetIndex = context.nodes.findIndex(({ id }) => id === target);
        routingState.reusedPrefix = context.nodes.slice(0, targetIndex).map(({ id }) => id);
        const suffix = context.nodes.slice(targetIndex, context.nodes.findIndex(({ id }) => id === route.decisionNode) + 1).map(({ id }) => id);
        for (const generation of routingState.generationHistory) if (suffix.includes(String(generation.nodeId)) && generation.iteration === routingState.iteration) generation.status = "invalidated";
        routingState.invalidatedSuffixes.push({ iteration: routingState.iteration + 1, target, nodeIds: suffix });
        routingState.eligibleNodes = suffix;
        routingState.iteration += 1;
        const revisionNodes = new Set(suffix.slice(0, -1));
        feedback = { originalRequest: inputs.request, decisionCode: code, reason: decision?.reason, findings: decision?.findings, resolvedArtifacts: feedbackArtifactReferences(runId, route, context.nodes, acceptedOutputs, routingState.iteration - 1, routingState).filter((reference) => revisionNodes.has(String(reference.nodeId))).map((reference) => ({ ...reference, data: acceptedOutputs.get(String(reference.nodeId))?.get(String(reference.outputName))?.data })) };
        routingState.feedback = feedback;
        for (const id of suffix) { acceptedOutputs.delete(id); const at = completedNodes.lastIndexOf(id); if (at >= 0) completedNodes.splice(at, 1); }
        index = targetIndex - 1;
        await persistRoutingElapsed();
        await storage.writeRunFiles(request.projectRoot, runId, { "run.json": json({ schemaVersion: 1, engineVersion: "1.0.0", runId, phase: "execution", status: "running", activeNode: target, completedNodes, attempt, feedbackRouting: { regions: { [route.regionId]: routingState } } }) });
        continue;
      }
      routingState.eligibleNodes = [];
    }

    if (index < context.nodes.length - 1) {
      const nextNode = context.nodes[index + 1];
      await storage.writeRunFiles(request.projectRoot, runId, {
        "run.json": json({ schemaVersion: 1, engineVersion: "1.0.0", runId, phase: "execution", status: "running", activeNode: nextNode.id, completedNodes, attempt: 1, ...(route ? { feedbackRouting: { regions: { [route.regionId]: routingState } } } : {}) }),
      });
      await appendEvent(request.projectRoot, runId, storage, { event: "node.succeeded", runId, nodeId: node.id, artifactNames: parsed.outcome.artifacts.map((artifact) => artifact.name) });
      continue;
    }

    const result = { runId, status: "success", artifacts: parsed.outcome.artifacts };
      if (route) await persistRoutingElapsed();
      await storage.writeRunFiles(request.projectRoot, runId, {
        "run.json": json({ schemaVersion: 1, engineVersion: "1.0.0", runId, phase: "execution", status: "success", activeNode: null, completedNodes, attempt: 1, ...(route ? { feedbackRouting: { regions: { [route.regionId]: routingState } } } : {}) }),
      });
    await storage.writeRunFiles(request.projectRoot, runId, { "result.json": json(result) });
    await appendEvent(request.projectRoot, runId, storage, { event: "node.succeeded", runId, nodeId: node.id, artifactNames: parsed.outcome.artifacts.map((artifact) => artifact.name) });
    return { runId, status: "success", result: { artifacts: parsed.outcome.artifacts } };
  }

  return finishError(request.projectRoot, runId, storage, "WORKFLOW_EMPTY", "Workflow has no executable nodes.", undefined, undefined, completedNodes);
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

function resolveMappedInputs(
  node: Node,
  requestText: string,
  callerInputs: Record<string, unknown>,
  earlierNodes: Node[],
  acceptedOutputs: Map<string, Map<string, OutputArtifact>>,
  schemas: Record<string, unknown>,
): MappedInputsResult {
  const values: Record<string, unknown> = {};
  for (const [inputName, candidate] of Object.entries(node.inputs)) {
    if (!isRecord(candidate) || typeof candidate.from !== "string") {
      return { valid: false, code: "INPUT_MAPPING_INVALID", message: `Input '${inputName}' has an invalid mapping.` };
    }
    const contract = typeof candidate.contract === "string"
      ? candidate.contract
      : candidate.from === "request" ? "request.v1" : undefined;
    if (!contract || !Object.hasOwn(schemas, contract)) {
      return { valid: false, code: "INPUT_CONTRACT_INVALID", message: `Input '${inputName}' references an unavailable contract.` };
    }
    let value: unknown;
    if (candidate.from === "request") {
      value = requestText;
    } else if (candidate.from.startsWith("caller.")) {
      const callerName = candidate.from.slice("caller.".length);
      if (!Object.hasOwn(callerInputs, callerName)) {
        return { valid: false, code: "CALLER_INPUT_MISSING", message: `Required caller input '${callerName}' is missing.` };
      }
      value = callerInputs[callerName];
    } else {
      const source = resolveOutputReference(candidate.from, earlierNodes.map((priorNode) => ({
        nodeId: priorNode.id,
        outputs: priorNode.expectedOutputs,
      })));
      if (source.status === "ambiguous") {
        return { valid: false, code: "MAPPED_INPUT_AMBIGUOUS", message: `Input '${inputName}' source '${candidate.from}' is ambiguous.` };
      }
      const artifact = source.status === "resolved"
        ? acceptedOutputs.get(source.nodeId)?.get(source.outputName)
        : undefined;
      if (!artifact) {
        return { valid: false, code: "MAPPED_INPUT_MISSING", message: `Input '${inputName}' source '${candidate.from}' is not an accepted output.` };
      }
      if (artifact.contract !== contract) {
        return { valid: false, code: "INPUT_CONTRACT_MISMATCH", message: `Input '${inputName}' contract does not match source '${candidate.from}'.` };
      }
      value = artifact.data;
    }

    try {
      const validate = new Ajv2020({ strict: false }).compile(schemas[contract] as AnySchema);
      if (!validate(value)) {
        return {
          valid: false,
          code: "MAPPED_INPUT_INVALID",
          message: `Input '${inputName}' does not satisfy ${contract}: ${ajv.errorsText(validate.errors)}.`,
        };
      }
    } catch (error) {
      return { valid: false, code: "INPUT_CONTRACT_INVALID", message: `Input '${inputName}' could not be checked: ${messageOf(error)}` };
    }
    values[inputName] = value;
  }
  return { valid: true, values };
}

function buildPrompt(
  context: DefinitionContext,
  node: Node,
  instructions: Array<{ path: string; content: string }>,
  mappedInputs: Record<string, unknown>,
  answers: Record<string, unknown>,
): string {
  const nodeSchemas = Object.fromEntries(node.expectedOutputs.map((output) => [output.contract, context.contracts[output.contract]]));
  const instructionText = instructions.map((item) => `## ${item.path}\n${item.content}`).join("\n\n");
  return [
    `Workflow: ${context.workflow.id}`,
    `Node: ${node.id}`,
    "## Instructions",
    instructionText,
    "## Mapped Inputs",
    JSON.stringify(mappedInputs, null, 2),
    ...(Object.keys(answers).length ? ["## Answers to clarification questions", JSON.stringify(answers, null, 2)] : []),
    "## Required output contracts",
    JSON.stringify(nodeSchemas, null, 2),
    "## Expected output names and contracts",
    JSON.stringify(node.expectedOutputs.map(({ name, contract }) => ({ name, contract })), null, 2),
    "## System outcome schemas",
    JSON.stringify({ success: successSchema, needsInput: needsInputSchema, error: errorSchema }, null, 2),
    "Return one JSON object matching the package outcome protocol. Do not include runtime metadata. Return only the raw JSON outcome. Do not wrap it in Markdown fences or add explanatory text.",
  ].join("\n\n");
}

async function finishError(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage,
  code: string,
  message: string,
  attemptRoot?: string,
  validation?: unknown,
  completedNodes: string[] = [],
  activeNode: string | null = null,
): Promise<RunResponse> {
  const result = { runId, status: "error", error: { code, message } };
  let previousCheckpoint: Record<string, unknown> = {};
  try { previousCheckpoint = JSON.parse(await storage.readRunFile(projectRoot, runId, "run.json")) as Record<string, unknown>; } catch { /* error checkpoint can initialize damaged or new run state */ }
  const files: RunFiles = {
    "run.json": json({ ...previousCheckpoint, schemaVersion: 1, runId, phase: "execution", status: "error", activeNode, completedNodes, error: { code, message } }),
    "result.json": json(result),
  };
  if (attemptRoot) files[`${attemptRoot}/result.json`] = json({ status: "error", error: { code, message } });
  if (attemptRoot && validation !== undefined) files[`${attemptRoot}/validation.json`] = json(validation);
  await storage.writeRunFiles(projectRoot, runId, files);
  if (attemptRoot && validation !== undefined) await recordValidationEvent(projectRoot, runId, storage, attemptRoot);
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

async function appendEvent(projectRoot: string, runId: string, storage: IntakeStorage, event: Record<string, unknown>): Promise<void> {
  await appendRunEvent(projectRoot, runId, storage, event);
}

async function recordProviderMetric(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage,
  provider: ProviderPort,
  nodeId: string,
  attempt: number,
  elapsedMs: number,
  call: ProviderCallContext,
): Promise<void> {
  let calls: ProviderCallMetric[] = [];
  try {
    calls = JSON.parse(await storage.readRunFile(projectRoot, runId, "metrics.json")) as ProviderCallMetric[];
    if (!Array.isArray(calls)) calls = [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let usage: ProviderUsage | null = null;
  let telemetry: ProviderTelemetry | null = null;
  try {
    telemetry = provider.telemetryForCall?.(call.callId) ?? null;
    const reported = provider.telemetryForCall ? telemetry ? {
      inputTokens: telemetry.normalized.inputTokens,
      outputTokens: telemetry.normalized.outputTokens,
      cacheReadTokens: telemetry.coverage === "complete" ? telemetry.reported.cacheReadTokens : null,
      costUsd: telemetry.coverage === "complete" ? telemetry.reported.costUsd : null,
    } : null : provider.usageForLastCall?.();
    if (reported && typeof reported === "object") {
      usage = {
        inputTokens: finiteOrNull(reported.inputTokens),
        outputTokens: finiteOrNull(reported.outputTokens),
        cacheReadTokens: finiteOrNull(reported.cacheReadTokens),
        costUsd: finiteOrNull(reported.costUsd),
      };
    }
    if (telemetry && usage && Object.values(usage).every(value => value === null)) usage = null;
  } catch { usage = null; }
  let launched: boolean | null = null;
  try { const value = provider.launchForCall?.(call.callId); if (typeof value === 'boolean') launched = value; } catch { /* optional evidence cannot invalidate the artifact */ }
  calls.push({ nodeId, attempt, usage, elapsedMs: Math.max(0, elapsedMs), callId: call.callId, operation: call.operation, launched, ...(telemetry ? { telemetry } : {}) });
  await storage.writeRunFiles(projectRoot, runId, { "metrics.json": json(calls) });
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function missingCallerInputs(
  declared: Record<string, { contract: string }>,
  values: Record<string, unknown>,
  contracts: Record<string, unknown>,
): Array<{ name: string; contract: string }> {
  const missing: Array<{ name: string; contract: string }> = [];
  for (const [name, declaration] of Object.entries(declared)) {
    const schema = contracts[declaration.contract];
    let valid = Object.hasOwn(values, name) && schema !== undefined;
    if (valid) {
      try {
        valid = Boolean(new Ajv2020({ strict: false }).compile(schema as AnySchema)(values[name]));
      } catch {
        valid = false;
      }
    }
    if (!valid) missing.push({ name, contract: declaration.contract });
  }
  return missing;
}

function callerAnswerContract(
  missing: Array<{ name: string; contract: string }>,
  contracts: Record<string, unknown>,
): unknown {
  return {
    type: "object",
    required: missing.map(({ name }) => name),
    properties: Object.fromEntries(missing.map(({ name, contract }) => [name, { $ref: `#/$defs/${contract}` }])),
    additionalProperties: false,
    $defs: contracts,
  };
}

async function readAcceptedArtifacts(
  projectRoot: string,
  runId: string,
  node: Node,
  storage: IntakeStorage,
): Promise<OutputArtifact[]> {
  const artifacts: OutputArtifact[] = [];
  for (const output of node.expectedOutputs) {
    const contents = await storage.readRunFile(projectRoot, runId, `nodes/${node.id}/artifacts/${output.name}.json`);
    artifacts.push(JSON.parse(contents) as OutputArtifact);
  }
  return artifacts;
}

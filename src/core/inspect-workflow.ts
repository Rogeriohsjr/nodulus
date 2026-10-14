import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import path from "node:path";
import { parseProjectSettings } from "./project-settings.js";
import { nodeDefinitionSchema, validateProvider, workflowDefinitionSchema } from "./intake-request.js";
import { NodulusError } from "./shared/nodulus-error.js";
import { inputMappingError, type OutputDeclaration } from "./workflow-mapping.js";
import { validateFeedbackRouting, validateFeedbackRuntimeInputs } from "./feedback-definition.js";

export interface WorkflowInspectionFiles {
  readUtf8(absolutePath: string): Promise<string>;
}

type JsonObject = Record<string, unknown>;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Resolve a workflow's declared structure and safe policies without executing it. */
export async function inspectWorkflowDefinition(
  projectRoot: string,
  workflowId: string,
  files: WorkflowInspectionFiles,
): Promise<Record<string, unknown>> {
  const root = path.resolve(projectRoot);
  if (!idPattern.test(workflowId)) throw new NodulusError("CONFIGURATION_INVALID", `Workflow ID '${workflowId}' is invalid.`);
  const workflowPath = path.join(root, ".nodulus", "workflows", `${workflowId}.json`);
  const settingsPath = path.join(root, ".nodulus", "settings.json");
  const settings = parseSettings(await readText(files, settingsPath, "project settings"));
  const workflow = object(await readJson(files, workflowPath, `Workflow '${workflowId}'`), `Workflow '${workflowId}'`);
  validateDefinition(workflowDefinitionSchema, workflow, `Workflow '${workflowId}'`);
  if (workflow.schemaVersion !== 1 || workflow.id !== workflowId || !Array.isArray(workflow.nodes) ||
      workflow.nodes.length === 0 || workflow.nodes.some((id) => typeof id !== "string" || !idPattern.test(id)) ||
      new Set(workflow.nodes).size !== workflow.nodes.length) {
    throw new NodulusError("CONFIGURATION_INVALID", `Workflow '${workflowId}' has an invalid schema, ID, or node list.`);
  }

  const contracts: Record<string, { sourcePath: string | null; schema: unknown }> = {
    "request.v1": { sourcePath: null, schema: { type: "string", minLength: 1 } },
  };
  const callerInputs: Record<string, { contract: string }> = {};
  if (workflow.inputs !== undefined) {
    const declarations = object(workflow.inputs, `Workflow '${workflowId}' inputs`);
    for (const [name, value] of Object.entries(declarations)) {
      const declaration = object(value, `Workflow input '${name}'`);
      if (!idPattern.test(name) || typeof declaration.contract !== "string" || !idPattern.test(declaration.contract)) {
        throw new NodulusError("CONFIGURATION_INVALID", `Workflow '${workflowId}' has an invalid caller input declaration '${name}'.`);
      }
      callerInputs[name] = { contract: declaration.contract };
      await addContract(root, files, contracts, declaration.contract);
    }
  }
  const nodes: Array<Record<string, unknown>> = [];
  const priorOutputs: OutputDeclaration[] = [];
  for (const nodeId of workflow.nodes as string[]) {
    const sourcePath = path.join(root, ".nodulus", "nodes", `${nodeId}.json`);
    const definition = object(await readJson(files, sourcePath, `Node '${nodeId}'`), `Node '${nodeId}'`);
    validateDefinition(nodeDefinitionSchema, definition, `Node '${nodeId}'`);
    if (definition.schemaVersion !== 1 || definition.id !== nodeId || typeof definition.providerProfile !== "string" ||
        !Array.isArray(definition.instructions) || !definition.instructions.every((item) => typeof item === "string") ||
        !isRecord(definition.inputs) || !Array.isArray(definition.expectedOutputs) || definition.expectedOutputs.length === 0) {
      throw new NodulusError("CONFIGURATION_INVALID", `Node '${nodeId}' has an invalid definition.`);
    }
    const validatedProfile = validateProvider(settings, definition.providerProfile, nodeId);
    const profile = safeProfile(validatedProfile as JsonObject);
    const instructionPaths = (definition.instructions as string[]).map((relative) => resolveProjectPath(root, relative, `Instruction for node '${nodeId}'`));
    for (const instructionPath of instructionPaths) await readText(files, instructionPath, `Instruction '${path.relative(root, instructionPath)}'`);

    const expectedOutputs: Array<Record<string, unknown>> = [];
    for (const value of definition.expectedOutputs) {
      const output = object(value, `Output definition for node '${nodeId}'`);
      if (typeof output.name !== "string" || typeof output.contract !== "string") throw new NodulusError("CONFIGURATION_INVALID", `Node '${nodeId}' has an invalid output declaration.`);
      await addContract(root, files, contracts, output.contract);
      const validatorPath = typeof output.validator === "string" ? resolveProjectPath(root, output.validator, `Validator for '${nodeId}.${output.name}'`) : undefined;
      if (validatorPath) await readText(files, validatorPath, `Validator '${output.validator as string}'`);
      expectedOutputs.push({
        name: output.name,
        contract: output.contract,
        ...(typeof output.validator === "string" ? { validator: output.validator } : {}),
        ...(validatorPath ? { validatorPath } : {}),
        ...(typeof output.validatorTimeoutMs === "number" ? { validatorTimeoutMs: output.validatorTimeoutMs } : {}),
      });
    }
    for (const [inputName, mapping] of Object.entries(definition.inputs)) {
      const diagnostic = inputMappingError(nodeId, inputName, mapping, priorOutputs, callerInputs);
      if (diagnostic) throw new NodulusError("CONFIGURATION_INVALID", diagnostic);
      if (isRecord(mapping) && typeof mapping.contract === "string") await addContract(root, files, contracts, mapping.contract);
    }
    nodes.push({
      id: nodeId,
      sourcePath,
      instructionPaths,
      providerProfile: definition.providerProfile,
      effectiveProfile: profile,
      inputs: definition.inputs,
      expectedOutputs,
    });
    priorOutputs.push({
      nodeId,
      outputs: expectedOutputs.map((output) => ({ name: String(output.name), contract: String(output.contract) })),
    });
  }
  if (workflow.feedbackRouting !== undefined) {
    const feedbackRouting = validateFeedbackRouting(workflow.feedbackRouting, priorOutputs.map(({ nodeId, outputs }) => ({ id: nodeId, outputs })), contracts);
    validateFeedbackRuntimeInputs(feedbackRouting, nodes.map((node) => ({ id: String(node.id), inputs: node.inputs as Record<string, unknown> })));
  }
  return {
    workflow: { id: workflowId, sourcePath: workflowPath, nodes: workflow.nodes, ...(isRecord(workflow.inputs) ? { inputs: workflow.inputs } : {}), ...(workflow.feedbackRouting === undefined ? {} : { feedbackRouting: workflow.feedbackRouting }) },
    nodes,
    contracts,
  };
}

function validateDefinition(schema: unknown, value: unknown, description: string): void {
  const validate = new Ajv2020({ strict: false }).compile(schema as AnySchema);
  if (!validate(value)) {
    const details = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
    throw new NodulusError("CONFIGURATION_INVALID", `${description} is invalid: ${details || "schema mismatch"}.`);
  }
}

async function addContract(root: string, files: WorkflowInspectionFiles, contracts: Record<string, { sourcePath: string | null; schema: unknown }>, id: string): Promise<void> {
  if (Object.hasOwn(contracts, id)) return;
  if (!idPattern.test(id)) throw new NodulusError("CONFIGURATION_INVALID", `Contract ID '${id}' is invalid.`);
  const sourcePath = path.join(root, ".nodulus", "contracts", `${id}.schema.json`);
  const schema = await readJson(files, sourcePath, `Contract '${id}'`);
  try { new Ajv2020({ strict: false }).compile(schema as AnySchema); }
  catch (error) { throw new NodulusError("CONFIGURATION_INVALID", `Invalid contract '${id}': ${messageOf(error)}`); }
  contracts[id] = { sourcePath, schema };
}

function safeProfile(profile: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of ["enabled", "kind", "model", "timeout", "timeoutMs", "capabilities", "sandbox", "reasoningEffort"]) {
    const value = profile[key];
    if ((key === "enabled" && typeof value === "boolean") || (key === "kind" && ["codex", "cursor", "opencode"].includes(String(value))) ||
        (["model", "sandbox", "reasoningEffort"].includes(key) && typeof value === "string") ||
        (["timeout", "timeoutMs"].includes(key) && typeof value === "number") ||
        (key === "capabilities" && Array.isArray(value) && value.every((entry) => typeof entry === "string"))) result[key] = value;
  }
  if (profile.kind === "codex" && profile.sandbox === undefined) result.sandbox = "read-only";
  return result;
}

function resolveProjectPath(root: string, relative: string, description: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new NodulusError("CONFIGURATION_INVALID", `${description} path must stay relative to the project root.`);
  const resolved = path.resolve(root, relative);
  const inside = path.relative(root, resolved);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new NodulusError("CONFIGURATION_INVALID", `${description} path escapes the project root.`);
  return resolved;
}

async function readText(files: WorkflowInspectionFiles, file: string, description: string): Promise<string> {
  try { return await files.readUtf8(file); }
  catch (error) { throw new NodulusError("CONFIGURATION_INVALID", `${description} could not be read at '${file}': ${messageOf(error)}`); }
}

async function readJson(files: WorkflowInspectionFiles, file: string, description: string): Promise<unknown> {
  const text = await readText(files, file, description);
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new NodulusError("CONFIGURATION_INVALID", `${description} at '${file}' contains invalid JSON: ${messageOf(error)}`); }
}

function parseSettings(contents: string) {
  try { return parseProjectSettings(contents); }
  catch (error) { throw new NodulusError("CONFIGURATION_INVALID", `Invalid project settings: ${messageOf(error)}`); }
}
function object(value: unknown, description: string): JsonObject {
  if (!isRecord(value)) throw new NodulusError("CONFIGURATION_INVALID", `${description} must be an object.`);
  return value;
}
function isRecord(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

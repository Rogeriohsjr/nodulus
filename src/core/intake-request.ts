import { createHash, randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import path from "node:path";
import { parseProjectSettings, type ProjectSettings } from "./project-settings.js";
import type { IntakeStorage, RunFiles } from "./ports/intake-storage.js";
import { NodulusError } from "./shared/nodulus-error.js";

export type RequestSource =
  | { kind: "inline"; text: string }
  | { kind: "file"; path: string }
  | { kind: "stdin"; text: string };

export type IntakeRequest = {
  projectRoot: string;
  cwd: string;
  workflow: string;
  sources: RequestSource[];
  referencesFile?: string;
};

export type IntakeResult = { runId: string; runDirectory: string };

type WorkflowDefinition = { schemaVersion: 1; id: string; nodes: string[] };
type NodeDefinition = {
  schemaVersion: 1;
  id: string;
  providerProfile: string;
  instructions: string[];
  inputs: Record<string, unknown>;
  expectedOutputs: Array<{ name: string; contract: string }>;
};
type ResolvedReference = { path: string; mode: "snapshot" | "workspace"; sha256: string; content?: string };
type ResolvedProviderProfile = {
  enabled: boolean;
  executable: string;
  model?: string;
  timeout?: number;
  timeoutMs?: number;
  capabilities?: string[];
};

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const workflowSchema = {
  type: "object",
  required: ["schemaVersion", "id", "nodes"],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1 },
    nodes: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
  },
  additionalProperties: false,
};

const nodeSchema = {
  type: "object",
  required: ["schemaVersion", "id", "providerProfile", "instructions", "inputs", "expectedOutputs"],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1 },
    providerProfile: { type: "string", minLength: 1 },
    instructions: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    inputs: { type: "object" },
    expectedOutputs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "contract"],
        properties: {
          name: { type: "string", minLength: 1 },
          contract: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export async function createIntake(request: IntakeRequest, storage: IntakeStorage): Promise<IntakeResult> {
  const projectRoot = path.resolve(request.projectRoot);
  const cwd = path.resolve(request.cwd);
  if (!isSafeId(request.workflow)) configError(`Workflow ID '${request.workflow}' is invalid.`);
  const text = await normalizeRequest(request.sources, cwd, storage);
  const settings = await readSettings(projectRoot, storage);
  const workflow = await readWorkflow(projectRoot, request.workflow, storage);
  const nodes: NodeDefinition[] = [];
  const contracts: Record<string, unknown> = {};
  const providerProfiles: Record<string, ResolvedProviderProfile> = {};
  const instructions: Array<{ path: string; content: string }> = [];
  const declaredOutputs = new Map<string, Set<string>>();

  for (let index = 0; index < workflow.nodes.length; index += 1) {
    const nodeId = workflow.nodes[index];
    if (!isSafeId(nodeId)) configError(`Workflow '${workflow.id}' contains invalid node ID '${nodeId}'.`);
    const node = await readNode(projectRoot, nodeId, storage);
    if (node.id !== nodeId) configError(`Node file for '${nodeId}' declares a different ID.`);
    const profile = validateProvider(settings, node.providerProfile, nodeId);
    providerProfiles[node.providerProfile] = safeProfileSnapshot(profile);
    validateMappings(node, workflow.nodes.slice(0, index), declaredOutputs);
    const outputNames = new Set<string>();
    for (const output of node.expectedOutputs) {
      if (!isSafeId(output.name) || outputNames.has(output.name)) {
        configError(`Node '${nodeId}' has an invalid or duplicate output name '${output.name}'.`);
      }
      outputNames.add(output.name);
      const contract = await readContract(projectRoot, output.contract, storage);
      contracts[output.contract] = contract;
    }
    declaredOutputs.set(nodeId, outputNames);
    nodes.push(node);

    for (const relativeInstructionPath of node.instructions) {
      const absolute = resolveProjectFile(projectRoot, relativeInstructionPath, `Instruction for node '${nodeId}'`);
      const contents = await readUtf8(storage, absolute, "CONFIGURATION_INVALID", `Could not read instruction '${relativeInstructionPath}'.`);
      instructions.push({ path: absolute, content: contents });
    }
  }

  const references = request.referencesFile
    ? await readReferences(request.referencesFile, cwd, projectRoot, storage)
    : [];
  const runId = randomUUID();
  const runFiles: RunFiles = {
    "request.md": text,
    "inputs.json": json({ schemaVersion: 1, workflow: workflow.id, request: text, instructions }),
    "references.json": json(references),
    "context/definitions.json": json({ schemaVersion: 1, workflow, nodes, contracts, providerProfiles }),
    "run.json": json({ schemaVersion: 1, runId, phase: "intake", workflow: workflow.id }),
    "events.jsonl": `${JSON.stringify({ event: "run.intake.completed", runId, workflow: workflow.id })}\n`,
  };

  let runDirectory: string;
  try {
    runDirectory = await storage.createRun(projectRoot, runId, runFiles);
  } catch (error) {
    throw new NodulusError("RUN_STORAGE_FAILED", `Could not persist the intake run: ${messageOf(error)}`);
  }
  return { runId, runDirectory };
}

async function normalizeRequest(sources: RequestSource[], cwd: string, storage: IntakeStorage): Promise<string> {
  if (!Array.isArray(sources) || sources.length !== 1) {
    throw new NodulusError("REQUEST_SOURCE_INVALID", "Provide exactly one request source: inline text, a request file, or stdin.");
  }
  const source = sources[0];
  if (!source || !["inline", "file", "stdin"].includes(source.kind)) {
    throw new NodulusError("REQUEST_SOURCE_INVALID", "The request source type is invalid.");
  }
  let requestText: string;
  if (source.kind === "file") {
    if (typeof source.path !== "string" || source.path.trim() === "") {
      throw new NodulusError("REQUEST_SOURCE_INVALID", "The request file path must be non-empty.");
    }
    const absolutePath = path.resolve(cwd, source.path);
    requestText = await readUtf8(storage, absolutePath, "REQUEST_SOURCE_INVALID", `Could not read request file '${source.path}'.`);
  } else {
    if (typeof source.text !== "string") {
      throw new NodulusError("REQUEST_SOURCE_INVALID", "The request text must be a string.");
    }
    requestText = source.text;
  }
  if (requestText.trim() === "") {
    throw new NodulusError("REQUEST_SOURCE_INVALID", "The request must contain non-whitespace text.");
  }
  return requestText;
}

async function readSettings(projectRoot: string, storage: IntakeStorage): Promise<ProjectSettings> {
  const text = await readUtf8(storage, path.join(projectRoot, ".nodulus", "settings.json"), "CONFIGURATION_INVALID", "Could not read project settings.");
  try {
    return parseProjectSettings(text);
  } catch (error) {
    configError(`Invalid project settings: ${messageOf(error)}`);
  }
}

async function readWorkflow(projectRoot: string, workflowId: string, storage: IntakeStorage): Promise<WorkflowDefinition> {
  const value = await readJson(storage, path.join(projectRoot, ".nodulus", "workflows", `${workflowId}.json`), `Workflow '${workflowId}'`);
  const valid = new Ajv2020({ strict: false }).compile(workflowSchema);
  if (!valid(value)) configError(`Invalid workflow '${workflowId}': ${formatAjvErrors(valid.errors)}.`);
  const workflow = value as WorkflowDefinition;
  if (workflow.id !== workflowId || !workflow.nodes.every(isSafeId) || new Set(workflow.nodes).size !== workflow.nodes.length) {
    configError(`Workflow '${workflowId}' must have a matching ID and unique safe node IDs.`);
  }
  return workflow;
}

async function readNode(projectRoot: string, nodeId: string, storage: IntakeStorage): Promise<NodeDefinition> {
  const value = await readJson(storage, path.join(projectRoot, ".nodulus", "nodes", `${nodeId}.json`), `Node '${nodeId}'`);
  const valid = new Ajv2020({ strict: false }).compile(nodeSchema);
  if (!valid(value)) configError(`Invalid node '${nodeId}': ${formatAjvErrors(valid.errors)}.`);
  return value as NodeDefinition;
}

async function readContract(projectRoot: string, contractId: string, storage: IntakeStorage): Promise<unknown> {
  if (!isSafeId(contractId)) configError(`Invalid contract ID '${contractId}'.`);
  const contractPath = path.join(projectRoot, ".nodulus", "contracts", `${contractId}.schema.json`);
  const schema = await readJson(storage, contractPath, `Contract '${contractId}'`);
  try {
    new Ajv2020({ strict: false }).compile(schema as AnySchema);
  } catch (error) {
    configError(`Invalid contract '${contractId}': ${messageOf(error)}`);
  }
  return schema;
}

function validateProvider(settings: ProjectSettings, profileName: string, nodeId: string): ProjectSettings["providerProfiles"][string] {
  const profile = settings.providerProfiles[profileName];
  if (!profile) configError(`Node '${nodeId}' references unknown provider profile '${profileName}'.`);
  if (!profile.enabled) configError(`Provider profile '${profileName}' used by node '${nodeId}' is disabled.`);
  return profile;
}

function safeProfileSnapshot(profile: ProjectSettings["providerProfiles"][string]): ResolvedProviderProfile {
  const snapshot: ResolvedProviderProfile = {
    enabled: profile.enabled,
    executable: profile.executable,
  };
  if (typeof profile.model === "string") snapshot.model = profile.model;
  if (typeof profile.timeout === "number") snapshot.timeout = profile.timeout;
  if (typeof profile.timeoutMs === "number") snapshot.timeoutMs = profile.timeoutMs;
  if (Array.isArray(profile.capabilities) && profile.capabilities.every((item) => typeof item === "string")) {
    snapshot.capabilities = profile.capabilities;
  }
  return snapshot;
}

function validateMappings(
  node: NodeDefinition,
  earlierNodeIds: string[],
  earlierOutputs: Map<string, Set<string>>,
): void {
  for (const [inputName, candidate] of Object.entries(node.inputs)) {
    if (!isRecord(candidate) || typeof candidate.from !== "string") {
      configError(`Node '${node.id}' input '${inputName}' must map from request or a prior node output.`);
    }
    if (candidate.from === "request") continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(candidate.from);
    const nodeOutputs = match ? earlierOutputs.get(match[1]) : undefined;
    if (!match || !earlierNodeIds.includes(match[1]) || !nodeOutputs?.has(match[2])) {
      configError(`Node '${node.id}' input '${inputName}' has an invalid source '${candidate.from}'.`);
    }
  }
}

async function readReferences(
  manifestArgument: string,
  cwd: string,
  projectRoot: string,
  storage: IntakeStorage,
): Promise<ResolvedReference[]> {
  if (manifestArgument.trim() === "") throw new NodulusError("REFERENCE_INVALID", "The references manifest path must be non-empty.");
  const manifestPath = path.resolve(cwd, manifestArgument);
  const manifest = await readJson(storage, manifestPath, "References manifest", "REFERENCE_INVALID");
  if (!isRecord(manifest) || !Array.isArray(manifest.references)) {
    throw new NodulusError("REFERENCE_INVALID", "References manifest must contain a references array.");
  }
  const result: ResolvedReference[] = [];
  for (const [index, candidate] of manifest.references.entries()) {
    if (!isRecord(candidate) || typeof candidate.path !== "string" || !["snapshot", "workspace"].includes(String(candidate.mode))) {
      throw new NodulusError("REFERENCE_INVALID", `Reference ${index + 1} must have a project-relative path and snapshot/workspace mode.`);
    }
    const absolutePath = resolveProjectFile(projectRoot, candidate.path, `Reference ${index + 1}`);
    let content: string;
    try {
      content = await storage.readUtf8(absolutePath);
    } catch (error) {
      throw new NodulusError("REFERENCE_INVALID", `Could not read reference '${candidate.path}': ${messageOf(error)}`);
    }
    const reference: ResolvedReference = {
      path: absolutePath,
      mode: candidate.mode as ResolvedReference["mode"],
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    };
    if (reference.mode === "snapshot") reference.content = content;
    result.push(reference);
  }
  return result;
}

async function readJson(storage: IntakeStorage, absolutePath: string, description: string, code = "CONFIGURATION_INVALID"): Promise<unknown> {
  const text = await readUtf8(storage, absolutePath, code, `${description} could not be read.`);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new NodulusError(code, `${description} contains invalid JSON: ${messageOf(error)}`);
  }
}

async function readUtf8(storage: IntakeStorage, absolutePath: string, code: string, description: string): Promise<string> {
  try {
    return await storage.readUtf8(absolutePath);
  } catch (error) {
    throw new NodulusError(code, `${description} ${messageOf(error)}`);
  }
}

function resolveProjectFile(projectRoot: string, relativePath: string, description: string): string {
  if (typeof relativePath !== "string" || relativePath.trim() === "" || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    configError(`${description} path must stay relative to the project root.`);
  }
  const absolute = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    configError(`${description} path escapes the project root.`);
  }
  return absolute;
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(message: string): never {
  throw new NodulusError("CONFIGURATION_INVALID", message);
}

function formatAjvErrors(errors: { instancePath?: string; message?: string }[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") || "schema mismatch";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

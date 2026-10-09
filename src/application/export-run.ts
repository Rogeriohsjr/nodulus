import { LocalIntakeStorage } from "../adapters/storage/local-intake-storage.js";
import type { IntakeStorage } from "../core/ports/intake-storage.js";
import { inspectRun } from "./inspect-run.js";

type RecordValue = Record<string, unknown>;
const safeDiagnosticCodes = new Set([
  "ARTIFACT_REJECTED", "ARTIFACT_VALIDATION_FAILED", "INVALID_NODE_OUTCOME", "INVALID_NODE_RESPONSE",
  "PROVIDER_FAILURE", "REPAIR_EXHAUSTED", "RESPONSE_REPAIR_FAILED", "RESPONSE_REPAIR_UNAVAILABLE",
  "VALIDATOR_EXECUTION_FAILED", "VALIDATOR_INVALID_RESPONSE", "VALIDATOR_TIMEOUT",
]);
const safeEventTypes = new Set([
  "node.started", "node.failed", "node.error", "node.needs_input", "node.rejected", "node.succeeded",
  "node.repair.started", "node.repaired", "node.validation.completed", "provider.call.started",
  "provider.call.completed", "run.intake.completed", "run.needs_input", "run.failed", "run.resumed",
]);
const safeOperations = new Set(["invoke", "repair_response", "response_repair"]);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(value: unknown, keys: readonly string[]): RecordValue {
  if (!isRecord(value)) return {};
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function safeReference(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return undefined;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

function safeDiagnosticCode(value: unknown): string {
  return typeof value === "string" && safeDiagnosticCodes.has(value) ? value : "REDACTED_DIAGNOSTIC_CODE";
}

function safeEventType(value: unknown): string {
  return typeof value === "string" && safeEventTypes.has(value) ? value : "REDACTED_EVENT_TYPE";
}

function safeOperation(value: unknown): string {
  return typeof value === "string" && safeOperations.has(value) ? value : "REDACTED_OPERATION";
}

function portableDefinitions(value: unknown): RecordValue | null {
  if (!isRecord(value)) return null;
  const workflow = pick(value.workflow, ["schemaVersion", "id", "nodes", "inputs"]);
  const nodes = Array.isArray(value.nodes) ? value.nodes.filter(isRecord).map((node) => ({
    ...pick(node, ["schemaVersion", "id"]),
    expectedOutputs: Array.isArray(node.expectedOutputs) ? node.expectedOutputs.filter(isRecord).map((output) => pick(output, ["name", "contract"])) : [],
  })) : [];
  const profileCount = isRecord(value.providerProfiles) ? Object.keys(value.providerProfiles).length : 0;
  const contracts = isRecord(value.contracts)
    ? Object.fromEntries(Object.entries(value.contracts).map(([id, schema]) => [id, safeContractSummary(schema)]))
    : {};
  return {
    schemaVersion: value.schemaVersion,
    engineVersion: value.engineVersion,
    workflow,
    nodes,
    contracts,
    providerProfileCount: profileCount,
  };
}

function safeContractSummary(value: unknown): RecordValue {
  if (!isRecord(value)) return { schemaType: "unknown" };
  const rawType = value.type;
  const allowedTypes = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
  const types = Array.isArray(rawType)
    ? rawType.filter((item): item is string => typeof item === "string" && allowedTypes.has(item))
    : typeof rawType === "string" && allowedTypes.has(rawType) ? rawType : undefined;
  return {
    ...(types === undefined ? { schemaType: "unspecified" } : { type: types }),
    ...(isRecord(value.properties) ? { propertyCount: Object.keys(value.properties).length } : {}),
    ...(Array.isArray(value.required) ? { requiredCount: value.required.filter((item) => typeof item === "string").length } : {}),
    ...(typeof value.additionalProperties === "boolean" ? { additionalProperties: value.additionalProperties } : {}),
    ...(isRecord(value.items) ? { hasItemSchema: true } : {}),
  };
}

/** Create a deterministic, redacted diagnostic envelope without writing to the source run. */
export async function exportRunDiagnostic(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage = new LocalIntakeStorage(),
): Promise<RecordValue> {
  const inspection = await inspectRun(projectRoot, runId, storage);
  const diagnostics: string[] = [];
  let definitions: RecordValue | null = null;
  try {
    definitions = portableDefinitions(JSON.parse(await storage.readRunFile(projectRoot, runId, "context/definitions.json")) as unknown);
    if (!definitions) diagnostics.push("Captured workflow definitions are malformed.");
  } catch {
    diagnostics.push("Captured workflow definitions are missing or unreadable.");
  }

  const timeline = Array.isArray(inspection.timeline) ? inspection.timeline.filter(isRecord).map((event) => {
    const safe = pick(event, ["sequence", "callId", "nodeId", "attempt", "failed", "elapsedMs", "valid", "outcome", "artifactNames"]);
    if (event.event !== undefined) safe.event = safeEventType(event.event);
    if (event.operation !== undefined) safe.operation = safeOperation(event.operation);
    if (event.code !== undefined) safe.code = safeDiagnosticCode(event.code);
    const validationRef = safeReference(event.validationRef) ?? (isRecord(event.refs) ? safeReference(event.refs.validationRef) : undefined);
    if (validationRef) safe.validationRef = validationRef;
    return safe;
  }) : [];
  const acceptance = Array.isArray(inspection.validation) ? inspection.validation.filter(isRecord).map((item) => ({
    ...pick(item, ["nodeId", "attempt", "valid"]),
    ...(item.code === undefined ? {} : { code: safeDiagnosticCode(item.code) }),
    ...(Array.isArray(item.errors) ? { errorCount: item.errors.length } : {}),
    ...(safeReference(item.reference) ? { reference: safeReference(item.reference) } : {}),
  })) : [];
  const artifacts = Array.isArray(inspection.artifacts) ? inspection.artifacts.filter(isRecord).map((item) => ({
    ...pick(item, ["nodeId", "name", "accepted"]),
    ...(safeReference(item.reference) ? { reference: safeReference(item.reference) } : {}),
  })) : [];
  const attempts = Array.isArray(inspection.attempts) ? inspection.attempts.filter(isRecord).map((item) => pick(item, ["nodeId", "attempt", "events", "callIds"])) : [];
  const checkpoint = isRecord(inspection.checkpoint) ? inspection.checkpoint : {};
  const feedbackRouting = isRecord(inspection.feedbackRouting) ? portableFeedbackRouting(inspection.feedbackRouting) : undefined;

  return {
    schemaVersion: 1,
    run: {
      ...pick(inspection, ["runId", "status"]),
      ...pick(checkpoint, ["phase", "engineVersion"]),
      ...(typeof inspection.workflowId === "string" ? { workflowId: inspection.workflowId } : isRecord(definitions?.workflow) && typeof definitions.workflow.id === "string" ? { workflowId: definitions.workflow.id } : {}),
    },
    definitions,
    timeline,
    attempts,
    artifacts,
    ...(feedbackRouting ? { feedbackRouting } : {}),
    acceptance,
    diagnostics,
    redactions: {
      enabled: true,
      omitted: ["caller inputs and request text", "node instructions and prompts", "provider responses and transcripts", "provider profile names, model identifiers, and capabilities", "credentials and executable paths", "absolute machine paths", "validation error text"],
    },
  };
}

function portableFeedbackRouting(value: RecordValue): RecordValue {
  const sourcePolicy = isRecord(value.policy) ? value.policy : {};
  const policy: RecordValue = {};
  for (const key of ["regionId", "startNode", "decisionNode", "continuationNode"] as const) {
    const id = safeIdentifier(sourcePolicy[key]);
    if (id) policy[key] = id;
  }
  if (Number.isSafeInteger(sourcePolicy.schemaVersion)) policy.schemaVersion = sourcePolicy.schemaVersion;
  if (isRecord(sourcePolicy.decisionOutput)) {
    const decisionOutput = pick(sourcePolicy.decisionOutput, ["name", "contract"]);
    if (safeIdentifier(decisionOutput.name) && safeIdentifier(decisionOutput.contract)) policy.decisionOutput = decisionOutput;
  }
  if (isRecord(sourcePolicy.routes)) {
    policy.routes = Object.fromEntries(Object.entries(sourcePolicy.routes).flatMap(([code, target]) => {
      const safeCode = safeIdentifier(code);
      const safeTarget = safeIdentifier(target);
      return safeCode && safeTarget ? [[safeCode, safeTarget]] : [];
    }));
  }
  if (Array.isArray(sourcePolicy.reentrySafeNodes)) policy.reentrySafeNodes = sourcePolicy.reentrySafeNodes.map(safeIdentifier).filter((id): id is string => id !== null);
  if (isRecord(sourcePolicy.limits)) {
    const sourceLimits = sourcePolicy.limits;
    const limits = Object.fromEntries(["maxIterations", "maxProviderCalls", "maxElapsedMs"]
      .filter((key) => Number.isSafeInteger(sourceLimits[key]) && Number(sourceLimits[key]) > 0)
      .map((key) => [key, sourceLimits[key]]));
    policy.limits = limits;
  }
  const regions: RecordValue = {};
  if (isRecord(value.regions)) {
    for (const [id, state] of Object.entries(value.regions)) {
      const safeId = safeIdentifier(id);
      if (!safeId || !isRecord(state)) continue;
      const region = pick(state, ["iteration", "providerCalls", "elapsedMs", "elapsedMsStatus", "enteredAtMs", "deadlineAtMs", "completedAtMs"]);
      if (isRecord(state.lastRoute)) {
        const code = safeIdentifier(state.lastRoute.decisionCode);
        const target = safeIdentifier(state.lastRoute.target);
        if (code && target && Number.isSafeInteger(state.lastRoute.iteration)) region.lastRoute = { decisionCode: code, target, iteration: state.lastRoute.iteration };
      }
      if (isRecord(state.budget)) {
        const budget: RecordValue = {};
        for (const name of ["iteration", "providerCalls", "elapsedMs"] as const) {
          const item = state.budget[name];
          if (!isRecord(item) || typeof item.reached !== "boolean" || !Number.isSafeInteger(item.limit)) continue;
          budget[name] = { ...(Number.isSafeInteger(item.used) ? { used: item.used } : {}), limit: item.limit, reached: item.reached,
            ...(name === "elapsedMs" && (item.usageStatus === "verified" || item.usageStatus === "checkpoint-reported" || item.usageStatus === "unavailable") ? { usageStatus: item.usageStatus } : {}) };
        }
        region.budget = budget;
      }
      for (const key of ["eligibleNodes", "reusedPrefix"] as const) if (Array.isArray(state[key])) region[key] = state[key].map(safeIdentifier).filter((item): item is string => item !== null);
      if (Array.isArray(state.invalidatedSuffixes)) region.invalidatedSuffixes = state.invalidatedSuffixes.filter(isRecord).flatMap((row) => {
        const target = safeIdentifier(row.target);
        if (!target || !Number.isSafeInteger(row.iteration) || !Array.isArray(row.nodeIds)) return [];
        return [{ iteration: row.iteration, target, nodeIds: row.nodeIds.map(safeIdentifier).filter((item): item is string => item !== null) }];
      });
      regions[safeId] = region;
    }
  }
  const artifactGenerations = Array.isArray(value.artifactGenerations) ? value.artifactGenerations.filter(isRecord).flatMap((row) => {
    const runId = safeIdentifier(row.runId);
    const generationId = safeIdentifier(row.generationId);
    const nodeId = safeIdentifier(row.nodeId);
    const outputName = safeIdentifier(row.outputName);
    const contract = safeIdentifier(row.contract);
    const attemptPath = safeReference(row.attemptPath);
    const status = row.status === "accepted" || row.status === "invalidated" || row.status === "unverified" ? row.status : undefined;
    if (!runId || !generationId || !nodeId || !outputName || !contract || !attemptPath || !status || !Number.isSafeInteger(row.iteration) || typeof row.materialized !== "boolean" || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) return [];
    return [{ runId, generationId, nodeId, outputName, contract, iteration: row.iteration, status, attemptPath, sha256: row.sha256, materialized: row.materialized }];
  }) : [];
  return { policy, regions, artifactGenerations };
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

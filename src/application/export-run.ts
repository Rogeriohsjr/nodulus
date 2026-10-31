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
  "node.repair.started", "node.repaired", "node.validation.completed", "node.accepted", "node.pending",
  "node.recovery_required", "node.cleanup_unverified", "provider.call.started", "provider.call.completed",
  "graph.admission.closed", "request.answered", "run.intake.completed", "run.needs_input", "run.failed",
  "run.resumed", "run.completed",
]);
const safeOperations = new Set(["invoke", "repair_response", "response_repair"]);
const safeRunStatuses = new Set(["running", "needs_input", "success", "error", "unavailable"]);
const safeOutcomeNames = new Set(["success", "error", "needs_input", "accepted", "rejected", "failed"]);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function safeCallId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function safePositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}

function safeNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeEngineVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value) ? value : undefined;
}

function safeWorkflowInputs(value: unknown): RecordValue | undefined {
  if (!isRecord(value)) return undefined;
  const inputs: RecordValue = {};
  for (const [name, declaration] of Object.entries(value)) {
    const inputName = safeIdentifier(name);
    if (!inputName || !isRecord(declaration)) continue;
    const contract = safeIdentifier(declaration.contract);
    if (contract) inputs[inputName] = { contract };
  }
  return inputs;
}

function safeOutputAliases(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = safeIdentifier(item.name);
    const from = safeIdentifier(item.from);
    const contract = safeIdentifier(item.contract);
    return name && from && contract ? [{ name, from, contract }] : [];
  });
}

function portableGraphExecution(value: unknown, declaredNodes: string[]): RecordValue | undefined {
  if (!isRecord(value)) return undefined;
  const execution: RecordValue = {};
  if (value.kind === "dag") execution.kind = "dag";
  const maxConcurrency = safePositiveInteger(value.maxConcurrency);
  if (maxConcurrency !== undefined) execution.maxConcurrency = maxConcurrency;

  if (isRecord(value.dependsOn)) {
    const dependsOn: RecordValue = {};
    for (const nodeId of declaredNodes) {
      if (!Object.hasOwn(value.dependsOn, nodeId) || !Array.isArray(value.dependsOn[nodeId])) continue;
      dependsOn[nodeId] = value.dependsOn[nodeId].map(safeIdentifier).filter((dependency): dependency is string => dependency !== null && declaredNodes.includes(dependency));
    }
    execution.dependsOn = dependsOn;
  }

  if (isRecord(value.resources)) {
    const resourceAliases = new Map<string, string>();
    for (const nodeId of declaredNodes) {
      const entries = value.resources[nodeId];
      if (!Array.isArray(entries)) continue;
      for (const resource of entries) {
        if (typeof resource === "string" && resource !== "workspace" && !resourceAliases.has(resource)) {
          resourceAliases.set(resource, `resource-${resourceAliases.size + 1}`);
        }
      }
    }
    const resources: RecordValue = {};
    for (const nodeId of declaredNodes) {
      if (!Object.hasOwn(value.resources, nodeId) || !Array.isArray(value.resources[nodeId])) continue;
      resources[nodeId] = value.resources[nodeId].flatMap((resource) => {
        if (resource === "workspace") return ["workspace"];
        if (typeof resource !== "string") return [];
        const alias = resourceAliases.get(resource);
        return alias ? [alias] : [];
      });
    }
    execution.resources = resources;
  }
  return execution;
}

function portableDefinitions(value: unknown): RecordValue | null {
  if (!isRecord(value)) return null;
  const sourceWorkflow = isRecord(value.workflow) ? value.workflow : {};
  const workflowVersion = sourceWorkflow.schemaVersion === 1 || sourceWorkflow.schemaVersion === 2 ? sourceWorkflow.schemaVersion : undefined;
  const nodeDefinitions = new Map<string, RecordValue>();
  if (Array.isArray(value.nodes)) {
    for (const node of value.nodes) {
      if (!isRecord(node)) continue;
      const nodeId = safeIdentifier(node.id);
      if (nodeId && !nodeDefinitions.has(nodeId)) nodeDefinitions.set(nodeId, node);
    }
  }
  const declaredNodes: string[] = [];
  if (Array.isArray(sourceWorkflow.nodes)) {
    for (const sourceNodeId of sourceWorkflow.nodes) {
      const nodeId = safeIdentifier(sourceNodeId);
      if (nodeId && nodeDefinitions.has(nodeId) && !declaredNodes.includes(nodeId)) declaredNodes.push(nodeId);
    }
  }
  const rawExecution = isRecord(sourceWorkflow.execution) ? sourceWorkflow.execution : undefined;
  const graphShapeHint = workflowVersion === 2 || (workflowVersion !== 1 && !!rawExecution
    && (isRecord(rawExecution.dependsOn) || isRecord(rawExecution.resources) || Array.isArray(sourceWorkflow.outputs)));
  const workflow: RecordValue = {};
  if (workflowVersion !== undefined) workflow.schemaVersion = workflowVersion;
  const workflowId = safeIdentifier(sourceWorkflow.id);
  if (workflowId) workflow.id = workflowId;
  if (Array.isArray(sourceWorkflow.nodes)) workflow.nodes = declaredNodes;
  const inputs = safeWorkflowInputs(sourceWorkflow.inputs);
  if (inputs !== undefined) workflow.inputs = inputs;
  if (graphShapeHint) {
    const execution = portableGraphExecution(sourceWorkflow.execution, declaredNodes);
    if (execution) workflow.execution = execution;
    workflow.outputs = safeOutputAliases(sourceWorkflow.outputs);
  }
  const nodes = declaredNodes.flatMap((id) => {
    const node = nodeDefinitions.get(id);
    if (!node) return [];
    const projected: RecordValue = {
      ...(node.schemaVersion === 1 || node.schemaVersion === 2 ? { schemaVersion: node.schemaVersion } : {}),
      id,
      expectedOutputs: Array.isArray(node.expectedOutputs) ? node.expectedOutputs.flatMap((output) => {
        if (!isRecord(output)) return [];
        const name = safeIdentifier(output.name);
        const contract = safeIdentifier(output.contract);
        return name && contract ? [{ name, contract }] : [];
      }) : [],
    };
    if (graphShapeHint && isRecord(node.inputs)) {
      const mappings: RecordValue = {};
      for (const [name, mapping] of Object.entries(node.inputs)) {
        const inputName = safeIdentifier(name);
        if (!inputName || !isRecord(mapping)) continue;
        const from = safeIdentifier(mapping.from);
        const contract = mapping.contract === undefined ? undefined : safeIdentifier(mapping.contract);
        if (from && (mapping.contract === undefined || contract)) mappings[inputName] = { from, ...(contract ? { contract } : {}) };
      }
      projected.inputs = mappings;
    }
    return [projected];
  });
  const profileCount = isRecord(value.providerProfiles) ? Object.keys(value.providerProfiles).length : 0;
  const contracts = isRecord(value.contracts)
    ? Object.fromEntries(Object.entries(value.contracts).flatMap(([id, schema]) => {
      const contractId = safeIdentifier(id);
      return contractId ? [[contractId, safeContractSummary(schema)]] : [];
    }))
    : {};
  return {
    ...(value.schemaVersion === 1 || value.schemaVersion === 2 ? { schemaVersion: value.schemaVersion } : {}),
    ...(safeEngineVersion(value.engineVersion) ? { engineVersion: safeEngineVersion(value.engineVersion) } : {}),
    workflow,
    nodes,
    contracts,
    providerProfileCount: profileCount,
  };
}

type PortableCall = { nodeId: string; attempt: number; operation: string; start: number; complete: number };

function portableTimeline(value: unknown, nodeIds: ReadonlySet<string>): RecordValue[] {
  if (!Array.isArray(value)) return [];
  const source = value.filter(isRecord);
  const callEvents = new Map<string, { starts: RecordValue[]; completions: RecordValue[] }>();
  for (const event of source) {
    if (event.event !== "provider.call.started" && event.event !== "provider.call.completed") continue;
    const callId = safeCallId(event.callId);
    if (!callId) continue;
    const pair = callEvents.get(callId) ?? { starts: [], completions: [] };
    if (event.event === "provider.call.started") pair.starts.push(event);
    else pair.completions.push(event);
    callEvents.set(callId, pair);
  }

  const calls = new Map<string, PortableCall>();
  for (const [callId, pair] of callEvents) {
    if (pair.starts.length !== 1 || pair.completions.length !== 1) continue;
    const start = pair.starts[0];
    const complete = pair.completions[0];
    const nodeId = safeIdentifier(start.nodeId);
    const attempt = safePositiveInteger(start.attempt);
    const operation = typeof start.operation === "string" && safeOperations.has(start.operation) ? start.operation : undefined;
    const startSequence = safePositiveInteger(start.sequence);
    const completeSequence = safePositiveInteger(complete.sequence);
    if (!nodeId || !nodeIds.has(nodeId) || attempt === undefined || !operation || startSequence === undefined || completeSequence === undefined || completeSequence <= startSequence) continue;
    if (safeCallId(complete.callId) !== callId || complete.nodeId !== nodeId || complete.attempt !== attempt || complete.operation !== operation) continue;
    calls.set(callId, { nodeId, attempt, operation, start: startSequence, complete: completeSequence });
  }

  const parentByCall = new Map<string, string>();
  for (const [callId, child] of calls) {
    if (child.operation !== "repair_response" || child.attempt < 2) continue;
    const pair = callEvents.get(callId);
    const start = pair?.starts[0];
    const complete = pair?.completions[0];
    const parentCallId = safeCallId(start?.parentCallId);
    if (!parentCallId || safeCallId(complete?.parentCallId) !== parentCallId) continue;
    const parent = calls.get(parentCallId);
    if (!parent || parent.nodeId !== child.nodeId || parent.attempt !== child.attempt - 1 || parent.complete >= child.start) continue;
    parentByCall.set(callId, parentCallId);
  }

  return source.map((event) => {
    const projected: RecordValue = {};
    const sequence = safePositiveInteger(event.sequence);
    if (sequence !== undefined) projected.sequence = sequence;
    projected.event = safeEventType(event.event);
    const nodeId = safeIdentifier(event.nodeId);
    if (nodeId && nodeIds.has(nodeId)) projected.nodeId = nodeId;
    else if (event.nodeId === null) projected.nodeId = null;
    const attempt = safePositiveInteger(event.attempt);
    if (attempt !== undefined) projected.attempt = attempt;

    const eventCallId = safeCallId(event.callId);
    const call = eventCallId ? calls.get(eventCallId) : undefined;
    const rawOperationPresent = event.operation !== undefined;
    const operation = typeof event.operation === "string" && safeOperations.has(event.operation) ? event.operation : undefined;
    const callIdentityMatches = !!eventCallId && !!nodeId && nodeIds.has(nodeId) && attempt !== undefined
      && (call === undefined || (call.nodeId === nodeId && call.attempt === attempt && (!rawOperationPresent || call.operation === operation)));
    const acceptedCallMatches = event.event !== "node.accepted" || (call !== undefined && sequence !== undefined && call.complete < sequence);
    if (callIdentityMatches && acceptedCallMatches && (event.event !== "provider.call.started" && event.event !== "provider.call.completed" || operation !== undefined)) {
      projected.callId = eventCallId;
    }
    if (event.operation !== undefined) projected.operation = safeOperation(event.operation);
    if (typeof event.failed === "boolean") projected.failed = event.failed;
    const elapsedMs = safeNonnegativeNumber(event.elapsedMs);
    if (elapsedMs !== undefined) projected.elapsedMs = elapsedMs;
    if (typeof event.valid === "boolean") projected.valid = event.valid;
    if (typeof event.outcome === "string" && safeOutcomeNames.has(event.outcome)) projected.outcome = event.outcome;
    if (Array.isArray(event.artifactNames)) projected.artifactNames = event.artifactNames.map(safeIdentifier).filter((name): name is string => name !== null);
    if (typeof event.code === "string") projected.code = safeDiagnosticCode(event.code);
    const validationRef = safeValidationReference(event.validationRef, nodeId ?? undefined, attempt)
      ?? (isRecord(event.refs) ? safeValidationReference(event.refs.validationRef, nodeId ?? undefined, attempt) : undefined);
    if (validationRef) projected.validationRef = validationRef;
    const requestId = safeCallId(event.requestId);
    if (requestId) projected.requestId = requestId;
    if (Array.isArray(event.requestIds)) projected.requestIds = event.requestIds.map(safeCallId).filter((id): id is string => id !== undefined);
    if (event.kind === "node" || event.kind === "caller_inputs") projected.kind = event.kind;
    if (typeof event.launched === "boolean" || event.launched === null) projected.launched = event.launched;
    if ((event.event === "provider.call.started" || event.event === "provider.call.completed")
      && eventCallId && projected.callId === eventCallId && parentByCall.has(eventCallId)
      && safeCallId(event.parentCallId) === parentByCall.get(eventCallId)) {
      projected.parentCallId = parentByCall.get(eventCallId);
    }
    return projected;
  });
}

function safeValidationReference(value: unknown, nodeId: string | undefined, attempt: number | undefined): string | undefined {
  if (!nodeId || attempt === undefined || typeof value !== "string") return undefined;
  return value === `nodes/${nodeId}/attempt-${String(attempt).padStart(3, "0")}/validation.json` ? value : undefined;
}

function portableAttempts(value: unknown, nodeIds: ReadonlySet<string>, timeline: RecordValue[]): RecordValue[] {
  if (!Array.isArray(value)) return [];
  const validCalls = new Map<string, { nodeId: string; attempt: number }>();
  for (const event of timeline) {
    const callId = safeCallId(event.callId);
    const nodeId = safeIdentifier(event.nodeId);
    const attempt = safePositiveInteger(event.attempt);
    if (callId && nodeId && nodeIds.has(nodeId) && attempt !== undefined) validCalls.set(callId, { nodeId, attempt });
  }
  return value.filter(isRecord).flatMap((item) => {
    const nodeId = safeIdentifier(item.nodeId);
    const attempt = safePositiveInteger(item.attempt);
    const events = Number.isSafeInteger(item.events) && typeof item.events === "number" && item.events >= 0 ? item.events : undefined;
    if (!nodeId || !nodeIds.has(nodeId) || attempt === undefined || events === undefined) return [];
    const callIds = Array.isArray(item.callIds) ? item.callIds.map(safeCallId).filter((id): id is string => {
      const call = id ? validCalls.get(id) : undefined;
      return !!id && !!call && call.nodeId === nodeId && call.attempt === attempt;
    }) : [];
    return [{ nodeId, attempt, events, callIds }];
  });
}

function portableValidation(value: unknown, nodeIds: ReadonlySet<string>): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item) => {
    const nodeId = safeIdentifier(item.nodeId);
    const attempt = item.attempt === null ? null : safePositiveInteger(item.attempt);
    const reference = safeValidationReference(item.reference, nodeId ?? undefined, attempt ?? undefined);
    if (!nodeId || !nodeIds.has(nodeId) || attempt === undefined || !reference || typeof item.valid !== "boolean") return [];
    const projected: RecordValue = { nodeId, attempt, reference, valid: item.valid };
    if (typeof item.code === "string") projected.code = safeDiagnosticCode(item.code);
    if (Array.isArray(item.errors) && item.errors.every((error) => typeof error === "string")) projected.errorCount = item.errors.length;
    return [projected];
  });
}

function portableArtifacts(value: unknown, nodeIds: ReadonlySet<string>): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item) => {
    const nodeId = safeIdentifier(item.nodeId);
    const name = safeIdentifier(item.name);
    const reference = safeArtifactReference(item.reference, nodeId ?? undefined, name ?? undefined);
    if (!nodeId || !nodeIds.has(nodeId) || !name || !reference || typeof item.accepted !== "boolean") return [];
    return [{ nodeId, name, reference, accepted: item.accepted }];
  });
}

function safeArtifactReference(value: unknown, nodeId: string | undefined, name: string | undefined): string | undefined {
  if (!nodeId || !name || typeof value !== "string") return undefined;
  const expected = `nodes/${nodeId}/artifacts/${name}.json`;
  return value === expected ? expected : undefined;
}

function safeAttemptResultPath(value: unknown, nodeId: string | null): string | undefined {
  if (!nodeId || typeof value !== "string" || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return undefined;
  const suffix = value.startsWith(`nodes/${nodeId}/attempt-`) ? value.slice(`nodes/${nodeId}/attempt-`.length) : "";
  return /^[0-9]{3,}\/result\.json$/.test(suffix) ? value : undefined;
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
  const inspectionDiagnostics = isRecord(inspection.diagnostics) && Array.isArray(inspection.diagnostics.messages)
    ? inspection.diagnostics.messages.filter((message): message is string => typeof message === "string")
    : [];
  if (inspectionDiagnostics.length > 0) diagnostics.push("Saved run evidence is incomplete or invalid; affected projections were omitted.");
  let definitions: RecordValue | null = null;
  try {
    definitions = portableDefinitions(JSON.parse(await storage.readRunFile(projectRoot, runId, "context/definitions.json")) as unknown);
    if (!definitions) diagnostics.push("Captured workflow definitions are malformed.");
  } catch {
    diagnostics.push("Captured workflow definitions are missing or unreadable.");
  }

  const declaredNodeIds = new Set<string>(isRecord(definitions?.workflow) && Array.isArray(definitions.workflow.nodes)
    ? definitions.workflow.nodes.filter((node): node is string => typeof node === "string")
    : []);
  const timeline = portableTimeline(inspection.timeline, declaredNodeIds);
  const acceptance = portableValidation(inspection.validation, declaredNodeIds);
  const artifacts = portableArtifacts(inspection.artifacts, declaredNodeIds);
  const attempts = portableAttempts(inspection.attempts, declaredNodeIds, timeline);
  const checkpoint = isRecord(inspection.checkpoint) ? inspection.checkpoint : {};
  const feedbackRouting = isRecord(inspection.feedbackRouting) ? portableFeedbackRouting(inspection.feedbackRouting) : undefined;
  const runStatus = typeof inspection.status === "string" && safeRunStatuses.has(inspection.status) ? inspection.status : "unavailable";
  const checkpointPhase = typeof checkpoint.phase === "string" && ["intake", "execution", "completed"].includes(checkpoint.phase)
    ? checkpoint.phase
    : undefined;
  const checkpointEngineVersion = safeEngineVersion(checkpoint.engineVersion);
  const workflowId = safeIdentifier(inspection.workflowId)
    ?? (isRecord(definitions?.workflow) ? safeIdentifier(definitions.workflow.id) ?? undefined : undefined);

  return {
    schemaVersion: 1,
    run: {
      ...(safeCallId(inspection.runId) ? { runId: safeCallId(inspection.runId) } : {}),
      status: runStatus,
      ...(checkpointPhase ? { phase: checkpointPhase } : {}),
      ...(checkpointEngineVersion ? { engineVersion: checkpointEngineVersion } : {}),
      ...(workflowId ? { workflowId } : {}),
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
  const policyVersion = safePositiveInteger(sourcePolicy.schemaVersion);
  if (policyVersion !== undefined) policy.schemaVersion = policyVersion;
  if (isRecord(sourcePolicy.decisionOutput)) {
    const name = safeIdentifier(sourcePolicy.decisionOutput.name);
    const contract = safeIdentifier(sourcePolicy.decisionOutput.contract);
    if (name && contract) policy.decisionOutput = { name, contract };
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
    const limits: RecordValue = {};
    for (const key of ["maxIterations", "maxProviderCalls", "maxElapsedMs"] as const) {
      const limit = safePositiveInteger(sourcePolicy.limits[key]);
      if (limit !== undefined) limits[key] = limit;
    }
    policy.limits = limits;
  }
  const regions: RecordValue = {};
  if (isRecord(value.regions)) {
    for (const [id, state] of Object.entries(value.regions)) {
      const safeId = safeIdentifier(id);
      if (!safeId || !isRecord(state)) continue;
      const region: RecordValue = {};
      for (const key of ["iteration", "providerCalls", "enteredAtMs", "deadlineAtMs", "completedAtMs"] as const) {
        const number = safeNonnegativeInteger(state[key]);
        if (number !== undefined) region[key] = number;
      }
      const elapsedMs = safeNonnegativeNumber(state.elapsedMs);
      if (elapsedMs !== undefined) region.elapsedMs = elapsedMs;
      if (state.elapsedMsStatus === "verified" || state.elapsedMsStatus === "checkpoint-reported" || state.elapsedMsStatus === "unavailable") {
        region.elapsedMsStatus = state.elapsedMsStatus;
      }
      if (isRecord(state.lastRoute)) {
        const code = safeIdentifier(state.lastRoute.decisionCode);
        const target = safeIdentifier(state.lastRoute.target);
        const iteration = safePositiveInteger(state.lastRoute.iteration);
        if (code && target && iteration !== undefined) region.lastRoute = { decisionCode: code, target, iteration };
      }
      if (isRecord(state.budget)) {
        const budget: RecordValue = {};
        for (const name of ["iteration", "providerCalls", "elapsedMs"] as const) {
          const item = state.budget[name];
          const limit = isRecord(item) ? safePositiveInteger(item.limit) : undefined;
          const used = isRecord(item) ? safeNonnegativeInteger(item.used) : undefined;
          if (!isRecord(item) || typeof item.reached !== "boolean" || limit === undefined) continue;
          budget[name] = { ...(used === undefined ? {} : { used }), limit, reached: item.reached,
            ...(name === "elapsedMs" && (item.usageStatus === "verified" || item.usageStatus === "checkpoint-reported" || item.usageStatus === "unavailable") ? { usageStatus: item.usageStatus } : {}) };
        }
        region.budget = budget;
      }
      for (const key of ["eligibleNodes", "reusedPrefix"] as const) {
        if (Array.isArray(state[key])) region[key] = state[key].map(safeIdentifier).filter((item): item is string => item !== null);
      }
      if (Array.isArray(state.invalidatedSuffixes)) region.invalidatedSuffixes = state.invalidatedSuffixes.filter(isRecord).flatMap((row) => {
        const target = safeIdentifier(row.target);
        const iteration = safePositiveInteger(row.iteration);
        if (!target || iteration === undefined || !Array.isArray(row.nodeIds)) return [];
        return [{ iteration, target, nodeIds: row.nodeIds.map(safeIdentifier).filter((item): item is string => item !== null) }];
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
    const attemptPath = safeAttemptResultPath(row.attemptPath, nodeId);
    const status = row.status === "accepted" || row.status === "invalidated" || row.status === "unverified" ? row.status : undefined;
    const iteration = safePositiveInteger(row.iteration);
    if (!runId || !generationId || !nodeId || !outputName || !contract || !attemptPath || !status || iteration === undefined || typeof row.materialized !== "boolean" || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) return [];
    return [{ runId, generationId, nodeId, outputName, contract, iteration, status, attemptPath, sha256: row.sha256, materialized: row.materialized }];
  }) : [];
  return { policy, regions, artifactGenerations };
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

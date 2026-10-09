import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { LocalIntakeStorage } from "../adapters/storage/local-intake-storage.js";
import { ProcessArtifactValidator } from "../adapters/validation/process-artifact-validator.js";
import type { IntakeStorage } from "../core/ports/intake-storage.js";
import { NodulusError } from "../core/shared/nodulus-error.js";
import { executeWorkflow } from "../core/execute-workflow.js";
import { appendRunEvent } from "../core/execution-events.js";
import type { ApplicationRunResult, ProviderPort } from "./run-workflow.js";
import { readCallEvidence, type CallEvidence } from './call-evidence.js';
import { summarizeRunMetrics, type RunMetrics } from "./summarize-run-metrics.js";
import { summarizeCostEstimates } from "./summarize-cost-estimates.js";
import { parsePricingSnapshot } from "../core/pricing-snapshot.js";
import type { PricingSnapshot } from "../core/cost-estimate.js";
import { createFeedbackDeadline } from "../core/feedback-deadline.js";
import type { FeedbackRegionState } from "../core/feedback-routing.js";
import { validateFeedbackResumeEvidence } from "../core/feedback-evidence.js";

export type ResumeWorkflowRequest = {
  projectRoot: string;
  runId: string;
  requestId: string;
  answers: Record<string, unknown>;
};

export type RunStatusResult = {
  runId: string;
  status: string;
  checkpoint: unknown;
  pendingRequest?: unknown;
  events?: unknown[];
  callEvidence?: CallEvidence[];
  metrics?: RunMetrics;
  diagnostics?: { incompleteTrailingEvent: boolean; messages: string[] };
};

export type ResumeWorkflowDependencies = { storage?: IntakeStorage };

type RunCheckpoint = {
  schemaVersion: number;
  engineVersion?: string;
  runId: string;
  status: string;
  activeNode: string | null;
  completedNodes: string[];
  attempt: number;
  requestId?: string;
  pendingKind?: "caller_inputs" | "node" | null;
  pendingNodeId?: string;
  answers?: Record<string, unknown>;
  feedbackRouting?: { regions?: Record<string, FeedbackRegionState> };
};
type SavedDefinitions = {
  schemaVersion: number;
  engineVersion?: string;
  workflow: { id: string; nodes: string[]; inputs?: Record<string, { contract: string }>; feedbackRouting?: import("../core/feedback-definition.js").FeedbackRoutingDefinition };
  nodes: Array<{ id: string; providerProfile: string; expectedOutputs: Array<{ name: string; contract: string }> }>;
  providerProfiles: Record<string, Record<string, unknown>>;
  contracts: Record<string, unknown>;
};
type SavedInputs = { request: string; callerInputs?: Record<string, unknown>; instructions: Array<{ path: string; content: string }> };
type SavedReference = { path: string; mode: "snapshot" | "workspace"; sha256: string };

export const ENGINE_VERSION = "1.0.0";

export async function getRunStatus(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage = new LocalIntakeStorage(),
): Promise<RunStatusResult> {
  const checkpoint = await readCheckpoint(projectRoot, runId, storage);
  const [eventResult, rawMetrics, rawPricing] = await Promise.all([
    readRunEvents(projectRoot, runId, storage),
    readOptionalRunFile(projectRoot, runId, "metrics.json", storage),
    readOptionalRunFile(projectRoot, runId, "pricing.json", storage),
  ]);
  const startedCalls = eventResult.events.flatMap((event) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return [];
    const record = event as Record<string, unknown>;
    return record.event === "provider.call.started" && typeof record.callId === "string" && typeof record.nodeId === "string"
      ? [{ callId: record.callId, nodeId: record.nodeId }]
      : [];
  });
  const { metrics, diagnostics: metricDiagnostics } = summarizeRunMetrics(rawMetrics, startedCalls);
  const pricingDiagnostics: string[] = [];
  let pricingSnapshot: PricingSnapshot | null = null;
  if (rawPricing !== null) {
    try { pricingSnapshot = parsePricingSnapshot(rawPricing); }
    catch (error) { pricingDiagnostics.push(`pricing.json is invalid: ${messageOf(error)}`); }
  }
  const estimates = summarizeCostEstimates(
    metrics.calls,
    metrics.coverage.inputTokens.totalCalls,
    pricingSnapshot,
  );
  if (estimates.estimates !== undefined) metrics.estimates = estimates.estimates;
  if (estimates.coverage !== undefined) metrics.estimateCoverage = estimates.coverage;
  let pendingRequest: unknown;
  if (checkpoint.status === "needs_input") {
    try {
      pendingRequest = JSON.parse(await storage.readRunFile(projectRoot, runId, "pending/request.json")) as unknown;
    } catch (error) {
      throw new NodulusError("RUN_STATE_INVALID", `Paused run '${runId}' has no readable pending request: ${messageOf(error)}`);
    }
  }
  return {
    runId,
    status: checkpoint.status,
    checkpoint,
    events: eventResult.events,
    callEvidence: await readCallEvidence(projectRoot, runId, storage, eventResult.events, metrics.calls),
    metrics,
    diagnostics: {
      incompleteTrailingEvent: eventResult.incompleteTrailingEvent,
      messages: [...eventResult.diagnostics, ...metricDiagnostics, ...pricingDiagnostics, ...estimates.diagnostics],
    },
    ...(pendingRequest === undefined ? {} : { pendingRequest }),
  };
}

async function readRunEvents(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage,
): Promise<{ events: unknown[]; incompleteTrailingEvent: boolean; diagnostics: string[] }> {
  let raw: string;
  try { raw = await storage.readRunFile(projectRoot, runId, "events.jsonl"); }
  catch { return { events: [], incompleteTrailingEvent: false, diagnostics: ["events.jsonl is missing or unreadable"] }; }
  const lines = raw.split("\n");
  const hasNewline = raw.endsWith("\n");
  if (hasNewline) lines.pop();
  const diagnostics: string[] = [];
  let trailing: unknown;
  let incompleteTrailingEvent = false;
  if (!hasNewline) {
    const line = lines.pop() ?? "";
    if (line) {
      try { trailing = JSON.parse(line) as unknown; }
      catch {
        incompleteTrailingEvent = true;
        diagnostics.push("events.jsonl has an incomplete trailing event");
      }
    }
  }
  const events: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as unknown); }
    catch { diagnostics.push("events.jsonl has an invalid complete event"); }
  }
  if (trailing !== undefined) events.push(trailing);
  return { events, incompleteTrailingEvent, diagnostics };
}

async function readOptionalRunFile(
  projectRoot: string,
  runId: string,
  path: string,
  storage: IntakeStorage,
): Promise<string | null> {
  try { return await storage.readRunFile(projectRoot, runId, path); }
  catch { return null; }
}

export async function resumeWorkflow(
  request: ResumeWorkflowRequest,
  provider: ProviderPort,
  dependencies: ResumeWorkflowDependencies = {},
): Promise<ApplicationRunResult> {
  const storage = dependencies.storage ?? new LocalIntakeStorage();
  const lock = await storage.acquireRunLock?.(request.projectRoot, request.runId);
  try {
    return await resumeWorkflowLocked(request, provider, storage);
  } finally {
    await lock?.release();
  }
}

async function resumeWorkflowLocked(
  request: ResumeWorkflowRequest,
  provider: ProviderPort,
  storage: IntakeStorage,
): Promise<ApplicationRunResult> {
  const { projectRoot, runId } = request;
  const checkpoint = await readCheckpoint(projectRoot, runId, storage);
  if (checkpoint.status === "running") {
    throw new NodulusError("RUN_RECOVERY_REQUIRED", `Run '${runId}' has an interrupted invocation with uncertain completion; inspect its saved attempts and recover it manually instead of replaying it.`);
  }
  if (checkpoint.status !== "needs_input") {
    throw new NodulusError("RUN_NOT_PAUSED", `Run '${runId}' is '${checkpoint.status}', not paused for input.`);
  }

  let pending: Record<string, unknown>;
  let definitions: SavedDefinitions;
  let inputs: SavedInputs;
  let references: SavedReference[];
  try {
    pending = parseRecord(await storage.readRunFile(projectRoot, runId, "pending/request.json"), "pending request");
    definitions = JSON.parse(await storage.readRunFile(projectRoot, runId, "context/definitions.json")) as SavedDefinitions;
    inputs = JSON.parse(await storage.readRunFile(projectRoot, runId, "inputs.json")) as SavedInputs;
    references = JSON.parse(await storage.readRunFile(projectRoot, runId, "references.json")) as SavedReference[];
  } catch (error) {
    if (error instanceof NodulusError) throw error;
    throw new NodulusError("RUN_STATE_INVALID", `Run '${runId}' has invalid saved state: ${messageOf(error)}`);
  }

  if (request.requestId !== pending.id || checkpoint.requestId !== pending.id) {
    throw new NodulusError("PENDING_REQUEST_MISMATCH", "The supplied request ID does not match the currently pending request.");
  }
  if (checkpoint.schemaVersion !== 1 || definitions.schemaVersion !== 1) {
    throw new NodulusError("RUN_SCHEMA_UNSUPPORTED", "This run uses an unsupported saved schema version; start a new run with the current Nodulus version.");
  }
  if ((checkpoint.engineVersion ?? definitions.engineVersion) !== ENGINE_VERSION || (definitions.engineVersion ?? ENGINE_VERSION) !== ENGINE_VERSION) {
    throw new NodulusError("ENGINE_VERSION_UNSUPPORTED", "This run was captured by an incompatible Nodulus engine version; resume it with the matching version or start a new run.");
  }
  await validateFeedbackResumeEvidence(storage, projectRoot, runId, checkpoint, definitions, pending);
  await validateWorkspaceReferences(projectRoot, references, storage);
  validateAnswers(request.answers, pending.answerContract);
  const route = definitions.workflow.feedbackRouting;
  const pendingNodeId = checkpoint.pendingKind === "caller_inputs" ? undefined : checkpoint.pendingNodeId ?? checkpoint.activeNode ?? undefined;
  const activeIndex = pendingNodeId ? definitions.workflow.nodes.indexOf(pendingNodeId) : -1;
  const startIndex = route ? definitions.workflow.nodes.indexOf(route.startNode) : -1;
  const decisionIndex = route ? definitions.workflow.nodes.indexOf(route.decisionNode) : -1;
  const pendingInsideRegion = !!route && activeIndex >= startIndex && activeIndex <= decisionIndex;
  const feedbackState = route ? checkpoint.feedbackRouting?.regions?.[route.regionId] : undefined;
  const deadlineAtMs = pendingInsideRegion ? feedbackState?.deadlineAtMs : undefined;
  if (pendingInsideRegion && (!Number.isFinite(deadlineAtMs) || Date.now() >= (deadlineAtMs as number))) {
    return feedbackLimitResult(runId, "Feedback routing elapsed-time limit was reached before resume.");
  }
  const availabilityDeadline = deadlineAtMs === undefined ? undefined : createFeedbackDeadline(deadlineAtMs);
  try {
    await validateSavedProviderAvailability(checkpoint, definitions, provider, availabilityDeadline?.signal, deadlineAtMs);
    if (availabilityDeadline?.expired()) throw new NodulusError("FEEDBACK_LIMIT_EXCEEDED", "Feedback routing elapsed-time limit was reached during provider availability checks.");
  } catch (error) {
    if (availabilityDeadline?.expired()) return feedbackLimitResult(runId, "Feedback routing elapsed-time limit was reached during provider availability checks.");
    throw error;
  } finally { availabilityDeadline?.dispose(); }

  const pendingKind = checkpoint.pendingKind ?? "node";
  let nextInputs = inputs;
  let state: Parameters<typeof executeWorkflow>[5];
  if (pendingKind === "caller_inputs") {
    const callerInputs = { ...(inputs.callerInputs ?? {}), ...request.answers };
    nextInputs = { ...inputs, callerInputs };
    state = { callerInputs };
  } else {
    const nodeId = checkpoint.pendingNodeId ?? checkpoint.activeNode;
    if (!nodeId || !definitions.nodes.some((node) => node.id === nodeId)) {
      throw new NodulusError("RUN_STATE_INVALID", "The paused node is missing from the captured workflow definition.");
    }
    state = {
      startNodeId: nodeId,
      completedNodes: checkpoint.completedNodes ?? [],
      answers: { ...(checkpoint.answers ?? {}), ...request.answers },
      attempt: checkpoint.attempt + 1,
    };
  }

  const intake = { runId, runDirectory: "" };
  const answersRelativePath = `answers/${request.requestId}.json`;
  await storage.writeRunFiles(projectRoot, runId, {
    [answersRelativePath]: json(request.answers),
    ...(nextInputs === inputs ? {} : { "inputs.json": json(nextInputs) }),
    "run.json": json({
      ...checkpoint,
      status: "running",
      requestId: undefined,
      pendingKind: null,
      ...(pendingKind === "node" ? { answers: state.answers } : {}),
    }),
  });
  await appendRunEvent(projectRoot, runId, storage, { event: "run.resumed", runId, requestId: request.requestId });
  return executeWorkflow({
    projectRoot,
    cwd: projectRoot,
    workflow: definitions.workflow.id,
    sources: [{ kind: "inline", text: inputs.request }],
  }, intake, provider, storage, new ProcessArtifactValidator(), state);
}

async function readCheckpoint(projectRoot: string, runId: string, storage: IntakeStorage): Promise<RunCheckpoint> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(runId)) {
    throw new NodulusError("RUN_NOT_FOUND", `Run '${runId}' was not found.`);
  }
  try {
    const checkpoint = JSON.parse(await storage.readRunFile(projectRoot, runId, "run.json")) as RunCheckpoint;
    if (checkpoint.runId !== runId || typeof checkpoint.status !== "string") throw new Error("run checkpoint fields do not match");
    return checkpoint;
  } catch (error) {
    throw new NodulusError("RUN_NOT_FOUND", `Could not read run '${runId}': ${messageOf(error)}`);
  }
}

async function validateWorkspaceReferences(projectRoot: string, references: SavedReference[], storage: IntakeStorage): Promise<void> {
  for (const reference of references) {
    if (reference.mode !== "workspace") continue;
    let content: string;
    try {
      content = await storage.readUtf8(reference.path);
    } catch {
      throw new NodulusError("WORKSPACE_REFERENCE_CHANGED", `Workspace reference '${reference.path}' is unavailable; restore it before resuming.`);
    }
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    if (digest !== reference.sha256) {
      throw new NodulusError("WORKSPACE_REFERENCE_CHANGED", `Workspace reference '${reference.path}' changed since the run paused; restore the captured version before resuming.`);
    }
  }
  void projectRoot;
}

async function validateSavedProviderAvailability(checkpoint: RunCheckpoint, definitions: SavedDefinitions, provider: ProviderPort, signal?: AbortSignal, deadlineAtMs?: number): Promise<void> {
  if (!provider.isAvailable) return;
  const activeIndex = checkpoint.pendingKind === "caller_inputs"
    ? 0
    : definitions.workflow.nodes.indexOf(checkpoint.pendingNodeId ?? checkpoint.activeNode ?? "");
  const remainingIds = new Set(definitions.workflow.nodes.slice(Math.max(0, activeIndex)));
  for (const node of definitions.nodes) {
    if (!remainingIds.has(node.id)) continue;
    const profile = definitions.providerProfiles[node.providerProfile];
    if (!profile || !await provider.isAvailable(profile, { ...(signal ? { signal } : {}), ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}) })) {
      throw new NodulusError("CAPTURED_PROVIDER_UNAVAILABLE", `Captured provider profile '${node.providerProfile}' for node '${node.id}' is unavailable; restore the saved executable before resuming.`);
    }
  }
}

function validateAnswers(answers: Record<string, unknown>, answerContract: unknown): void {
  try {
    const validate = new Ajv2020({ strict: false }).compile(answerContract as AnySchema);
    if (!validate(answers)) {
      throw new NodulusError("ANSWERS_INVALID", `Answers do not satisfy the pending contract: ${new Ajv2020({ strict: false }).errorsText(validate.errors)}.`);
    }
  } catch (error) {
    if (error instanceof NodulusError) throw error;
    throw new NodulusError("ANSWERS_INVALID", `Pending answer contract is invalid: ${messageOf(error)}`);
  }
}

function parseRecord(contents: string, description: string): Record<string, unknown> {
  const value: unknown = JSON.parse(contents);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NodulusError("RUN_STATE_INVALID", `Saved ${description} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function feedbackLimitResult(runId: string, message: string): ApplicationRunResult {
  return { runId, status: "error", result: { error: { code: "FEEDBACK_LIMIT_EXCEEDED", message } } };
}

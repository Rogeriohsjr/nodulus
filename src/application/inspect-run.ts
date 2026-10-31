import { LocalIntakeStorage } from "../adapters/storage/local-intake-storage.js";
import type { IntakeStorage } from "../core/ports/intake-storage.js";
import { NodulusError } from "../core/shared/nodulus-error.js";
import { inspectFeedbackEvidence } from "../core/feedback-inspection.js";
import { readRunStatusEvidence, ENGINE_VERSION, type RunStatusResult } from "./resume-workflow.js";
import { readCapturedGraphContext } from "./captured-graph-context.js";
import { verifyGraphInspectionArtifacts } from "../core/graph-resume-evidence.js";
import type { GraphRunCheckpoint } from "../core/graph-state.js";

type RecordValue = Record<string, unknown>;
type AttemptSummary = { nodeId: string; attempt: number; events: number; callIds: string[] };
type ArtifactReference = { nodeId: string; name: string; reference: string; accepted: true };
type ValidationEvidence = { nodeId: string; attempt: number | null; reference: string; valid: boolean; code?: string; errors?: string[] };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === "string" && field.length > 0 ? field : null;
}

export async function inspectRun(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage = new LocalIntakeStorage(),
): Promise<RecordValue> {
  let status: RunStatusResult;
  let eventsText: string | undefined;
  try {
    const evidence = await readRunStatusEvidence(projectRoot, runId, storage);
    status = evidence.status;
    eventsText = evidence.eventsText;
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    return {
      runId,
      status: "unavailable",
      checkpoint: null,
      events: [],
      timeline: [],
      attempts: [],
      artifacts: [],
      validation: [],
      callEvidence: [],
      uncertainty: [diagnostic],
      nextActions: ["inspect_attempts", "start_new_run"],
      diagnostics: {
        incompleteTrailingEvent: false,
        messages: [diagnostic],
        ...(error instanceof NodulusError ? { code: error.code } : { code: "RUN_INSPECTION_UNAVAILABLE" }),
      },
    };
  }
  const events = status.events ?? [];
  const diagnostics = [...(status.diagnostics?.messages ?? [])];
  const attempts = summarizeAttempts(events);
  const definitions = await readCapturedDefinitions(projectRoot, runId, storage);
  const feedback = await inspectFeedbackEvidence(storage, projectRoot, runId, status.checkpoint, definitions, events);
  diagnostics.push(...feedback.diagnostics);
  const checkpoint = isRecord(status.checkpoint) ? status.checkpoint : {};
  const routedEvidenceExists = hasRoutedEvidence(status.checkpoint, events);
  if (routedEvidenceExists && (!isRecord(definitions) || !isRecord(definitions.workflow) || !isRecord(definitions.workflow.feedbackRouting))) {
    diagnostics.push("Captured feedback-routing definition is missing or invalid; routed artifact acceptance cannot be established.");
  }
  const graphArtifacts = checkpoint.schemaVersion === 2
    ? await readVerifiedGraphArtifacts(projectRoot, runId, status.checkpoint, eventsText, storage, diagnostics)
    : undefined;
  const artifacts = feedback.feedbackRouting
    ? feedback.currentArtifacts
    : routedEvidenceExists ? [] : (graphArtifacts ?? await readArtifacts(projectRoot, runId, storage, events, diagnostics));
  const validation = await readValidation(projectRoot, runId, storage, events, diagnostics);
  const routing = isRecord(checkpoint.feedbackRouting) ? checkpoint.feedbackRouting : {};
  const regions = isRecord(routing.regions) ? routing.regions : {};
  const uncertainCalls = Object.values(regions).filter(isRecord).flatMap((region) => Array.isArray(region.uncertainCalls) ? region.uncertainCalls.filter(isRecord) : []);
  const externallyUncertain = uncertainCalls.some((call) => call.launchStatus === "launched" || call.launchStatus === "uncertain");
  const uncertainty = deriveUncertainty(status.status, status.checkpoint, status.callEvidence ?? [], diagnostics);
  if (externallyUncertain) uncertainty.push("A provider call may have launched without a confirmed completion; its external effect is uncertain.");
  const hasVerifiedGraphRequests = status.status === "needs_input" && Array.isArray(status.pendingRequests) && status.pendingRequests.length > 0;
  const nextActions = hasVerifiedGraphRequests && !externallyUncertain && !(status.callEvidence ?? []).some((call) => call.status === "incomplete")
    ? ["provide_pending_input"]
    : deriveNextActions(status.status, status.pendingRequest, status.callEvidence ?? [], externallyUncertain);

  return {
    ...status,
    timeline: events,
    attempts,
    artifacts,
    ...(feedback.feedbackRouting ? { feedbackRouting: feedback.feedbackRouting } : {}),
    validation,
    uncertainty,
    nextActions,
    diagnostics: {
      incompleteTrailingEvent: status.diagnostics?.incompleteTrailingEvent ?? false,
      messages: diagnostics,
    },
  };
}

function hasRoutedEvidence(checkpoint: unknown, events: unknown[]): boolean {
  const savedRegions = isRecord(checkpoint) && isRecord(checkpoint.feedbackRouting) && isRecord(checkpoint.feedbackRouting.regions)
    ? Object.keys(checkpoint.feedbackRouting.regions).length > 0 : false;
  return savedRegions || events.some((event) => isRecord(event) && typeof event.event === "string" && event.event.startsWith("feedback."));
}

async function readCapturedDefinitions(projectRoot: string, runId: string, storage: IntakeStorage): Promise<unknown> {
  try { return JSON.parse(await storage.readRunFile(projectRoot, runId, "context/definitions.json")) as unknown; }
  catch { return undefined; }
}

async function readVerifiedGraphArtifacts(
  projectRoot: string,
  runId: string,
  checkpointValue: unknown,
  eventsText: string | undefined,
  storage: IntakeStorage,
  diagnostics: string[],
): Promise<ArtifactReference[]> {
  try {
    if (!eventsText || !isRecord(checkpointValue)) throw new NodulusError("RUN_STATE_INVALID", "Graph event history or checkpoint is unavailable.");
    const checkpoint = checkpointValue as unknown as GraphRunCheckpoint;
    const captured = await readCapturedGraphContext(projectRoot, runId, checkpoint, ENGINE_VERSION, storage);
    const verified = await verifyGraphInspectionArtifacts(storage, projectRoot, captured.context, checkpoint, eventsText);
    diagnostics.push(...verified.diagnostics);
    const artifacts: ArtifactReference[] = [];
    for (const nodeId of captured.context.workflow.nodes) {
      const byName = verified.acceptedArtifacts.get(nodeId);
      if (!byName) continue;
      const node = captured.context.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) continue;
      for (const output of node.expectedOutputs) {
        if (!byName.has(output.name)) continue;
        artifacts.push({
          nodeId,
          name: output.name,
          reference: `nodes/${nodeId}/artifacts/${output.name}.json`,
          accepted: true,
        });
      }
    }
    return artifacts;
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : "Captured graph artifact evidence is unavailable.");
    return [];
  }
}

function summarizeAttempts(events: unknown[]): AttemptSummary[] {
  const byKey = new Map<string, AttemptSummary>();
  for (const event of events) {
    if (!isRecord(event) || typeof event.nodeId !== "string" || !Number.isSafeInteger(event.attempt) || (event.attempt as number) < 1) continue;
    const attempt = event.attempt as number;
    const key = `${event.nodeId}\u0000${attempt}`;
    const summary = byKey.get(key) ?? { nodeId: event.nodeId, attempt, events: 0, callIds: [] };
    summary.events += 1;
    if (typeof event.callId === "string" && !summary.callIds.includes(event.callId)) summary.callIds.push(event.callId);
    byKey.set(key, summary);
  }
  return [...byKey.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.attempt - right.attempt);
}

async function readArtifacts(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage,
  events: unknown[],
  diagnostics: string[],
): Promise<ArtifactReference[]> {
  const references: ArtifactReference[] = [];
  for (const event of events) {
    if (!isRecord(event) || event.event !== "node.succeeded" || typeof event.nodeId !== "string" || !Array.isArray(event.artifactNames)) continue;
    for (const name of event.artifactNames) {
      if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        diagnostics.push(`node.succeeded event for '${event.nodeId}' contains an invalid artifact name`);
        continue;
      }
      const reference = `nodes/${event.nodeId}/artifacts/${name}.json`;
      try {
        const parsed: unknown = JSON.parse(await storage.readRunFile(projectRoot, runId, reference));
        if (!isRecord(parsed) || parsed.name !== name) {
          diagnostics.push(`Accepted artifact '${reference}' is malformed or has a mismatched name`);
          continue;
        }
        references.push({ nodeId: event.nodeId, name, reference, accepted: true });
      } catch {
        diagnostics.push(`Accepted artifact '${reference}' is missing or unreadable`);
      }
    }
  }
  return references;
}

async function readValidation(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage,
  events: unknown[],
  diagnostics: string[],
): Promise<ValidationEvidence[]> {
  const results: ValidationEvidence[] = [];
  for (const event of events) {
    if (!isRecord(event) || event.event !== "node.validation.completed") continue;
    const nodeId = stringField(event, "nodeId");
    const reference = stringField(event, "validationRef");
    const attempt = Number.isSafeInteger(event.attempt) && (event.attempt as number) > 0 ? event.attempt as number : null;
    if (!nodeId || !reference || attempt === null || typeof event.valid !== "boolean") {
      diagnostics.push("node.validation.completed event is missing its node or validation reference");
      continue;
    }
    const expectedReference = `nodes/${nodeId}/attempt-${String(attempt).padStart(3, "0")}/validation.json`;
    if (reference !== expectedReference) {
      diagnostics.push(`Validation evidence '${reference}' does not match node '${nodeId}' attempt ${attempt}`);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(await storage.readRunFile(projectRoot, runId, reference));
      if (!isRecord(parsed) || typeof parsed.valid !== "boolean") {
        diagnostics.push(`Validation evidence '${reference}' is malformed`);
        continue;
      }
      if (parsed.valid !== event.valid) {
        diagnostics.push(`Validation evidence '${reference}' contradicts its completion event`);
        continue;
      }
      results.push({
        nodeId,
        attempt,
        reference,
        valid: parsed.valid,
        ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
        ...(Array.isArray(parsed.errors) && parsed.errors.every((item) => typeof item === "string") ? { errors: parsed.errors as string[] } : {}),
      });
    } catch {
      diagnostics.push(`Validation evidence '${reference}' is missing or unreadable`);
    }
  }
  return results;
}

function deriveUncertainty(status: string, checkpoint: unknown, callEvidence: Array<{ status: string; nodeId: string }>, diagnostics: string[]): string[] {
  const uncertainty: string[] = [];
  if (status === "running") {
    const activeNode = stringField(checkpoint, "activeNode");
    uncertainty.push(`Run is still marked running${activeNode ? ` at node '${activeNode}'` : ""}; completion of its active work is uncertain.`);
  }
  for (const call of callEvidence) {
    if (call.status === "incomplete") uncertainty.push(`Provider call for node '${call.nodeId}' has incomplete saved evidence; its external completion is uncertain.`);
  }
  uncertainty.push(...diagnostics);
  return uncertainty;
}

function deriveNextActions(status: string, pendingRequest: unknown, callEvidence: Array<{ status: string }>, externallyUncertain: boolean): string[] {
  if (externallyUncertain || callEvidence.some((call) => call.status === "incomplete")) {
    return ["inspect_attempts", "do_not_replay_uncertain_call"];
  }
  if (status === "success") return [];
  if (status === "needs_input") return pendingRequest ? ["provide_pending_input"] : ["inspect_attempts", "start_new_run"];
  if (status === "running") {
    return ["inspect_attempts", "do_not_replay_uncertain_call"];
  }
  if (status === "error") return ["inspect_attempts", "start_new_run"];
  return ["inspect_attempts"];
}

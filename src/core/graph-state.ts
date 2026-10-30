import { createHash } from "node:crypto";
import type { IntakeStorage, RunFiles } from "./ports/intake-storage.js";
import type { ProviderCallMetric } from "./ports/provider.js";

export type GraphAcceptedRecord = {
  attempt: number;
  callId: string;
  resultRef: string;
  resultSha256: string;
  validationRef: string;
  validationSha256: string;
  responseRef: string;
  responseSha256: string;
  artifacts: Array<{ name: string; contract: string; ref: string; sha256: string }>;
};

export type GraphRunCheckpoint = {
  schemaVersion: 2;
  engineVersion: "1.0.0";
  runId: string;
  workflow: string;
  phase: string;
  status: string;
  completedNodes: string[];
  graph: {
    nodes: Record<string, Record<string, unknown>>;
    pendingRequests: Record<string, Record<string, unknown>>;
    admissionClosed: boolean;
    nextEventSequence: number;
    captured: Record<string, unknown>;
    callerInputs: Record<string, unknown>;
    recoveryRequired?: true;
    uncertainNodeIds?: string[];
    cleanupUnverifiedNodeIds?: string[];
  };
  [key: string]: unknown;
};

export type GraphRunErrorDetails = {
  nodeId?: string;
  callId?: string;
  launch?: boolean | null;
  recoveryRequired?: true;
  uncertainNodeIds?: string[];
  cleanupUnverifiedNodeIds?: string[];
  cause?: { code: string; message: string; nodeId?: string; callId?: string; launch?: boolean | null };
};

/** Single writer for graph checkpoints and the event sequence. */
export class GraphStateWriter {
  private checkpoint: GraphRunCheckpoint;
  private events: string;
  private queue: Promise<void> = Promise.resolve();
  private poisoned: unknown;
  private metrics: unknown[] = [];

  constructor(
    private readonly projectRoot: string,
    private readonly runId: string,
    private readonly storage: IntakeStorage,
    checkpoint: GraphRunCheckpoint,
    eventContent: string,
    metrics: unknown[] = [],
  ) {
    this.checkpoint = structuredClone(checkpoint);
    this.events = eventContent;
    this.metrics = structuredClone(metrics);
  }

  snapshot(): GraphRunCheckpoint {
    return structuredClone(this.checkpoint);
  }

  poison(error: unknown): void {
    if (this.poisoned === undefined) this.poisoned = error;
  }

  admit(nodeId: string, attempt: number, callId: string, attemptRoot: string): Promise<void> {
    return this.commit({ event: "node.started", nodeId, attempt, callId }, (next) => {
      next.phase = "execution";
      next.status = "running";
      next.graph.admissionClosed = false;
      next.graph.nodes[nodeId] = {
        ...next.graph.nodes[nodeId],
        phase: "active",
        attempt,
        callId,
        attemptRoot,
        launch: null,
      };
    });
  }

  callStarted(nodeId: string, attempt: number, callId: string, operation: "invoke" | "repair_response" = "invoke", parentCallId?: string): Promise<void> {
    return this.commit({ event: "provider.call.started", nodeId, attempt, callId, operation, ...(parentCallId ? { parentCallId } : {}) }, (next) => {
      const node = next.graph.nodes[nodeId];
      if (node) Object.assign(node, { attempt, callId, attemptRoot: `nodes/${nodeId}/attempt-${String(attempt).padStart(3, "0")}`, launch: null });
    });
  }

  recordCallCompletion(
    nodeId: string,
    attempt: number,
    callId: string,
    operation: "invoke" | "repair_response",
    launch: boolean | null,
    metric: ProviderCallMetric,
    parentCallId?: string,
    measurementDiagnostic?: string,
  ): Promise<void> {
    return this.commit({ event: "provider.call.completed", nodeId, attempt, callId, operation, ...(parentCallId ? { parentCallId } : {}), launched: launch }, (next) => {
      const node = next.graph.nodes[nodeId];
      if (node?.callId === callId) node.launch = launch;
      if (measurementDiagnostic) appendDiagnostic(next, measurementDiagnostic);
    }, {}, {}, () => undefined, metric);
  }

  accept(nodeId: string, accepted: GraphAcceptedRecord, declaredNodes: string[]): Promise<void> {
    return this.commit({ event: "node.accepted", nodeId, attempt: accepted.attempt, callId: accepted.callId }, (next) => {
      next.graph.nodes[nodeId] = { ...next.graph.nodes[nodeId], phase: "accepted", accepted };
      next.completedNodes = declaredNodes.filter((id) => next.graph.nodes[id]?.phase === "accepted");
    });
  }

  fail(nodeId: string, code: string, message: string): Promise<void> {
    return this.commit({ event: "node.failed", nodeId, code }, (next) => {
      next.graph.admissionClosed = true;
      next.status = "error";
      next.graph.nodes[nodeId] = { ...next.graph.nodes[nodeId], phase: "failed", failure: { code, message } };
    });
  }

  recordUnresolved(
    nodeId: string,
    attempt: number,
    callId: string,
    launch: boolean | null,
    operation: "readiness" | "invoke" | "repair_response",
    interruption: { code: "GRAPH_OPERATION_UNRESOLVED"; message: string; cause: { code: string; message: string } },
    uncertainNodeIds: string[],
  ): Promise<void> {
    return this.commit({ event: "node.recovery_required", nodeId, attempt, callId, operation }, (next) => {
      next.graph.admissionClosed = true;
      next.graph.recoveryRequired = true;
      next.graph.uncertainNodeIds = [...uncertainNodeIds];
      next.graph.nodes[nodeId] = {
        ...next.graph.nodes[nodeId],
        phase: "active",
        attempt,
        callId,
        launch,
        recoveryRequired: true,
        interruption,
      };
    });
  }

  recordCleanupUnverified(
    nodeId: string,
    callId: string,
    launch: boolean | null,
    code: string,
    message: string,
    cleanupUnverified: { code: "PROCESS_TREE_UNVERIFIED"; message: string; operation: "readiness" | "invoke" | "repair_response" | "validator" },
    cleanupUnverifiedNodeIds: string[],
  ): Promise<void> {
    return this.commit([
      { event: "node.failed", nodeId, code },
      { event: "node.cleanup_unverified", nodeId, callId, code, operation: cleanupUnverified.operation },
    ], (next) => {
      next.graph.admissionClosed = true;
      next.graph.recoveryRequired = true;
      next.graph.cleanupUnverifiedNodeIds = [...cleanupUnverifiedNodeIds];
      next.graph.nodes[nodeId] = {
        ...next.graph.nodes[nodeId],
        phase: "failed",
        callId,
        launch,
        failure: { code, message },
        cleanupUnverified,
      };
    });
  }

  closeAdmission(): Promise<void> {
    return this.commit({ event: "graph.admission.closed" }, (next) => { next.graph.admissionClosed = true; });
  }

  closeAdmissionWithPending(request: Record<string, unknown>): Promise<void> {
    return this.commit({
      event: "graph.admission.closed",
      requestId: request.id,
      nodeId: request.nodeId,
    }, (next) => {
      next.graph.admissionClosed = true;
      projectPendingRequest(next, request);
    });
  }

  recordPending(request: Record<string, unknown>): Promise<void> {
    return this.commit({
      event: "node.pending",
      requestId: request.id,
      nodeId: request.nodeId,
      attempt: request.attempt,
      callId: request.callId,
    }, (next) => { projectPendingRequest(next, request); });
  }

  recordAnswer(requestId: string, nodeId: string, answerRef: string, answerSha256: string, answerText: string, diagnostics: string[] = []): Promise<void> {
    const actualHash = createHash("sha256").update(answerText, "utf8").digest("hex");
    if (answerRef !== `answers/${requestId}.json` || answerSha256 !== actualHash) {
      throw new Error(`Graph answer '${requestId}' has an invalid path or digest.`);
    }
    return this.commit({ event: "request.answered", requestId, kind: "node", nodeId }, (next) => {
      const existing = next.graph.pendingRequests[requestId];
      if (!existing || existing.nodeId !== nodeId || existing.kind !== "node" || existing.answerRef !== undefined || existing.answerSha256 !== undefined) {
        throw new Error(`Graph request '${requestId}' is not an unanswered node request.`);
      }
      next.graph.pendingRequests[requestId] = { ...existing, answerRef, answerSha256 };
      appendMetricDiagnostics(next, diagnostics);
    }, { [answerRef]: answerText });
  }

  recordFinalAnswer(requestId: string, nodeId: string, answerRef: string, answerSha256: string, answerText: string, diagnostics: string[] = []): Promise<void> {
    const actualHash = createHash("sha256").update(answerText, "utf8").digest("hex");
    if (answerRef !== `answers/${requestId}.json` || answerSha256 !== actualHash) {
      throw new Error(`Graph answer '${requestId}' has an invalid path or digest.`);
    }
    return this.commit([
      { event: "request.answered", requestId, kind: "node", nodeId },
      { event: "run.resumed", requestId },
    ], (next) => {
      const existing = next.graph.pendingRequests[requestId];
      if (next.status !== "needs_input" || next.graph.admissionClosed !== true ||
          !existing || existing.nodeId !== nodeId || existing.kind !== "node" || existing.answerRef !== undefined || existing.answerSha256 !== undefined) {
        throw new Error(`Graph request '${requestId}' is not an unanswered node request.`);
      }
      if (Object.entries(next.graph.pendingRequests).some(([id, entry]) => id !== requestId &&
          (!entry || typeof entry.answerRef !== "string" || typeof entry.answerSha256 !== "string"))) {
        throw new Error("Final graph answer cannot resume while another pending request is unanswered.");
      }
      next.graph.pendingRequests[requestId] = { ...existing, answerRef, answerSha256 };
      next.phase = "execution";
      next.status = "running";
      next.graph.admissionClosed = true;
      appendMetricDiagnostics(next, diagnostics);
    }, { [answerRef]: answerText });
  }

  pause(requests: Array<Record<string, unknown>>): Promise<void> {
    return this.commit({ event: "run.needs_input", requestIds: requests.map((request) => request.id) }, (next) => {
      next.status = "needs_input";
      next.graph.admissionClosed = true;
      for (const request of requests) projectPendingRequest(next, request);
    });
  }

  finishSuccess(result: unknown, outputFiles: RunFiles = {}): Promise<void> {
    return this.commit({ event: "run.completed" }, (next) => {
      next.phase = "completed";
      next.status = "success";
      next.graph.admissionClosed = true;
    }, { ...outputFiles, "result.json": json({ runId: this.runId, status: "success", result }) });
  }

  finishError(code: string, message: string, details: GraphRunErrorDetails = {}): Promise<void> {
    const error = {
      code,
      message,
      ...(details.nodeId ? { nodeId: details.nodeId } : {}),
      ...(details.callId ? { callId: details.callId } : {}),
      ...(details.launch !== undefined ? { launch: details.launch } : {}),
      ...(details.recoveryRequired ? { recoveryRequired: true as const } : {}),
      ...(details.uncertainNodeIds && details.uncertainNodeIds.length > 0 ? { uncertainNodeIds: [...details.uncertainNodeIds] } : {}),
      ...(details.cleanupUnverifiedNodeIds && details.cleanupUnverifiedNodeIds.length > 0 ? { cleanupUnverifiedNodeIds: [...details.cleanupUnverifiedNodeIds] } : {}),
      ...(details.cause ? { cause: { ...details.cause } } : {}),
    };
    return this.commit({ event: "run.failed", code }, (next) => {
      next.phase = "completed";
      next.status = "error";
      next.graph.admissionClosed = true;
      next.error = error;
    }, { "result.json": json({ runId: this.runId, status: "error", error }) });
  }

  private commit(
    event: Record<string, unknown> | Record<string, unknown>[],
    update: (next: GraphRunCheckpoint) => void,
    evidenceFiles: RunFiles = {},
    optionalFiles: RunFiles = {},
    onPersisted: () => void = () => undefined,
    metric?: ProviderCallMetric,
  ): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.poisoned !== undefined) throw this.poisoned;
      const nextMetrics = metric ? [...this.metrics, metric] : this.metrics;
      const next = structuredClone(this.checkpoint);
      update(next);
      const events = Array.isArray(event) ? event : [event];
      const firstSequence = next.graph.nextEventSequence;
      next.graph.nextEventSequence = firstSequence + events.length;
      const lines = events.map((entry, index) => `${JSON.stringify({
        ...entry,
        runId: this.runId,
        timestamp: new Date().toISOString(),
        sequence: firstSequence + index,
      })}\n`).join("");
      const nextEvents = `${this.events.trimEnd()}${this.events.trim() ? "\n" : ""}${lines}`;
      let optionalFilesPersisted = true;
      let nextOptionalFiles = optionalFiles;
      if (metric) {
        try { nextOptionalFiles = { ...optionalFiles, "metrics.json": json(nextMetrics) }; }
        catch (error) {
          optionalFilesPersisted = false;
          appendDiagnostic(next, `Optional graph metrics serialization failed for call '${metric.callId ?? "unknown"}': ${safeOptionalError(error)}`);
        }
      }
      if (Object.keys(nextOptionalFiles).length > 0) {
        try { await this.storage.writeRunFiles(this.projectRoot, this.runId, nextOptionalFiles); }
        catch (error) {
          optionalFilesPersisted = false;
          appendDiagnostic(next, `Optional graph metrics persistence failed: ${safeOptionalError(error)}`);
        }
      }
      const files: RunFiles = {
        ...evidenceFiles,
        "events.jsonl": nextEvents,
        "run.json": json(next),
      };
      if (this.poisoned !== undefined) throw this.poisoned;
      await this.storage.writeRunFiles(this.projectRoot, this.runId, files);
      this.events = nextEvents;
      this.checkpoint = next;
      if (metric) this.metrics = nextMetrics;
      if (optionalFilesPersisted) onPersisted();
    });
    this.queue = operation.catch((error: unknown) => { this.poison(error); });
    return operation;
  }
}

function projectPendingRequest(checkpoint: GraphRunCheckpoint, request: Record<string, unknown>): void {
  const id = request.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("Graph pending request has no runtime ID.");
  const nodeId = typeof request.nodeId === "string" ? request.nodeId : null;
  const attempt = typeof request.attempt === "number" ? request.attempt : 0;
  const requestSha256 = createHash("sha256").update(json(request), "utf8").digest("hex");
  const projection = {
    nodeId,
    kind: nodeId === null ? "caller_inputs" : "node",
    attempt,
    requestRef: `pending/${id}.json`,
    requestSha256,
  };
  const existing = checkpoint.graph.pendingRequests[id];
  if (existing) {
    const fields = ["nodeId", "kind", "attempt", "requestRef", "requestSha256"] as const;
    const keys = Object.keys(existing);
    const hasAnswerRefField = Object.hasOwn(existing, "answerRef");
    const hasAnswerSha256Field = Object.hasOwn(existing, "answerSha256");
    const hasAnswerRef = typeof existing.answerRef === "string";
    const validAnswerProjection = hasAnswerRefField === hasAnswerSha256Field &&
      (!hasAnswerRefField || (hasAnswerRef && existing.answerRef === `answers/${id}.json` && typeof existing.answerSha256 === "string" && /^[0-9a-f]{64}$/.test(existing.answerSha256)));
    const allowed = new Set<string>([...fields, "answerRef", "answerSha256"]);
    const matches = fields.every((field) => existing[field] === projection[field]) && validAnswerProjection &&
      keys.every((key) => allowed.has(key)) && (keys.length === fields.length || keys.length === fields.length + 2);
    if (!matches) throw new Error(`Graph pending request '${id}' conflicts with its previously projected metadata.`);
    checkpoint.graph.pendingRequests[id] = {
      ...projection,
      ...(hasAnswerRefField ? { answerRef: existing.answerRef, answerSha256: existing.answerSha256 } : {}),
    };
  } else {
    checkpoint.graph.pendingRequests[id] = projection;
  }
  if (nodeId !== null && checkpoint.graph.nodes[nodeId]) {
    checkpoint.graph.nodes[nodeId] = { ...checkpoint.graph.nodes[nodeId], phase: "pending" };
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function appendDiagnostic(checkpoint: GraphRunCheckpoint, diagnostic: string): void {
  const diagnostics = Array.isArray(checkpoint.diagnostics) ? checkpoint.diagnostics as unknown[] : [];
  checkpoint.diagnostics = [...diagnostics, diagnostic];
}

function appendMetricDiagnostics(checkpoint: GraphRunCheckpoint, diagnostics: string[]): void {
  for (const diagnostic of diagnostics.slice(0, 65)) appendDiagnostic(checkpoint, diagnostic);
}

function safeOptionalError(error: unknown): string {
  try { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }
  catch { return "Optional graph metadata error could not be described safely."; }
}

import { createHash } from "node:crypto";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import type { DefinitionContext, OutputArtifact } from "./execute-workflow.js";
import type { GraphAcceptedRecord, GraphRunCheckpoint } from "./graph-state.js";
import type { IntakeStorage } from "./ports/intake-storage.js";
import { NodulusError } from "./shared/nodulus-error.js";
import { callerAnswerContract, missingCallerInputs } from "./caller-inputs.js";
import type { GraphDefinition } from "./workflow-graph.js";

export type GraphResumeContext = DefinitionContext & {
  schemaVersion: 2;
  engineVersion: string;
  workflow: GraphDefinition;
  validatorHashes: Record<string, string>;
};

export type VerifiedNodePendingRequest = {
  kind: "node";
  id: string;
  nodeId: string;
  attempt: number;
  callId: string;
  request: Record<string, unknown>;
  answerContract: unknown;
  answered: boolean;
};

export type VerifiedCallerInputRequest = {
  kind: "caller_inputs";
  id: string;
  nodeId: null;
  attempt: 0;
  request: Record<string, unknown>;
  answerContract: unknown;
  answered: boolean;
};

export type VerifiedPendingRequest = VerifiedNodePendingRequest | VerifiedCallerInputRequest;

export type VerifiedGraphResumeLedger = {
  eventsText: string;
  events: Array<Record<string, unknown>>;
  requests: VerifiedNodePendingRequest[];
  callerRequests: VerifiedCallerInputRequest[];
  effectiveCallerInputs: Record<string, unknown>;
  acceptedArtifacts: Map<string, Map<string, OutputArtifact>>;
  answersByNode: Map<string, Record<string, unknown>>;
  metrics: unknown[];
  metricDiagnostics: string[];
};

export type VerifiedGraphInspection = {
  acceptedArtifacts: Map<string, Map<string, OutputArtifact>>;
  diagnostics: string[];
};

/** Verify accepted graph artifacts without requiring unrelated in-flight calls to finish. */
export async function verifyGraphInspectionArtifacts(
  storage: IntakeStorage,
  projectRoot: string,
  context: GraphResumeContext,
  checkpoint: GraphRunCheckpoint,
  eventsText: string,
): Promise<VerifiedGraphInspection> {
  if (checkpoint.schemaVersion !== 2 || context.schemaVersion !== 2 || context.workflow.schemaVersion !== 2 ||
      checkpoint.runId.length === 0 || checkpoint.workflow !== context.workflow.id ||
      !Number.isSafeInteger(checkpoint.graph.nextEventSequence) || checkpoint.graph.nextEventSequence < 2 ||
      !Array.isArray(checkpoint.completedNodes) || !isRecord(checkpoint.graph.nodes) ||
      Object.keys(checkpoint.graph.nodes).length !== context.workflow.nodes.length ||
      Object.keys(checkpoint.graph.nodes).some((nodeId) => !context.workflow.nodes.includes(nodeId))) {
    throw invalid("Graph checkpoint or captured definition is incompatible with artifact inspection.");
  }
  const events = parseEvents(eventsText, checkpoint.runId, checkpoint.graph.nextEventSequence);
  const acceptedArtifacts = new Map<string, Map<string, OutputArtifact>>();
  const diagnostics: string[] = [];
  for (const nodeId of context.workflow.nodes) {
    const state = checkpoint.graph.nodes[nodeId];
    if (!isRecord(state) || state.phase !== "accepted") continue;
    try {
      if (checkpoint.completedNodes.filter((completed) => completed === nodeId).length !== 1 || !isRecord(state.accepted)) {
        throw invalid(`Accepted graph node '${nodeId}' is missing unique completed-node checkpoint evidence.`);
      }
      const accepted = state.accepted as unknown as GraphAcceptedRecord;
      if (!isUuid(accepted.callId)) throw invalid(`Accepted graph node '${nodeId}' has an invalid accepted call identity.`);
      const starts = events.filter((event) => event.event === "provider.call.started" && event.callId === accepted.callId);
      const completions = events.filter((event) => event.event === "provider.call.completed" && event.callId === accepted.callId);
      const acceptances = events.filter((event) => event.event === "node.accepted" && event.nodeId === nodeId);
      if (starts.length !== 1 || completions.length !== 1 || acceptances.length !== 1 ||
          acceptances[0]!.callId !== accepted.callId || acceptances[0]!.attempt !== accepted.attempt) {
        throw invalid(`Accepted graph node '${nodeId}' does not have unique matching call and acceptance events.`);
      }
      const started = starts[0]!;
      const completed = completions[0]!;
      const acceptedEvent = acceptances[0]!;
      const operation = started.operation;
      if ((operation !== "invoke" && operation !== "repair_response") || started.nodeId !== nodeId ||
          started.attempt !== accepted.attempt || completed.nodeId !== nodeId || completed.attempt !== accepted.attempt ||
          completed.operation !== operation || (completed.launched !== true && completed.launched !== false && completed.launched !== null) ||
          state.callId !== accepted.callId || state.attempt !== accepted.attempt || state.launch !== completed.launched ||
          !Number.isSafeInteger(started.sequence) || !Number.isSafeInteger(completed.sequence) || !Number.isSafeInteger(acceptedEvent.sequence) ||
          Number(started.sequence) >= Number(completed.sequence) || Number(completed.sequence) >= Number(acceptedEvent.sequence)) {
        throw invalid(`Accepted graph node '${nodeId}' has inconsistent or unordered accepted-call evidence.`);
      }
      const node = context.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw invalid(`Accepted graph node '${nodeId}' is absent from captured definitions.`);
      await verifyCallEvidence(storage, projectRoot, checkpoint, events, accepted.callId, nodeId, accepted.attempt, operation, node.providerProfile);
      acceptedArtifacts.set(nodeId, await verifyAcceptedNode(storage, projectRoot, checkpoint, events, nodeId, node, accepted, context.contracts));
    } catch (error) {
      const cause = error instanceof Error ? error.message : "saved evidence is invalid.";
      diagnostics.push(`Accepted graph node '${nodeId}' could not be verified: ${cause}`);
    }
  }
  return { acceptedArtifacts, diagnostics };
}

/** Verify the exact graph inputs and validator bytes shared by first execution and resume. */
export async function verifyCapturedGraphFiles(
  projectRoot: string,
  storage: IntakeStorage,
  context: Pick<GraphResumeContext, "validatorHashes">,
  definitionsText: string,
  inputsText: string,
  referencesText: string,
  checkpoint: GraphRunCheckpoint,
): Promise<void> {
  const captured = checkpoint.graph.captured;
  if (captured.definitionsSha256 !== hash(definitionsText) ||
      captured.inputsSha256 !== hash(inputsText) || captured.referencesSha256 !== hash(referencesText)) {
    throw new NodulusError("RUN_STATE_INVALID", "Captured graph intake files do not match their saved hashes.");
  }
  const pricingHash = captured.pricingSha256;
  if (typeof pricingHash === "string" && pricingHash !== hash(await storage.readRunFile(projectRoot, checkpoint.runId, "pricing.json"))) {
    throw new NodulusError("RUN_STATE_INVALID", "Captured graph pricing data does not match its saved hash.");
  }
  for (const [relative, expectedHash] of Object.entries(context.validatorHashes)) {
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw invalid(`Captured validator '${relative}' has an invalid hash.`);
    const absolute = path.resolve(projectRoot, relative);
    const contents = await storage.readUtf8(absolute);
    if (hash(contents) !== expectedHash) throw new NodulusError("CONFIGURATION_INVALID", `Captured validator '${relative}' has changed since intake.`);
  }
}

/** Fail closed unless the paused graph ledger, request files and all accepted evidence agree. */
export async function verifyGraphResumeLedger(
  projectRoot: string,
  storage: IntakeStorage,
  context: GraphResumeContext,
  checkpoint: GraphRunCheckpoint,
  eventsText: string,
  capturedCallerInputs: Record<string, unknown>,
): Promise<VerifiedGraphResumeLedger> {
  if (checkpoint.schemaVersion !== 2 || context.schemaVersion !== 2 || context.workflow.schemaVersion !== 2 ||
      checkpoint.engineVersion !== context.engineVersion || checkpoint.workflow !== context.workflow.id ||
      checkpoint.runId.length === 0 || checkpoint.status !== "needs_input" || checkpoint.graph.admissionClosed !== true ||
      checkpoint.graph.recoveryRequired === true || (checkpoint.graph.uncertainNodeIds?.length ?? 0) > 0 ||
      (checkpoint.graph.cleanupUnverifiedNodeIds?.length ?? 0) > 0 || Object.hasOwn(context.workflow as unknown as Record<string, unknown>, "feedbackRouting")) {
    throw invalid("Paused graph checkpoint or captured definition is incompatible or requires recovery.");
  }
  if (!Number.isSafeInteger(checkpoint.graph.nextEventSequence) || checkpoint.graph.nextEventSequence < 2) {
    throw invalid("Paused graph checkpoint has an invalid next event sequence.");
  }
  const events = parseEvents(eventsText, checkpoint.runId, checkpoint.graph.nextEventSequence);
  const callStarts = new Map<string, Record<string, unknown>>();
  const callCompletions = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.event === "provider.call.started") {
      if (typeof event.callId !== "string" || !isUuid(event.callId)) throw invalid("Paused graph contains a malformed provider-call start event.");
      if (callStarts.has(event.callId)) throw invalid(`Provider call '${event.callId}' has duplicate start evidence.`);
      callStarts.set(event.callId, event);
    }
    if (event.event === "provider.call.completed") {
      if (typeof event.callId !== "string" || !isUuid(event.callId)) throw invalid("Paused graph contains a malformed provider-call completion event.");
      if (callCompletions.has(event.callId)) throw invalid(`Provider call '${event.callId}' has duplicate completion evidence.`);
      callCompletions.set(event.callId, event);
    }
  }
  if ([...callStarts.keys()].some((callId) => !callCompletions.has(callId)) || [...callCompletions.keys()].some((callId) => !callStarts.has(callId))) {
    throw invalid("Paused graph contains a provider call without a matching completed-call event.");
  }
  const metrics = await verifySavedMetrics(storage, projectRoot, checkpoint.runId, callCompletions);
  for (const [callId, start] of callStarts) {
    const nodeId = start.nodeId;
    const attempt = start.attempt;
    const operation = start.operation;
    const node = typeof nodeId === "string" ? context.nodes.find((candidate) => candidate.id === nodeId) : undefined;
    if (!node || !Number.isSafeInteger(attempt) || Number(attempt) < 1 || (operation !== "invoke" && operation !== "repair_response")) {
      throw invalid(`Provider call '${callId}' has an invalid node, attempt, or operation identity.`);
    }
    const completed = callCompletions.get(callId)!;
    const currentNodeState = checkpoint.graph.nodes[node.id];
    if ((completed.launched !== true && completed.launched !== false && completed.launched !== null) ||
        (currentNodeState?.callId === callId && currentNodeState.launch !== completed.launched)) {
      throw invalid(`Provider call '${callId}' launch evidence differs from its completed event or current node checkpoint.`);
    }
    await verifyCallEvidence(storage, projectRoot, checkpoint, events, callId, node.id, Number(attempt), operation, node.providerProfile);
  }

  const pendingEntries = checkpoint.graph.pendingRequests;
  const requestIds = Object.keys(pendingEntries);
  if (requestIds.length === 0) throw invalid("Paused graph has no runtime pending request entries.");
  const pendingIdSet = new Set(requestIds);
  for (const event of events) {
    if ((event.event === "request.answered" || event.event === "node.pending" ||
        (event.event === "graph.admission.closed" && event.requestId !== undefined)) &&
        (typeof event.requestId !== "string" || !pendingIdSet.has(event.requestId))) {
      throw invalid("Paused graph contains request event evidence without a matching pending ledger entry.");
    }
  }
  const verifiedRequests = new Map<string, VerifiedPendingRequest>();
  const savedAnswers = new Map<string, Record<string, unknown>>();
  for (const requestId of requestIds) {
    const entry = pendingEntries[requestId];
    const isCallerRequest = isRecord(entry) && entry.kind === "caller_inputs";
    if (!isRecord(entry) || !isUuid(requestId) ||
        (isCallerRequest ? entry.nodeId !== null || entry.attempt !== 0 : entry.kind !== "node" || typeof entry.nodeId !== "string" || !Number.isSafeInteger(entry.attempt) || Number(entry.attempt) < 1) ||
        entry.requestRef !== `pending/${requestId}.json` || !isHash(entry.requestSha256) ||
        Object.keys(entry).some((key) => !["nodeId", "kind", "attempt", "requestRef", "requestSha256", "answerRef", "answerSha256"].includes(key)) ||
        ((entry.answerRef === undefined) !== (entry.answerSha256 === undefined))) {
      throw invalid(`Paused graph pending entry '${requestId}' is malformed or unsupported.`);
    }
    const nodeId = isCallerRequest ? null : entry.nodeId as string;
    if (!isCallerRequest && !context.workflow.nodes.includes(nodeId!)) throw invalid(`Paused graph pending node '${nodeId}' is unknown.`);
    const requestText = await readRequired(storage, projectRoot, checkpoint.runId, entry.requestRef, "pending request");
    if (hash(requestText) !== entry.requestSha256) throw invalid(`Pending request '${requestId}' does not match its checkpoint hash.`);
    const request = parseRecord(requestText, `pending request '${requestId}'`);
    if (isCallerRequest) {
      if (request.id !== requestId || request.nodeId !== null || request.kind !== "caller_inputs" || request.attempt !== 0 ||
          Object.keys(request).some((key) => !["id", "nodeId", "kind", "attempt", "questions", "answerContract"].includes(key)) ||
          !Array.isArray(request.questions) || !isRecord(request.answerContract)) {
        throw invalid(`Caller-input request '${requestId}' does not match its captured identity.`);
      }
      const missing = missingCallerInputs(context.workflow.inputs ?? {}, capturedCallerInputs, context.contracts);
      const questions = missing.map(({ name }) => ({ id: name, message: `Provide the required '${name}' input.` }));
      if (missing.length === 0 || !sameJson(request.questions, questions) ||
          !sameJson(request.answerContract, callerAnswerContract(missing, context.contracts))) {
        throw invalid(`Caller-input request '${requestId}' differs from its captured declarations.`);
      }
      if (requestIds.filter((id) => pendingEntries[id]?.kind === "caller_inputs").length !== 1) {
        throw invalid("A graph run may contain only one caller-input request.");
      }
    } else if (request.id !== requestId || request.nodeId !== nodeId || request.attempt !== entry.attempt || typeof request.callId !== "string" || !isUuid(request.callId) ||
        !Array.isArray(request.questions) || request.questions.length === 0 || !isRecord(request.answerContract)) {
      throw invalid(`Pending request '${requestId}' does not match its node, attempt, or call identity.`);
    }
    const answerContract = request.answerContract;
    if (!isRecord(answerContract)) throw invalid(`Pending request '${requestId}' has no captured answer contract.`);
    validateAnswerContract(answerContract, requestId);
    let callId: string | undefined;
    if (!isCallerRequest) {
      const attemptRoot = `nodes/${nodeId}/attempt-${String(entry.attempt).padStart(3, "0")}`;
      const savedResult = parseRecord(await readRequired(storage, projectRoot, checkpoint.runId, `${attemptRoot}/result.json`, "pending attempt result"), "pending attempt result");
      if (savedResult.status !== "needs_input" || !sameJson(savedResult.request, request)) throw invalid(`Pending request '${requestId}' differs from its immutable attempt result.`);
      const validation = parseRecord(await readRequired(storage, projectRoot, checkpoint.runId, `${attemptRoot}/validation.json`, "pending validation"), "pending validation");
      if (validation.valid !== true || validation.outcome !== "needs_input" || !Array.isArray(validation.errors) || validation.errors.length !== 0) {
        throw invalid(`Pending request '${requestId}' has invalid validation evidence.`);
      }
      const responseText = await readRequired(storage, projectRoot, checkpoint.runId, `${attemptRoot}/response.raw.txt`, "pending raw response");
      let rawOutcome: Record<string, unknown>;
      try { rawOutcome = parseRecord(responseText, "pending raw provider outcome"); }
      catch { throw invalid(`Pending request '${requestId}' has invalid raw response evidence.`); }
      if (rawOutcome.status !== "needs_input" || !isRecord(rawOutcome.request) || !sameJson(rawOutcome.request.questions, request.questions) || !sameJson(rawOutcome.request.answerContract, request.answerContract)) {
        throw invalid(`Pending request '${requestId}' does not match its captured provider response.`);
      }
      callId = request.callId as string;
      const started = callStarts.get(callId);
      if (!started || started.nodeId !== nodeId || started.attempt !== Number(entry.attempt) || started.operation !== "invoke") {
        throw invalid(`Pending request '${requestId}' does not match its completed provider call.`);
      }
    }

    const answerRef = entry.answerRef;
    const answerSha256 = entry.answerSha256;
    let answered = false;
    if (answerRef !== undefined) {
      if (answerRef !== `answers/${requestId}.json` || !isHash(answerSha256)) throw invalid(`Pending request '${requestId}' has invalid committed answer metadata.`);
      const answerText = await readRequired(storage, projectRoot, checkpoint.runId, answerRef, "committed answer");
      if (hash(answerText) !== answerSha256) throw invalid(`Committed answer '${requestId}' does not match its checkpoint hash.`);
      const answer = parseRecord(answerText, `committed answer '${requestId}'`);
      validateAnswer(answerContract, answer, requestId);
      savedAnswers.set(requestId, answer);
      answered = true;
    } else {
      const orphanAnswer = await readOptional(storage, projectRoot, checkpoint.runId, `answers/${requestId}.json`);
      if (orphanAnswer !== undefined) throw invalid(`Pending request '${requestId}' has an uncommitted answer file.`);
    }
    const answerEvents = events.filter((event) => event.event === "request.answered" && event.requestId === requestId);
    if (answered) {
      if (answerEvents.length !== 1 || !isExactAnswerEvent(answerEvents[0]!, checkpoint.runId, requestId, nodeId, isCallerRequest ? "caller_inputs" : "node")) {
        throw invalid(`Committed answer '${requestId}' has missing or contradictory event evidence.`);
      }
      if (isCallerRequest) {
        const resumeEvents = events.filter((event) => event.event === "run.resumed" && event.requestId === requestId);
        if (resumeEvents.length !== 1 || !Number.isSafeInteger(resumeEvents[0]!.sequence) ||
            Number(resumeEvents[0]!.sequence) <= Number(answerEvents[0]!.sequence)) {
          throw invalid(`Committed caller-input answer '${requestId}' has no matching later resume transition.`);
        }
      }
    } else if (answerEvents.length > 0) {
      throw invalid(`Pending request '${requestId}' has an answer event without a committed answer.`);
    } else if (isCallerRequest && events.some((event) => event.event === "run.resumed" && event.requestId === requestId)) {
      throw invalid(`Caller-input request '${requestId}' has a resume event without a committed answer.`);
    }
    const verified: VerifiedPendingRequest = isCallerRequest ? {
      kind: "caller_inputs", id: requestId, nodeId: null, attempt: 0, request, answerContract, answered,
    } : {
      kind: "node", id: requestId, nodeId: nodeId!, attempt: Number(entry.attempt), callId: callId!, request, answerContract, answered,
    };
    if (verified.kind === "node" && [...verifiedRequests.values()].some((candidate) => candidate.kind === "node" && candidate.callId === verified.callId)) {
      throw invalid(`Pending request '${requestId}' duplicates another question for the same provider call.`);
    }
    verifiedRequests.set(requestId, verified);
  }

  const introductions = new Map<string, { nodeId: string | null; sequence: number; closure: number; pending: number }>();
  for (const event of events) {
    const isClosure = event.event === "graph.admission.closed" && event.requestId !== undefined;
    const isPending = event.event === "node.pending";
    if (!isClosure && !isPending) continue;
    if (typeof event.requestId !== "string" || (event.nodeId !== null && typeof event.nodeId !== "string") || !Number.isSafeInteger(event.sequence)) {
      throw invalid("Graph request introduction event is malformed.");
    }
    const request = verifiedRequests.get(event.requestId);
    if (!request || request.nodeId !== event.nodeId ||
        (request.kind === "caller_inputs" && (!isClosure || isPending || event.kind !== "caller_inputs" || event.attempt !== 0)) ||
        (request.kind === "node" && (event.nodeId === null ||
          (isPending && (event.attempt !== request.attempt || event.callId !== request.callId)))) ||
        (isPending && request.kind !== "node")) {
      throw invalid(`Graph request introduction for '${event.requestId}' differs from its saved question.`);
    }
    const introduction = introductions.get(event.requestId) ?? {
      nodeId: request.nodeId,
      sequence: Number(event.sequence),
      closure: 0,
      pending: 0,
    };
    if (isClosure) introduction.closure += 1;
    if (isPending) introduction.pending += 1;
    introductions.set(event.requestId, introduction);
  }
  for (const request of verifiedRequests.values()) {
    const introduction = introductions.get(request.id);
    if (!introduction || introduction.closure + introduction.pending !== 1) {
      throw invalid(`Graph request '${request.id}' must have exactly one introduction event.`);
    }
    if (request.kind === "node") {
      const completion = callCompletions.get(request.callId);
      if (!completion || !Number.isSafeInteger(completion.sequence) || introduction.sequence <= Number(completion.sequence)) {
        throw invalid(`Graph request '${request.id}' was introduced before its provider call completed.`);
      }
    } else {
      const allowedKeys = ["event", "requestId", "kind", "nodeId", "attempt", "runId", "timestamp", "sequence"];
      const admissions = events.filter((event) => event.event === "node.started" || event.event === "provider.call.started");
      const callerResume = events.find((event) => event.event === "run.resumed" && event.requestId === request.id);
      if (introduction.closure !== 1 || introduction.pending !== 0 ||
          events.some((event) => event.event === "graph.admission.closed" && event.requestId === request.id &&
            Object.keys(event).some((key) => !allowedKeys.includes(key))) ||
          events.some((event) => (event.event === "node.started" || event.event === "node.pending" || event.event === "provider.call.started") &&
            Number(event.sequence) <= introduction.sequence) ||
          (request.answered && (!callerResume || !Number.isSafeInteger(callerResume.sequence) ||
            admissions.some((event) => !Number.isSafeInteger(event.sequence) || Number(event.sequence) <= Number(callerResume.sequence)))) ||
          (!request.answered && admissions.length > 0)) {
        throw invalid(`Caller-input request '${request.id}' has invalid pre-admission chronology.`);
      }
    }
    const answerEvent = events.find((event) => event.event === "request.answered" && event.requestId === request.id);
    if (answerEvent && Number(answerEvent.sequence) <= introduction.sequence) {
      throw invalid(`Graph request '${request.id}' was answered before it was introduced.`);
    }
  }

  const pauseEvents = events.filter((event) => event.event === "run.needs_input");
  const finalPause = pauseEvents.at(-1);
  if (!finalPause || !Array.isArray(finalPause.requestIds) || !finalPause.requestIds.every((id) => typeof id === "string")) {
    throw invalid("Graph pause event does not contain a valid request list.");
  }
  const finalPauseSequence = finalPause.sequence;
  if (!Number.isSafeInteger(finalPauseSequence) || events.some((event) => event.event === "run.resumed" && Number(event.sequence) > Number(finalPauseSequence))) {
    throw invalid("Graph pause event is not the latest run transition.");
  }
  if ([...introductions.values()].some((introduction) => introduction.sequence >= Number(finalPauseSequence))) {
    throw invalid("Graph question was introduced at or after the latest pause event.");
  }
  const priorResume = [...events].reverse().find((event) => event.event === "run.resumed" && Number(event.sequence) < Number(finalPauseSequence));
  const resumeSequence = priorResume ? Number(priorResume.sequence) : 0;
  const latestWaveIds = new Set([...introductions].filter(([, introduction]) => introduction.sequence > resumeSequence).map(([id]) => id));
  const orderedWaveIds = context.workflow.nodes.flatMap((nodeId) =>
    [...verifiedRequests.values()].filter((entry) => entry.kind === "node" && entry.nodeId === nodeId && latestWaveIds.has(entry.id)).map((entry) => entry.id));
  const callerWaveIds = [...verifiedRequests.values()]
    .filter((entry) => entry.kind === "caller_inputs" && latestWaveIds.has(entry.id))
    .sort((left, right) => introductions.get(left.id)!.sequence - introductions.get(right.id)!.sequence)
    .map((entry) => entry.id);
  orderedWaveIds.unshift(...callerWaveIds);
  if (orderedWaveIds.length !== latestWaveIds.size || !sameJson(finalPause.requestIds, orderedWaveIds)) {
    throw invalid("Graph pause event does not match the latest event-backed question wave.");
  }
  for (const request of verifiedRequests.values()) {
    if (!request.answered && !latestWaveIds.has(request.id)) {
      throw invalid(`Historical request '${request.id}' is unanswered outside the latest question wave.`);
    }
  }

  const callerRequests = callerRequestsFrom(verifiedRequests);
  const effectiveCallerInputs: Record<string, unknown> = { ...capturedCallerInputs };
  const committedCallerAnswers = callerRequests.flatMap((entry) => {
    if (!entry.answered) return [];
    const answerEvent = events.find((event) => event.event === "request.answered" && event.requestId === entry.id)!;
    return [{ entry, sequence: Number(answerEvent.sequence) }];
  }).sort((left, right) => left.sequence - right.sequence);
  for (const { entry } of committedCallerAnswers) {
    const answer = savedAnswers.get(entry.id);
    if (!answer) throw invalid(`Committed caller-input request '${entry.id}' has no verified answer object.`);
    Object.assign(effectiveCallerInputs, answer);
  }
  if (!sameJson(checkpoint.graph.callerInputs, effectiveCallerInputs)) {
    throw invalid("Graph caller-input checkpoint differs from its captured answers.");
  }

  const acceptedNodeIds: string[] = [];
  const acceptedArtifacts = new Map<string, Map<string, OutputArtifact>>();
  if (Object.keys(checkpoint.graph.nodes).length !== context.workflow.nodes.length ||
      Object.keys(checkpoint.graph.nodes).some((nodeId) => !context.workflow.nodes.includes(nodeId))) {
    throw invalid("Paused graph checkpoint contains unknown or missing node state entries.");
  }
  for (const nodeId of context.workflow.nodes) {
    const nodeState = checkpoint.graph.nodes[nodeId];
    if (!isRecord(nodeState) || typeof nodeState.phase !== "string") throw invalid(`Graph node '${nodeId}' has no valid checkpoint phase.`);
    const history = [...verifiedRequests.values()].filter((entry): entry is VerifiedNodePendingRequest => entry.kind === "node" && entry.nodeId === nodeId);
    if (nodeState.phase === "accepted") {
      const node = context.nodes.find((candidate) => candidate.id === nodeId);
      const accepted = nodeState.accepted;
      if (!node || !isRecord(accepted)) throw invalid(`Accepted graph node '${nodeId}' has no evidence manifest.`);
      const acceptedRecord = accepted as unknown as GraphAcceptedRecord;
      if (history.some((entry) => !entry.answered || acceptedRecord.attempt <= entry.attempt)) {
        throw invalid(`Accepted graph node '${nodeId}' has unanswered history or an acceptance attempt before its questions.`);
      }
      const acceptedStart = callStarts.get(acceptedRecord.callId);
      const acceptanceEvents = events.filter((event) => event.event === "node.accepted" && event.nodeId === nodeId && event.callId === acceptedRecord.callId && event.attempt === acceptedRecord.attempt);
      const latestHistorySequence = history.reduce((latest, entry) => {
        const introduction = introductions.get(entry.id)!;
        const completion = callCompletions.get(entry.callId)!;
        const answerEvent = events.find((event) => event.event === "request.answered" && event.requestId === entry.id)!;
        return Math.max(latest, introduction.sequence, Number(completion.sequence), Number(answerEvent.sequence));
      }, 0);
      if (history.length > 0 && (!acceptedStart || !Number.isSafeInteger(acceptedStart.sequence) || Number(acceptedStart.sequence) <= latestHistorySequence ||
          acceptanceEvents.length !== 1 || !Number.isSafeInteger(acceptanceEvents[0]!.sequence) ||
          Number(acceptanceEvents[0]!.sequence) <= latestHistorySequence || Number(acceptanceEvents[0]!.sequence) <= Number(acceptedStart.sequence))) {
        throw invalid(`Accepted graph node '${nodeId}' acceptance does not follow its complete question history.`);
      }
      acceptedArtifacts.set(nodeId, await verifyAcceptedNode(storage, projectRoot, checkpoint, events, nodeId, node, acceptedRecord, context.contracts));
      acceptedNodeIds.push(nodeId);
    } else if (nodeState.phase === "pending") {
      const latest = latestRequestForNode(verifiedRequests, nodeId, callStarts);
      if (nodeState.accepted !== undefined || !latest || latest.callId !== nodeState.callId || latest.attempt !== nodeState.attempt) {
        throw invalid(`Pending graph node '${nodeId}' has no matching latest runtime request entry.`);
      }
    } else if (nodeState.phase !== "not_started") {
      throw invalid(`Graph node '${nodeId}' is active, failed, or uncertain and cannot be resumed as a paused answer.`);
    } else if (history.length > 0) {
      throw invalid(`Graph node '${nodeId}' has question history but is marked not started.`);
    }
  }
  const unansweredCallerRequests = callerRequestsFrom(verifiedRequests).filter((entry) => !entry.answered);
  if (unansweredCallerRequests.length > 0 &&
      (unansweredCallerRequests.length !== 1 || acceptedNodeIds.length > 0 || callStarts.size > 0 ||
        context.workflow.nodes.some((nodeId) => checkpoint.graph.nodes[nodeId]?.phase !== "not_started" || checkpoint.graph.nodes[nodeId]?.attempt !== 0) ||
        checkpoint.completedNodes.length !== 0)) {
    throw invalid("Unanswered caller inputs cannot coexist with admitted or completed graph nodes.");
  }
  if (!sameJson(checkpoint.completedNodes, acceptedNodeIds)) throw invalid("Graph completed-node list differs from accepted checkpoint evidence.");

  const currentRequests = context.workflow.nodes.flatMap((nodeId) => {
    const nodeState = checkpoint.graph.nodes[nodeId];
    if (nodeState?.phase !== "pending") return [];
    const latest = latestRequestForNode(verifiedRequests, nodeId, callStarts);
    if (!latest || latest.callId !== nodeState.callId || latest.attempt !== nodeState.attempt) {
      throw invalid(`Pending graph node '${nodeId}' has no matching latest runtime request entry.`);
    }
    return [latest];
  });
  const currentRequestIds = new Set(currentRequests.map((entry) => entry.id));
  if ([...latestWaveIds].some((id) => !currentRequestIds.has(id) && !callerWaveIds.includes(id))) {
    throw invalid("Latest pause wave contains a question that is not a current node continuation.");
  }
  const answersByNode = new Map<string, Record<string, unknown>>();
  const committedAnswers = [...verifiedRequests.values()].flatMap((entry) => {
    if (entry.kind !== "node" || !entry.answered) return [];
    const answerEvent = events.find((event) => event.event === "request.answered" && event.requestId === entry.id)!;
    return [{ entry, sequence: Number(answerEvent.sequence) }];
  }).sort((left, right) => left.sequence - right.sequence);
  for (const { entry } of committedAnswers) {
    const answer = savedAnswers.get(entry.id);
    if (!answer) throw invalid(`Committed answer '${entry.id}' has no verified answer object.`);
    answersByNode.set(entry.nodeId, { ...(answersByNode.get(entry.nodeId) ?? {}), ...answer });
  }
  return {
    eventsText,
    events,
    requests: currentRequests,
    callerRequests,
    effectiveCallerInputs,
    acceptedArtifacts,
    answersByNode,
    metrics: metrics.rows,
    metricDiagnostics: metrics.diagnostics,
  };
}

function latestRequestForNode(
  requests: Map<string, VerifiedPendingRequest>,
  nodeId: string,
  callStarts: Map<string, Record<string, unknown>>,
): VerifiedNodePendingRequest | undefined {
  let latest: VerifiedNodePendingRequest | undefined;
  let latestSequence = -1;
  for (const request of requests.values()) {
    if (request.kind !== "node" || request.nodeId !== nodeId) continue;
    const start = callStarts.get(request.callId);
    if (!start || !Number.isSafeInteger(start.sequence)) throw invalid(`Pending request '${request.id}' has no ordered provider-call start.`);
    const sequence = Number(start.sequence);
    if (sequence === latestSequence) throw invalid(`Node '${nodeId}' has ambiguous question call ordering.`);
    if (sequence > latestSequence) {
      latest = request;
      latestSequence = sequence;
    }
  }
  return latest;
}

function callerRequestsFrom(requests: Map<string, VerifiedPendingRequest>): VerifiedCallerInputRequest[] {
  return [...requests.values()].filter((request): request is VerifiedCallerInputRequest => request.kind === "caller_inputs");
}

async function verifyAcceptedNode(
  storage: IntakeStorage,
  projectRoot: string,
  checkpoint: GraphRunCheckpoint,
  events: Array<Record<string, unknown>>,
  nodeId: string,
  node: DefinitionContext["nodes"][number],
  accepted: GraphAcceptedRecord,
  contracts: Record<string, unknown>,
): Promise<Map<string, OutputArtifact>> {
  const attemptRoot = `nodes/${nodeId}/attempt-${String(accepted.attempt).padStart(3, "0")}`;
  if (!Number.isSafeInteger(accepted.attempt) || accepted.attempt < 1 || !isUuid(accepted.callId) ||
      checkpoint.graph.nodes[nodeId]?.attempt !== accepted.attempt || checkpoint.graph.nodes[nodeId]?.callId !== accepted.callId ||
      accepted.resultRef !== `${attemptRoot}/result.json` || accepted.validationRef !== `${attemptRoot}/validation.json` || accepted.responseRef !== `${attemptRoot}/response.raw.txt` ||
      !isHash(accepted.resultSha256) || !isHash(accepted.validationSha256) || !isHash(accepted.responseSha256) || !Array.isArray(accepted.artifacts)) {
    throw invalid(`Accepted graph node '${nodeId}' has an invalid identity or reference manifest.`);
  }
  const resultText = await readRequired(storage, projectRoot, checkpoint.runId, accepted.resultRef, "accepted result");
  const validationText = await readRequired(storage, projectRoot, checkpoint.runId, accepted.validationRef, "accepted validation");
  const responseText = await readRequired(storage, projectRoot, checkpoint.runId, accepted.responseRef, "accepted response");
  if (hash(resultText) !== accepted.resultSha256 || hash(validationText) !== accepted.validationSha256 || hash(responseText) !== accepted.responseSha256) {
    throw invalid(`Accepted graph node '${nodeId}' evidence does not match its hashes.`);
  }
  const result = parseRecord(resultText, "accepted node result");
  const validation = parseRecord(validationText, "accepted node validation");
  const response = parseRecord(responseText, "accepted provider outcome");
  if (result.status !== "success" || response.status !== "success" || !Array.isArray(result.artifacts) || !Array.isArray(response.artifacts) ||
      validation.valid !== true || validation.outcome !== "success" || !Array.isArray(validation.errors) || validation.errors.length !== 0 ||
      !sameJson(result.artifacts, response.artifacts)) {
    throw invalid(`Accepted graph node '${nodeId}' has contradictory result, response, or validation evidence.`);
  }
  if (node.expectedOutputs.length !== result.artifacts.length || accepted.artifacts.length !== result.artifacts.length) {
    throw invalid(`Accepted graph node '${nodeId}' does not contain its exact declared outputs.`);
  }
  const expectedByIdentity = new Map(node.expectedOutputs.map((expected) => [`${expected.name}\u0000${expected.contract}`, expected]));
  const seenOutputs = new Set<string>();
  const artifactsByName = new Map<string, OutputArtifact>();
  for (let index = 0; index < result.artifacts.length; index += 1) {
    const artifact = result.artifacts[index];
    const manifest = accepted.artifacts[index];
    if (!isRecord(artifact) || typeof artifact.name !== "string" || typeof artifact.contract !== "string") {
      throw invalid(`Accepted graph node '${nodeId}' contains a malformed output artifact.`);
    }
    const identity = `${artifact.name}\u0000${artifact.contract}`;
    const expected = expectedByIdentity.get(identity);
    if (!expected || seenOutputs.has(identity)) throw invalid(`Accepted graph node '${nodeId}' output set does not match its captured declaration.`);
    seenOutputs.add(identity);
    if (!isRecord(manifest) || manifest.name !== expected.name || manifest.contract !== expected.contract ||
        manifest.ref !== `nodes/${nodeId}/artifacts/${expected.name}.json` || !isHash(manifest.sha256)) {
      throw invalid(`Accepted graph node '${nodeId}' output identity does not match its captured declaration.`);
    }
    const artifactText = await readRequired(storage, projectRoot, checkpoint.runId, manifest.ref, "accepted artifact");
    if (hash(artifactText) !== manifest.sha256 || !sameJson(parseJson(artifactText, "accepted artifact"), artifact)) {
      throw invalid(`Accepted graph node '${nodeId}' artifact '${expected.name}' does not match its saved hash or result.`);
    }
    const validate = new Ajv2020({ strict: false }).compile(contracts[expected.contract] as AnySchema);
    if (!validate(artifact.data)) throw invalid(`Accepted graph node '${nodeId}' artifact '${expected.name}' no longer satisfies its captured contract.`);
    artifactsByName.set(expected.name, { name: expected.name, contract: expected.contract, data: artifact.data });
  }
  const startedCall = events.find((event) => event.event === "provider.call.started" && event.callId === accepted.callId);
  const operation = startedCall?.operation;
  if (operation !== "invoke" && operation !== "repair_response") throw invalid(`Accepted provider call '${accepted.callId}' has an invalid operation.`);
  if (!startedCall || startedCall.nodeId !== nodeId || startedCall.attempt !== accepted.attempt) throw invalid(`Accepted provider call '${accepted.callId}' differs from its node checkpoint.`);
  if (!events.some((event) => event.event === "node.accepted" && event.nodeId === nodeId && event.callId === accepted.callId && event.attempt === accepted.attempt)) {
    throw invalid(`Accepted graph node '${nodeId}' has no matching acceptance event.`);
  }
  return artifactsByName;
}

async function verifySavedMetrics(
  storage: IntakeStorage,
  projectRoot: string,
  runId: string,
  completions: Map<string, Record<string, unknown>>,
): Promise<{ rows: unknown[]; diagnostics: string[] }> {
  let metricsText: string;
  try { metricsText = await storage.readRunFile(projectRoot, runId, "metrics.json"); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { rows: [], diagnostics: [] };
    return { rows: [], diagnostics: ["Optional graph metrics history could not be read."] };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(metricsText) as unknown; }
  catch { return { rows: [], diagnostics: ["Optional graph metrics history was not valid JSON."] }; }
  if (!Array.isArray(parsed)) return { rows: [], diagnostics: ["Optional graph metrics history was not an array."] };
  const diagnostics: string[] = [];
  let diagnosticsOmitted = false;
  const addDiagnostic = (callId: string, reason: string): void => {
    if (diagnostics.length < 64) diagnostics.push(`Optional measurement for call '${callId}' ${reason}.`);
    else if (!diagnosticsOmitted) {
      diagnostics.push("Additional optional graph measurement diagnostics were omitted.");
      diagnosticsOmitted = true;
    }
  };
  const seenCalls = new Set<string>();
  let previousSequence = 0;
  for (const candidate of parsed) {
    if (!isRecord(candidate) || typeof candidate.callId !== "string" || !isUuid(candidate.callId) ||
        typeof candidate.nodeId !== "string" || !Number.isSafeInteger(candidate.attempt) || Number(candidate.attempt) < 1 ||
        (candidate.operation !== "invoke" && candidate.operation !== "repair_response") ||
        (candidate.launched !== true && candidate.launched !== false && candidate.launched !== null)) {
      throw invalid("Saved graph metrics contain a malformed call identity.");
    }
    const completion = completions.get(candidate.callId);
    const sequence = completion?.sequence;
    if (!completion || completion.nodeId !== candidate.nodeId || completion.attempt !== candidate.attempt ||
        completion.operation !== candidate.operation || completion.launched !== candidate.launched ||
        typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= previousSequence || seenCalls.has(candidate.callId)) {
      throw invalid(`Saved metrics for call '${candidate.callId}' contradict completed call history or its order.`);
    }
    if (typeof candidate.elapsedMs !== "number" || !Number.isFinite(candidate.elapsedMs) || candidate.elapsedMs < 0) addDiagnostic(candidate.callId, "has invalid elapsed-time metadata");
    if (!validUsage(candidate.usage)) addDiagnostic(candidate.callId, "has invalid usage metadata");
    if (candidate.telemetry !== undefined && !validTelemetry(candidate.telemetry, candidate.callId)) addDiagnostic(candidate.callId, "has malformed telemetry metadata");
    else if (candidate.telemetry !== undefined && !sameJson(candidate.usage, telemetryUsage(candidate.telemetry))) addDiagnostic(candidate.callId, "has telemetry that disagrees with normalized usage");
    previousSequence = sequence;
    seenCalls.add(candidate.callId);
  }
  return { rows: parsed, diagnostics };
}

function validUsage(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return ["inputTokens", "outputTokens", "cacheReadTokens", "costUsd"].every((key) =>
    value[key] === null || (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0));
}

function validTelemetry(value: unknown, callId: string): boolean {
  if (!isRecord(value) || value.schemaVersion !== 1 || (value.callId !== undefined && value.callId !== callId) ||
      typeof value.provider !== "string" || (value.cliVersion !== null && typeof value.cliVersion !== "string") ||
      (value.reportedModel !== null && typeof value.reportedModel !== "string") ||
      !isRecord(value.reported) || !isRecord(value.normalized) ||
      typeof value.coverage !== "string" || !["complete", "partial", "unavailable"].includes(value.coverage) ||
      !Number.isSafeInteger(value.stepCount) || Number(value.stepCount) < 0 || !isRecord(value.source) ||
      !Array.isArray(value.diagnostics) || value.diagnostics.some((entry) => typeof entry !== "string") ||
      !isRecord(value.semantics) || typeof value.semantics.inputCache !== "string" || !["included", "excluded", "unknown"].includes(value.semantics.inputCache) ||
      typeof value.semantics.outputReasoning !== "string" || !["included", "excluded", "unknown"].includes(value.semantics.outputReasoning) ||
      (value.semantics.evidence !== null && typeof value.semantics.evidence !== "string")) return false;
  const reported = value.reported;
  const normalized = value.normalized;
  const counters = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "costUsd"];
  return counters.every((key) => reported[key] === null ||
      (typeof reported[key] === "number" && Number.isFinite(reported[key]) && Number(reported[key]) >= 0)) &&
    ["inputTokens", "outputTokens"].every((key) => normalized[key] === null ||
      (typeof normalized[key] === "number" && Number.isFinite(normalized[key]) && Number(normalized[key]) >= 0)) &&
    typeof value.source.eventType === "string" && Array.isArray(value.source.recordIds) && value.source.recordIds.every((entry) => typeof entry === "string") &&
    typeof value.source.transportRef === "string" && value.source.transportRef.length > 0 && value.source.parserVersion === 1;
}

function telemetryUsage(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.reported) || !isRecord(value.normalized)) return undefined;
  const usage = {
    inputTokens: value.normalized.inputTokens,
    outputTokens: value.normalized.outputTokens,
    cacheReadTokens: value.coverage === "complete" ? value.reported.cacheReadTokens : null,
    costUsd: value.coverage === "complete" ? value.reported.costUsd : null,
  };
  return Object.values(usage).every((entry) => entry === null) ? null : usage;
}

async function verifyCallEvidence(
  storage: IntakeStorage,
  projectRoot: string,
  checkpoint: GraphRunCheckpoint,
  events: Array<Record<string, unknown>>,
  callId: string,
  nodeId: string,
  attempt: number,
  operation: "invoke" | "repair_response",
  providerProfileId: string,
): Promise<void> {
  const started = events.find((event) => event.event === "provider.call.started" && event.callId === callId);
  const completed = events.find((event) => event.event === "provider.call.completed" && event.callId === callId);
  if (!started || !completed || started.nodeId !== nodeId || started.attempt !== attempt || started.operation !== operation ||
      completed.nodeId !== nodeId || completed.attempt !== attempt || completed.operation !== operation ||
      completed.parentCallId !== started.parentCallId) {
    throw invalid(`Provider call '${callId}' does not have matching node, attempt, operation and completion events.`);
  }
  const attemptRoot = `nodes/${nodeId}/attempt-${String(attempt).padStart(3, "0")}`;
  const invocation = parseRecord(await readRequired(storage, projectRoot, checkpoint.runId, `${attemptRoot}/invocation.json`, "graph invocation"), "graph invocation");
  const expectedParent = typeof started.parentCallId === "string" ? started.parentCallId : undefined;
  const actualParent = typeof invocation.parentCallId === "string" ? invocation.parentCallId : undefined;
  if (invocation.runId !== checkpoint.runId || invocation.workflow !== checkpoint.workflow || invocation.nodeId !== nodeId ||
      invocation.callId !== callId || invocation.attempt !== attempt || invocation.operation !== operation ||
      invocation.providerProfile !== providerProfileId || !Number.isSafeInteger(invocation.invocationAttempt) || Number(invocation.invocationAttempt) < 1 || Number(invocation.invocationAttempt) > attempt ||
      actualParent !== expectedParent || (invocation.parentCallId !== undefined && typeof invocation.parentCallId !== "string")) {
    throw invalid(`Graph invocation '${callId}' differs from its checkpoint or call event identity.`);
  }

  const requestText = await readOptional(storage, projectRoot, checkpoint.runId, `calls/${callId}/request.json`);
  if (requestText !== undefined) {
    const request = parseRecord(requestText, "provider call request");
    const requestParent = request.parentCallId === null ? undefined : request.parentCallId;
    if ((request.runId !== undefined && request.runId !== checkpoint.runId) || (request.workflow !== undefined && request.workflow !== checkpoint.workflow) ||
        (request.callId !== undefined && request.callId !== callId) || (request.nodeId !== undefined && request.nodeId !== nodeId) ||
        (request.attempt !== undefined && request.attempt !== attempt) || (request.operation !== undefined && request.operation !== operation) ||
        (request.providerProfileId !== undefined && request.providerProfileId !== providerProfileId) ||
        (request.parentCallId !== undefined && requestParent !== expectedParent)) {
      throw invalid(`Provider call '${callId}' request sidecar contradicts its graph invocation.`);
    }
  }

  const transportText = await readOptional(storage, projectRoot, checkpoint.runId, `calls/${callId}/transport.json`);
  if (transportText !== undefined) {
    const transport = parseRecord(transportText, "provider call transport");
    if ((transport.callId !== undefined && transport.callId !== callId) ||
        (transport.started !== undefined && transport.started !== true) ||
        (transport.exitCode !== undefined && transport.exitCode !== 0) ||
        (transport.cancelled !== undefined && transport.cancelled !== false) ||
        (transport.timedOut !== undefined && transport.timedOut !== false) ||
        (transport.outputLimitExceeded !== undefined && transport.outputLimitExceeded !== false)) {
      throw invalid(`Provider call '${callId}' transport sidecar contradicts its completed graph call.`);
    }
  }
}

function parseEvents(text: string, runId: string, nextEventSequence: number): Array<Record<string, unknown>> {
  if (!text.endsWith("\n")) throw invalid("Graph event history has an incomplete trailing event.");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length + 1 !== nextEventSequence) throw invalid("Graph event history does not match its checkpoint sequence.");
  const events = lines.map((line) => parseRecord(line, "graph event"));
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.runId !== runId || events[index]!.sequence !== index + 1) throw invalid("Graph event history contains an invalid or discontinuous sequence.");
  }
  return events;
}

function isExactAnswerEvent(event: Record<string, unknown>, runId: string, requestId: string, nodeId: string | null, kind: "node" | "caller_inputs"): boolean {
  const keys = ["event", "requestId", "kind", "nodeId", "runId", "timestamp", "sequence"];
  return event.event === "request.answered" && event.requestId === requestId && event.kind === kind && event.nodeId === nodeId && event.runId === runId &&
    typeof event.timestamp === "string" && Number.isSafeInteger(event.sequence) && Object.keys(event).every((key) => keys.includes(key));
}

function validateAnswerContract(contract: Record<string, unknown>, requestId: string): void {
  try { new Ajv2020({ strict: false }).compile(contract as AnySchema); }
  catch { throw invalid(`Pending request '${requestId}' has an invalid answer contract.`); }
}

function validateAnswer(contract: unknown, answer: Record<string, unknown>, requestId: string): void {
  try {
    const validate = new Ajv2020({ strict: false }).compile(contract as AnySchema);
    if (!validate(answer)) throw invalid(`Committed answer for request '${requestId}' does not satisfy its captured contract.`);
  } catch (error) {
    if (error instanceof NodulusError) throw error;
    throw invalid(`Committed answer for request '${requestId}' has an invalid captured contract.`);
  }
}

async function readRequired(storage: IntakeStorage, projectRoot: string, runId: string, reference: string, description: string): Promise<string> {
  try { return await storage.readRunFile(projectRoot, runId, reference); }
  catch { throw invalid(`Saved ${description} '${reference}' is missing or unreadable.`); }
}

async function readOptional(storage: IntakeStorage, projectRoot: string, runId: string, reference: string): Promise<string | undefined> {
  try { return await storage.readRunFile(projectRoot, runId, reference); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw invalid(`Saved optional answer evidence '${reference}' is unreadable.`);
  }
}

function parseRecord(text: string, description: string): Record<string, unknown> {
  const value = parseJson(text, description);
  if (!isRecord(value)) throw invalid(`Saved ${description} must be a JSON object.`);
  return value;
}

function parseJson(text: string, description: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { throw invalid(`Saved ${description} is not valid JSON.`); }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string): NodulusError {
  return new NodulusError("RUN_STATE_INVALID", message);
}

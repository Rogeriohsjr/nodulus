import { createHash } from "node:crypto";
import type { IntakeStorage } from "./ports/intake-storage.js";

type JsonRecord = Record<string, unknown>;
type InspectionDefinition = {
  workflow?: { feedbackRouting?: JsonRecord; nodes?: unknown };
  nodes?: unknown;
};

export type FeedbackInspection = {
  feedbackRouting?: {
    policy: JsonRecord;
    regions: Record<string, JsonRecord>;
    artifactGenerations: Array<JsonRecord>;
  };
  currentArtifacts: Array<{ nodeId: string; name: string; reference: string; accepted: true }>;
  diagnostics: string[];
};

/** Read the routed execution ledger without invoking providers, validators, or writes. */
export async function inspectFeedbackEvidence(
  storage: IntakeStorage,
  projectRoot: string,
  runId: string,
  checkpoint: unknown,
  definitions: unknown,
  rawEvents: unknown[],
): Promise<FeedbackInspection> {
  const definition = isRecord(definitions) ? definitions as InspectionDefinition : undefined;
  const route = definition?.workflow?.feedbackRouting;
  if (!route || !isRecord(route) || typeof route.regionId !== "string") return { currentArtifacts: [], diagnostics: [] };

  const diagnostics: string[] = [];
  if (!Array.isArray(definition?.workflow?.nodes) || !definition.workflow.nodes.every((node) => typeof node === "string")
    || !Array.isArray(definition.nodes) || !definition.nodes.every(isRecord)) {
    diagnostics.push("Captured workflow node definitions are malformed; routed artifact acceptance is withheld.");
    return {
      feedbackRouting: { policy: pick(route, ["schemaVersion", "regionId", "startNode", "decisionNode", "decisionOutput", "continuationNode", "routes", "reentrySafeNodes", "limits"]), regions: {}, artifactGenerations: [] },
      currentArtifacts: [],
      diagnostics,
    };
  }
  const checkpointRecord = isRecord(checkpoint) ? checkpoint : {};
  const routeCheckpoint = isRecord(checkpointRecord.feedbackRouting) ? checkpointRecord.feedbackRouting : {};
  const regions = isRecord(routeCheckpoint.regions) ? routeCheckpoint.regions : {};
  const events = rawEvents.filter(isRecord);
  const regionId = route.regionId;
  const created = events.filter((event) => event.event === "feedback.generation.created" && event.regionId === regionId);
  const invalidated = new Set<string>();
  let transitionEvidenceValid = true;
  const workflowNodes = definition.workflow.nodes as string[];
  const decisionIndex = workflowNodes.indexOf(String(route.decisionNode));
  const startIndex = workflowNodes.indexOf(String(route.startNode));
  const transitions = events.filter((event) => event.event === "feedback.route.transition" && event.regionId === regionId);
  const knownCreated: Array<{ generationId: string; nodeId: string; sequence: number }> = [];
  for (const event of events) {
    if (event.event === "feedback.generation.created" && event.regionId === regionId && typeof event.generationId === "string" && typeof event.nodeId === "string") {
      knownCreated.push({ generationId: event.generationId, nodeId: event.nodeId, sequence: Number(event.sequence) });
    }
    if (event.event !== "feedback.route.transition" || event.regionId !== regionId) continue;
    const targetIndex = typeof event.target === "string" ? workflowNodes.indexOf(event.target) : -1;
    const suffix = targetIndex >= 0 && decisionIndex >= targetIndex ? workflowNodes.slice(targetIndex, decisionIndex + 1) : [];
    const expectedIds = knownCreated.filter((generation) => generation.sequence < Number(event.sequence) && suffix.includes(generation.nodeId) && !invalidated.has(generation.generationId)).map((generation) => generation.generationId);
    const transitionNumber = transitions.findIndex((candidate) => candidate === event);
    const valid = Array.isArray(event.invalidatedGenerationIds) && sameJson(event.invalidatedGenerationIds, expectedIds)
      && Array.isArray(event.nodeIds) && sameJson(event.nodeIds, suffix)
      && isRecord(route.routes) && isRecord(event.feedback) && typeof event.feedback.decisionCode === "string" && route.routes[event.feedback.decisionCode] === event.target
      && event.iteration === transitionNumber + 2;
    if (!valid) {
      transitionEvidenceValid = false;
      diagnostics.push("Feedback route transition has an invalid target, suffix, iteration, or generation invalidation set.");
      continue;
    }
    for (const id of expectedIds) invalidated.add(id);
  }
  if (!transitionEvidenceValid) diagnostics.push("Routed generation acceptance is withheld because transition evidence is inconsistent.");
  const state = isRecord(regions[regionId]) ? regions[regionId] : {};
  if (!isRecord(regions[regionId])) diagnostics.push(`Feedback region '${regionId}' has no readable checkpoint summary.`);

  const nodeDefinitions = new Map((definition.nodes as JsonRecord[]).filter((node): node is JsonRecord & { id: string } => typeof node.id === "string").map((node) => [node.id, node]));
  const generationRows: JsonRecord[] = [];
  const materializedAccepted: Array<{ nodeId: string; name: string; reference: string; accepted: true }> = [];
  const generationOutputKeys = new Set(created.flatMap((event) => typeof event.nodeId === "string" && typeof event.outputName === "string" ? [`${event.nodeId}\0${event.outputName}`] : []));
  for (const nodeId of workflowNodes.slice(Math.max(startIndex, 0), Math.max(decisionIndex, 0))) {
    const outputs = nodeDefinitions.get(nodeId)?.expectedOutputs;
    if (Array.isArray(outputs)) for (const output of outputs.filter(isRecord)) if (typeof output.name === "string") generationOutputKeys.add(`${nodeId}\0${output.name}`);
  }
  const seen = new Set<string>();
  for (const event of created) {
    const generationId = event.generationId;
    const nodeId = event.nodeId;
    const outputName = event.outputName;
    if (typeof generationId !== "string" || typeof nodeId !== "string" || typeof outputName !== "string" || seen.has(generationId)) {
      diagnostics.push("Feedback generation-created history contains a malformed or duplicate identity.");
      continue;
    }
    seen.add(generationId);
    const iteration = event.iteration;
    const attemptPath = event.attemptPath;
    const generationStatus = !transitionEvidenceValid ? "unverified" : invalidated.has(generationId) ? "invalidated" : "accepted";
    const nodeOutputs = nodeDefinitions.get(nodeId)?.expectedOutputs;
    const output = Array.isArray(nodeOutputs) ? nodeOutputs.filter(isRecord).find((candidate) => candidate.name === outputName) : undefined;
    let digest: string | undefined;
    let materialized = false;
    // The event intentionally carries identity only; bind it to the captured node output contract below.
    const expectedAttemptPath = expectedGenerationAttemptPath(events, nodeId, outputName, Number(event.sequence));
    let valid = Boolean(output && typeof output.contract === "string" && Number.isSafeInteger(iteration)
      && typeof attemptPath === "string" && attemptPath === expectedAttemptPath);
    try {
      const manifestPath = `feedback/${regionId}/generations/${generationId}.json`;
      const manifest = parse(await storage.readRunFile(projectRoot, runId, manifestPath));
      if (!valid || !isRecord(manifest)) throw new Error("manifest identity or attempt ownership is invalid");
      const identity = { runId, regionId, nodeId, outputName, contract: output!.contract, iteration, attemptPath, generationId };
      for (const [key, value] of Object.entries(identity)) if (manifest[key] !== value) throw new Error("manifest identity differs from generation history");
      const result = parse(await storage.readRunFile(projectRoot, runId, attemptPath as string));
      if (!isRecord(result) || result.status !== "success" || !Array.isArray(result.artifacts)) throw new Error("attempt result is not a successful artifact payload");
      const artifact = result.artifacts.find((candidate) => isRecord(candidate) && candidate.name === outputName);
      if (!isRecord(artifact) || artifact.contract !== output!.contract) throw new Error("attempt result does not contain the declared output");
      digest = hash(artifact.data);
      if (manifest.sha256 !== digest) throw new Error("manifest digest differs from the accepted attempt payload");
      const ref = `nodes/${nodeId}/artifacts/${outputName}.json`;
      try { materialized = sameJson(parse(await storage.readRunFile(projectRoot, runId, ref)), artifact); } catch { materialized = false; }
      if (materialized && generationStatus === "accepted") materializedAccepted.push({ nodeId, name: outputName, reference: ref, accepted: true });
      if (isRecord(checkpoint)) {
        const history = isRecord(checkpoint.feedbackRouting) && isRecord(checkpoint.feedbackRouting.regions) && isRecord(checkpoint.feedbackRouting.regions[regionId]) && Array.isArray(checkpoint.feedbackRouting.regions[regionId].generationHistory)
          ? checkpoint.feedbackRouting.regions[regionId].generationHistory as unknown[] : [];
        const entry = history.find((candidate) => isRecord(candidate) && candidate.generationId === generationId);
        if (!isRecord(entry) || entry.status !== generationStatus || entry.sha256 !== digest || entry.attemptPath !== attemptPath) diagnostics.push(`Feedback generation '${generationId}' checkpoint summary differs from its canonical evidence.`);
      }
    } catch (error) {
      valid = false;
      diagnostics.push(`Feedback generation '${generationId}' evidence is damaged or mispointed: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (valid && digest) generationRows.push({ runId, generationId, nodeId, outputName, contract: output!.contract, iteration, status: generationStatus, attemptPath, sha256: digest, materialized });
  }

  // Decision outputs and completed prefix/continuation outputs have no routed generation,
  // so bind them to the latest successful attempt and its current materialization.
  const completed = Array.isArray(checkpointRecord.completedNodes) ? checkpointRecord.completedNodes.filter((id): id is string => typeof id === "string") : [];
  for (const nodeId of completed) {
    const node = nodeDefinitions.get(nodeId);
    if (!node) continue;
    for (const output of Array.isArray(node.expectedOutputs) ? node.expectedOutputs.filter(isRecord) : []) {
      if (typeof output.name !== "string" || typeof output.contract !== "string") continue;
      if (generationOutputKeys.has(`${nodeId}\0${output.name}`)) continue;
      const success = [...events].reverse().find((event) => event.event === "node.succeeded" && event.nodeId === nodeId && Array.isArray(event.artifactNames) && event.artifactNames.includes(output.name));
      if (!success) continue;
      const sequence = Number(success.sequence);
      const start = [...events].reverse().find((event) => event.event === "node.started" && event.nodeId === nodeId && Number(event.sequence) < sequence && Number.isSafeInteger(event.attempt));
      if (!start) continue;
      const attemptPath = `nodes/${nodeId}/attempt-${String(start.attempt).padStart(3, "0")}/result.json`;
      try {
        const result = parse(await storage.readRunFile(projectRoot, runId, attemptPath));
        const artifact = isRecord(result) && Array.isArray(result.artifacts) ? result.artifacts.find((entry) => isRecord(entry) && entry.name === output.name && entry.contract === output.contract) : undefined;
        const reference = `nodes/${nodeId}/artifacts/${output.name}.json`;
        if (isRecord(result) && result.status === "success" && isRecord(artifact) && sameJson(parse(await storage.readRunFile(projectRoot, runId, reference)), artifact)) {
          materializedAccepted.push({ nodeId, name: output.name, reference, accepted: true });
        }
      } catch { /* A missing materialization is reported by the ordinary inspection diagnostics. */ }
    }
  }

  // Ensure mutable history cannot silently add or remove generation identities.
  const checkpointIds = isRecord(state) && Array.isArray(state.generationHistory)
    ? state.generationHistory.filter(isRecord).map((row) => row.generationId).filter((id): id is string => typeof id === "string") : [];
  if (checkpointIds.length !== seen.size || checkpointIds.some((id) => !seen.has(id))) diagnostics.push("Feedback generation set differs from durable generation-created events.");

  const policy = pick(route, ["schemaVersion", "regionId", "startNode", "decisionNode", "decisionOutput", "continuationNode", "routes", "reentrySafeNodes", "limits"]);
  const regionSummary: Record<string, JsonRecord> = {};
  for (const [id, value] of Object.entries(regions)) {
    if (!isRecord(value)) { diagnostics.push(`Feedback region '${id}' checkpoint summary is malformed.`); continue; }
    const entry = events.find((event) => event.event === "feedback.region.started" && event.regionId === id);
    const completion = events.find((event) => event.event === "feedback.region.completed" && event.regionId === id);
    const regionTransitions = events.filter((event) => event.event === "feedback.route.transition" && event.regionId === id);
    const endIndex = workflowNodes.indexOf(String(route.decisionNode));
    const providerCalls = events.filter((event) => event.event === "provider.call.started" && typeof event.nodeId === "string" && workflowNodes.indexOf(event.nodeId) >= startIndex && workflowNodes.indexOf(event.nodeId) <= endIndex).length;
    const lastTransition = regionTransitions.at(-1);
    const eligibleNodes = completion ? [] : Array.isArray(lastTransition?.nodeIds) ? lastTransition.nodeIds : [];
    const reusedPrefix = lastTransition && typeof lastTransition.target === "string"
      ? workflowNodes.slice(0, workflowNodes.indexOf(lastTransition.target))
      : entry ? workflowNodes.slice(0, startIndex) : [];
    const invalidatedSuffixes = regionTransitions.map((transition) => ({ iteration: transition.iteration, target: transition.target, nodeIds: transition.nodeIds }));
    const lastRoute = transitionEvidenceValid ? await readLastRoute(storage, projectRoot, runId, route, regionTransitions, completion, events) : undefined;
    const limits = isRecord(route.limits) ? route.limits : {};
    const iterationUsed = regionTransitions.length + 1;
    const callsReached = Number.isSafeInteger(limits.maxProviderCalls) && providerCalls >= Number(limits.maxProviderCalls);
    const iterationReached = Number.isSafeInteger(limits.maxIterations) && iterationUsed >= Number(limits.maxIterations);
    const terminalLimitFailure = checkpointRecord.status === "error" && events.some((event) => event.event === "run.failed" && event.code === "FEEDBACK_LIMIT_EXCEEDED");
    const elapsedUsed = typeof completion?.elapsedMs === "number" ? completion.elapsedMs : typeof value.elapsedMs === "number" ? value.elapsedMs : null;
    const elapsedReached = Number.isSafeInteger(limits.maxElapsedMs) && (
      (typeof completion?.elapsedMs === "number" && completion.elapsedMs >= Number(limits.maxElapsedMs))
      || (elapsedUsed !== null && elapsedUsed >= Number(limits.maxElapsedMs))
      || (terminalLimitFailure && !iterationReached && !callsReached)
    );
    const derived: JsonRecord = {
      iteration: regionTransitions.length + 1,
      providerCalls,
      ...(typeof entry?.enteredAtMs === "number" ? { enteredAtMs: entry.enteredAtMs } : {}),
      ...(typeof entry?.deadlineAtMs === "number" ? { deadlineAtMs: entry.deadlineAtMs } : {}),
      ...(typeof completion?.completedAtMs === "number" ? { completedAtMs: completion.completedAtMs } : {}),
      ...(typeof completion?.elapsedMs === "number" ? { elapsedMs: completion.elapsedMs } : {}),
      ...(completion ? { elapsedMsStatus: "verified" } : value.elapsedMs !== undefined ? { elapsedMsStatus: "unverified" } : {}),
      eligibleNodes,
      reusedPrefix,
      invalidatedSuffixes,
      ...(lastRoute ? { lastRoute } : {}),
      budget: {
        iteration: { used: iterationUsed, limit: limits.maxIterations, reached: iterationReached },
        providerCalls: { used: providerCalls, limit: limits.maxProviderCalls, reached: callsReached },
        elapsedMs: { ...(elapsedUsed === null ? {} : { used: elapsedUsed }), limit: limits.maxElapsedMs, reached: elapsedReached, usageStatus: completion ? "verified" : elapsedUsed === null ? "unavailable" : "checkpoint-reported" },
      },
    };
    for (const key of ["iteration", "providerCalls", "enteredAtMs", "deadlineAtMs", "completedAtMs", "elapsedMs", "eligibleNodes", "reusedPrefix", "invalidatedSuffixes"]) {
      if (key === "elapsedMs" && !completion) continue;
      if (value[key] !== undefined && !sameJson(value[key], derived[key])) diagnostics.push(`Feedback region '${id}' checkpoint ${key} differs from its durable event ledger.`);
    }
    regionSummary[id] = derived;
  }
  return {
    feedbackRouting: { policy, regions: regionSummary, artifactGenerations: generationRows },
    currentArtifacts: dedupeArtifacts(materializedAccepted),
    diagnostics,
  };
}

export function feedbackGenerationStatusByAttempt(summary: FeedbackInspection["feedbackRouting"]): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of summary?.artifactGenerations ?? []) {
    if (typeof row.nodeId === "string" && typeof row.attemptPath === "string" && typeof row.status === "string") {
      const match = /\/attempt-(\d+)\/result\.json$/.exec(row.attemptPath);
      if (match) result.set(`${row.nodeId}\0${Number(match[1])}`, row.status);
    }
  }
  return result;
}

function dedupeArtifacts(rows: FeedbackInspection["currentArtifacts"]): FeedbackInspection["currentArtifacts"] {
  const map = new Map(rows.map((row) => [row.nodeId + "\0" + row.name, row]));
  return [...map.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.name.localeCompare(right.name));
}
function expectedGenerationAttemptPath(events: JsonRecord[], nodeId: string, outputName: string, generationSequence: number): string | undefined {
  if (!Number.isSafeInteger(generationSequence)) return undefined;
  const start = [...events].reverse().find((event) => event.event === "node.started" && event.nodeId === nodeId
    && Number.isSafeInteger(event.sequence) && Number(event.sequence) < generationSequence
    && Number.isSafeInteger(event.attempt) && Number(event.attempt) > 0);
  if (!start) return undefined;
  const nextStart = events.find((event) => event.event === "node.started" && event.nodeId === nodeId
    && Number.isSafeInteger(event.sequence) && Number(event.sequence) > generationSequence);
  const success = events.find((event) => event.event === "node.succeeded" && event.nodeId === nodeId
    && Number.isSafeInteger(event.sequence) && Number(event.sequence) > generationSequence
    && (!nextStart || Number(event.sequence) < Number(nextStart.sequence))
    && Array.isArray(event.artifactNames) && event.artifactNames.includes(outputName));
  if (!success) return undefined;
  return `nodes/${nodeId}/attempt-${String(start.attempt).padStart(3, "0")}/result.json`;
}
async function readLastRoute(
  storage: IntakeStorage,
  projectRoot: string,
  runId: string,
  route: JsonRecord,
  transitions: JsonRecord[],
  completion: JsonRecord | undefined,
  events: JsonRecord[],
): Promise<JsonRecord | undefined> {
  const iteration = transitions.length + 1;
  const lastTransition = transitions.at(-1);
  if (!completion && lastTransition && typeof lastTransition.target === "string" && isRecord(lastTransition.feedback) && typeof lastTransition.feedback.decisionCode === "string") {
    return { decisionCode: lastTransition.feedback.decisionCode, target: lastTransition.target, iteration: Number(lastTransition.iteration) };
  }
  if (!completion || typeof route.decisionNode !== "string" || !isRecord(route.decisionOutput) || typeof route.decisionOutput.name !== "string" || !isRecord(route.routes)) return undefined;
  const decisionOutputName = route.decisionOutput.name;
  const decisionNodeId = route.decisionNode;
  const routes = route.routes;
  const decision = [...events].reverse().find((event) => event.event === "node.succeeded" && event.nodeId === decisionNodeId && Array.isArray(event.artifactNames) && event.artifactNames.includes(decisionOutputName));
  if (!decision || !Number.isSafeInteger(decision.sequence)) return undefined;
  const started = [...events].reverse().find((event) => event.event === "node.started" && event.nodeId === decisionNodeId && Number(event.sequence) < Number(decision.sequence) && Number.isSafeInteger(event.attempt));
  if (!started) return undefined;
  try {
    const result = parse(await storage.readRunFile(projectRoot, runId, `nodes/${decisionNodeId}/attempt-${String(started.attempt).padStart(3, "0")}/result.json`));
    const artifact = isRecord(result) && Array.isArray(result.artifacts) ? result.artifacts.find((item) => isRecord(item) && item.name === decisionOutputName) : undefined;
    const code = isRecord(artifact) && isRecord(artifact.data) && typeof artifact.data.decisionCode === "string" ? artifact.data.decisionCode : undefined;
    const target = code ? routes[code] : undefined;
    return typeof code === "string" && typeof target === "string" ? { decisionCode: code, target, iteration } : undefined;
  } catch { return undefined; }
}
function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function parse(raw: string): unknown { return JSON.parse(raw) as unknown; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function pick(value: unknown, keys: string[]): JsonRecord { return isRecord(value) ? Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) : {}; }

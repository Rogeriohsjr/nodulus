import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import type { IntakeStorage } from "./ports/intake-storage.js";
import { NodulusError } from "./shared/nodulus-error.js";
import type { FeedbackRoutingDefinition } from "./feedback-definition.js";
import type { FeedbackRegionState } from "./feedback-routing.js";

type Checkpoint = {
  runId: string;
  status: string;
  activeNode: string | null;
  completedNodes: string[];
  attempt: number;
  requestId?: string;
  pendingKind?: string | null;
  pendingNodeId?: string;
  feedbackRouting?: { regions?: Record<string, FeedbackRegionState> };
};
type Definition = {
  workflow: { nodes: string[]; inputs?: Record<string, { contract: string }>; feedbackRouting?: FeedbackRoutingDefinition };
  nodes: Array<{ id: string; expectedOutputs: Array<{ name: string; contract: string }> }>;
  contracts: Record<string, unknown>;
};
type CapturedInputs = { callerInputs?: Record<string, unknown> };
type Event = Record<string, unknown> & { event?: string };

/** Validate the saved execution ledger before resume probes providers or mutates the run. */
export async function validateFeedbackResumeEvidence(
  storage: IntakeStorage,
  projectRoot: string,
  runId: string,
  checkpoint: Checkpoint,
  definitions: Definition,
  pending: Record<string, unknown>,
): Promise<void> {
  if (checkpoint.pendingKind !== undefined && checkpoint.pendingKind !== null && checkpoint.pendingKind !== "node" && checkpoint.pendingKind !== "caller_inputs") {
    invalid("RUN_STATE_INVALID", "Paused checkpoint contains an unsupported pending kind.");
  }
  const nodes = definitions.workflow.nodes;
  const pendingKind = checkpoint.pendingKind ?? "node";
  if (pendingKind === "caller_inputs") {
    await validateCallerInputPause(storage, projectRoot, runId, checkpoint, definitions, pending);
    return;
  }
  const nodeId = checkpoint.pendingNodeId ?? checkpoint.activeNode;
  const index = nodeId ? nodes.indexOf(nodeId) : -1;
  if (index < 0 || checkpoint.activeNode !== nodeId || !Array.isArray(checkpoint.completedNodes) || checkpoint.completedNodes.some((id, at) => id !== nodes[at]) || checkpoint.completedNodes.length !== index) {
    invalid("RUN_STATE_INVALID", "Paused node and completed prefix do not match the captured workflow order.");
  }
  if (pending.id !== checkpoint.requestId) invalid("RUN_STATE_INVALID", "Pending request identity does not match the paused node checkpoint.");

  const lines = await readRequired(storage, projectRoot, runId, "events.jsonl");
  let events: Event[];
  try { events = lines.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Event); }
  catch { invalid("RUN_STATE_INVALID", "Run event history is invalid."); }
  const started = new Map<string, Event>();
  const completed = new Set<string>();
  for (const event of events!) {
    if (event.event === "provider.call.started" && typeof event.callId === "string") started.set(event.callId, event);
    if (event.event === "provider.call.completed" && typeof event.callId === "string") completed.add(event.callId);
  }
  for (const callId of started.keys()) if (!completed.has(callId)) invalid("RUN_RECOVERY_REQUIRED", `Provider call '${callId}' has no completion event; automatic replay is unsafe.`);

  const startedAttempts = new Map<string, number>();
  for (const event of events!) if (event.event === "node.started" && typeof event.nodeId === "string" && Number.isSafeInteger(event.attempt)) {
    startedAttempts.set(event.nodeId, Math.max(startedAttempts.get(event.nodeId) ?? 0, event.attempt as number));
  }
  if (startedAttempts.get(nodeId!) !== checkpoint.attempt) invalid("RUN_STATE_INVALID", "Paused attempt does not match the node execution high-water mark.");
  const pauseEvent = [...events!].reverse().find((event) => event.event === "node.needs_input" && event.nodeId === nodeId && event.requestId === pending.id);
  if (!pauseEvent) invalid("RUN_STATE_INVALID", "The pending request has no matching node pause event.");
  const attemptRoot = `nodes/${nodeId}/attempt-${String(checkpoint.attempt).padStart(3, "0")}`;
  const attemptResult = parseJson(await readRequired(storage, projectRoot, runId, `${attemptRoot}/result.json`), "paused attempt result");
  const pause = attemptResult as Record<string, unknown>;
  const savedRequest = pause.request;
  if (pause.status !== "needs_input" || !sameJson(savedRequest, pending) || (pauseEvent.requestId !== pending.id)) invalid("RUN_STATE_INVALID", "Pending request differs from the immutable paused attempt result.");

  const route = definitions.workflow.feedbackRouting;
  if (!route) return;
  const start = nodes.indexOf(route.startNode);
  const decision = nodes.indexOf(route.decisionNode);
  const regionState = checkpoint.feedbackRouting?.regions?.[route.regionId];
  const pendingIsRegion = index >= start && index <= decision;
  if (!regionState) invalid("FEEDBACK_STATE_INVALID", pendingIsRegion ? "An in-region pause is missing its feedback checkpoint." : "A routed workflow pause is missing its feedback checkpoint.");
  if (!regionState) return;
  validateRegionState(regionState, route);
  const entered = events!.find((event) => event.event === "feedback.region.started" && event.regionId === route.regionId);
  if (regionState.enteredAtMs !== undefined && (!entered || entered.enteredAtMs !== regionState.enteredAtMs || entered.deadlineAtMs !== regionState.deadlineAtMs)) invalid("FEEDBACK_STATE_INVALID", "Feedback region entry evidence does not match its checkpoint.");
  if (regionState.enteredAtMs === undefined && entered) invalid("FEEDBACK_STATE_INVALID", "Feedback checkpoint omits its recorded region entry.");
  const completions = events!.filter((event) => event.event === "feedback.region.completed" && event.regionId === route.regionId);
  if (regionState.completedAtMs === undefined) {
    if (completions.length !== 0) invalid("FEEDBACK_STATE_INVALID", "Feedback completion evidence is absent from the checkpoint.");
  } else if (completions.length !== 1 || completions[0].completedAtMs !== regionState.completedAtMs
    || completions[0].elapsedMs !== regionState.elapsedMs
    || regionState.elapsedMs !== regionState.completedAtMs - (regionState.enteredAtMs as number)) {
    invalid("FEEDBACK_STATE_INVALID", "Feedback completion time differs from its durable completion evidence.");
  }

  const regionCalls = events!.filter((event) => event.event === "provider.call.started" && typeof event.nodeId === "string" && nodes.indexOf(event.nodeId) >= start && nodes.indexOf(event.nodeId) <= decision).length;
  if (regionState.providerCalls !== regionCalls) invalid("FEEDBACK_STATE_INVALID", "Feedback provider-call count does not match the durable call ledger.");
  const created = events!.filter((event) => event.event === "feedback.generation.created" && event.regionId === route.regionId);
  const historyIds = regionState.generationHistory.map((generation) => generation.generationId);
  const eventIds = created.map((event) => event.generationId);
  if (new Set(historyIds).size !== historyIds.length || !sameJson([...historyIds].sort((left, right) => String(left).localeCompare(String(right))), [...eventIds].sort((left, right) => String(left).localeCompare(String(right))))) invalid("FEEDBACK_STATE_INVALID", "Feedback generation set differs from durable generation-created evidence.");
  for (const generation of regionState.generationHistory) {
    const event = created.find((candidate) => candidate.generationId === generation.generationId);
    if (!event || event.nodeId !== generation.nodeId || event.outputName !== generation.outputName || event.iteration !== generation.iteration || event.attemptPath !== generation.attemptPath) invalid("FEEDBACK_STATE_INVALID", "Feedback generation differs from its durable creation event.");
  }
  const reroutes = events!.filter((event) => event.event === "feedback.route.transition" && event.regionId === route.regionId);
  const invalidatedIds = new Set<string>();
  const knownGenerations = new Map<string, string>();
  let createdIndex = 0;
  for (const event of reroutes) {
    if (!Array.isArray(event.invalidatedGenerationIds) || !Array.isArray(event.nodeIds) || !Number.isSafeInteger(event.iteration)) invalid("FEEDBACK_STATE_INVALID", "Feedback transition evidence is malformed.");
    while (createdIndex < created.length && Number(created[createdIndex].sequence) < Number(event.sequence)) {
      const generated = created[createdIndex++];
      if (typeof generated.generationId !== "string" || typeof generated.nodeId !== "string") invalid("FEEDBACK_STATE_INVALID", "Feedback generation event is malformed.");
      knownGenerations.set(generated.generationId, generated.nodeId);
    }
    const targetIndex = typeof event.target === "string" ? nodes.indexOf(event.target) : -1;
    const expectedSuffix = targetIndex < 0 ? [] : nodes.slice(targetIndex, decision + 1);
    if (event.iteration !== reroutes.indexOf(event) + 2 || !sameJson(event.nodeIds, expectedSuffix)) invalid("FEEDBACK_STATE_INVALID", "Feedback route transition does not match the captured node order.");
    const expectedInvalidations = [...knownGenerations].filter(([id, node]) => expectedSuffix.includes(node) && !invalidatedIds.has(id)).map(([id]) => id);
    if (!sameJson(event.invalidatedGenerationIds, expectedInvalidations)) invalid("FEEDBACK_STATE_INVALID", "Feedback transition invalidation set differs from accepted generation history.");
    for (const id of event.invalidatedGenerationIds as unknown[]) if (typeof id === "string") invalidatedIds.add(id);
  }
  if (regionState.iteration !== reroutes.length + 1 || regionState.invalidatedSuffixes.length !== reroutes.length) invalid("FEEDBACK_STATE_INVALID", "Feedback iteration history does not match durable route transitions.");
  for (const [at, event] of reroutes.entries()) {
    const suffix = regionState.invalidatedSuffixes[at];
    if (!sameJson(suffix, { iteration: event.iteration, target: event.target, nodeIds: event.nodeIds })) invalid("FEEDBACK_STATE_INVALID", "Saved invalidation history differs from durable route transitions.");
  }
  const lastTransition = reroutes.at(-1);
  if (lastTransition && !sameJson(regionState.feedback, lastTransition.feedback)) invalid("FEEDBACK_STATE_INVALID", "Saved feedback differs from the last durable route transition.");
  const expectedEligible = regionState.completedAtMs !== undefined ? [] : Array.isArray(lastTransition?.nodeIds) ? lastTransition.nodeIds : [];
  const expectedReused = lastTransition && typeof lastTransition.target === "string"
    ? nodes.slice(0, nodes.indexOf(lastTransition.target))
    : regionState.enteredAtMs === undefined ? [] : stateEntryPrefix(nodes, route.startNode);
  if (!sameJson(regionState.eligibleNodes, expectedEligible) || !sameJson(regionState.reusedPrefix, expectedReused)) invalid("FEEDBACK_STATE_INVALID", "Feedback prefix and eligible-node state differs from durable route evidence.");
  for (const generation of regionState.generationHistory) {
    const generationId = generation.generationId;
    if (typeof generationId !== "string" || !generationId) invalid("FEEDBACK_STATE_INVALID", "Feedback generation identity is malformed.");
    if (!Number.isSafeInteger(generation.iteration) || Number(generation.iteration) > regionState.iteration) invalid("FEEDBACK_STATE_INVALID", "Feedback generation iteration exceeds the saved routing iteration.");
    const derivedStatus = invalidatedIds.has(generationId) ? "invalidated" : "accepted";
    if (generation.status !== derivedStatus) invalid("FEEDBACK_STATE_INVALID", "Feedback generation status differs from durable invalidation evidence.");
    await validateGeneration(storage, projectRoot, runId, route.regionId, generation, nodes, definitions.nodes, derivedStatus);
  }
}

async function validateCallerInputPause(storage: IntakeStorage, projectRoot: string, runId: string, checkpoint: Checkpoint, definitions: Definition, pending: Record<string, unknown>): Promise<void> {
  if (checkpoint.activeNode !== null || !Array.isArray(checkpoint.completedNodes) || checkpoint.completedNodes.length !== 0 || checkpoint.attempt !== 0 || pending.id !== checkpoint.requestId || checkpoint.feedbackRouting !== undefined) invalid("RUN_STATE_INVALID", "Caller-input pause checkpoint is inconsistent.");
  const eventsText = await readRequired(storage, projectRoot, runId, "events.jsonl");
  let events: Event[];
  try { events = eventsText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Event); }
  catch { invalid("RUN_STATE_INVALID", "Caller-input pause event history is invalid."); }
  const requestId = pending.id;
  if (!events!.some((event) => event.event === "run.needs_input" && event.kind === "caller_inputs" && event.requestId === requestId)
    || events!.some((event) => event.event === "node.started" || event.event === "node.needs_input" || event.event === "provider.call.started" || event.event === "feedback.region.started" || event.event === "feedback.route.transition")) {
    invalid("RUN_STATE_INVALID", "Caller-input pause is not supported by the saved execution event history.");
  }
  let inputs: CapturedInputs;
  try { inputs = JSON.parse(await storage.readRunFile(projectRoot, runId, "inputs.json")) as CapturedInputs; }
  catch { invalid("RUN_STATE_INVALID", "Caller-input pause has invalid captured inputs."); }
  const missing: Array<{ name: string; contract: string }> = [];
  for (const [name, declaration] of Object.entries(definitions.workflow.inputs ?? {})) {
    const schema = definitions.contracts[declaration.contract];
    let valid = Object.hasOwn(inputs!.callerInputs ?? {}, name) && schema !== undefined;
    if (valid) {
      try { valid = Boolean(new Ajv2020({ strict: false }).compile(schema as AnySchema)((inputs!.callerInputs ?? {})[name])); }
      catch { valid = false; }
    }
    if (!valid) missing.push({ name, contract: declaration.contract });
  }
  if (missing.length === 0) invalid("RUN_STATE_INVALID", "Captured workflow has no missing caller input to justify this pause.");
  const expected = {
    id: requestId,
    questions: missing.map(({ name }) => ({ id: name, message: `Provide the required '${name}' input.` })),
    answerContract: {
      type: "object",
      required: missing.map(({ name }) => name),
      properties: Object.fromEntries(missing.map(({ name, contract }) => [name, { $ref: `#/$defs/${contract}` }])),
      additionalProperties: false,
      $defs: definitions.contracts,
    },
  };
  if (!sameJson(pending, expected)) invalid("RUN_STATE_INVALID", "Pending caller-input request differs from the captured missing-input contract.");
}

async function validateGeneration(storage: IntakeStorage, projectRoot: string, runId: string, regionId: string, generation: Record<string, unknown>, workflowNodes: string[], nodeDefinitions: Definition["nodes"], status: string): Promise<void> {
  const nodeId = String(generation.nodeId);
  const outputName = String(generation.outputName);
  const attemptPath = generation.attemptPath;
  const attemptMatch = typeof attemptPath === "string" ? /^nodes\/(.+)\/attempt-(\d+)\/result\.json$/.exec(attemptPath) : null;
  if (generation.runId !== runId || !Number.isSafeInteger(generation.iteration) || !workflowNodes.includes(nodeId) || !attemptMatch || attemptMatch[1] !== nodeId || !Number.isSafeInteger(Number(attemptMatch[2])) || Number(attemptMatch[2]) < 1) invalid("FEEDBACK_STATE_INVALID", "Feedback generation identity or attempt path is malformed.");
  const expected = nodeDefinitions.find((node) => node.id === nodeId)?.expectedOutputs.find((output) => output.name === outputName);
  if (!expected || expected.contract !== generation.contract) invalid("FEEDBACK_STATE_INVALID", "Feedback generation does not match a declared output.");
  const manifestPath = `feedback/${regionId}/generations/${generation.generationId as string}.json`;
  const manifest = parseJson(await readRequired(storage, projectRoot, runId, manifestPath), "feedback generation manifest") as Record<string, unknown>;
  const identity = { runId, regionId, nodeId, outputName, contract: expected.contract, iteration: generation.iteration, attemptPath, generationId: generation.generationId };
  for (const [key, value] of Object.entries(identity)) {
    if (manifest[key] !== value || (key !== "regionId" && generation[key] !== value)) invalid("FEEDBACK_STATE_INVALID", "Feedback generation differs from its immutable identity manifest.");
  }
  const result = parseJson(await readRequired(storage, projectRoot, runId, attemptPath as string), "accepted attempt result") as { status?: unknown; artifacts?: unknown };
  if (result.status !== "success" || !Array.isArray(result.artifacts)) invalid("FEEDBACK_STATE_INVALID", "Feedback generation points to an unsuccessful attempt.");
  const artifact = (result.artifacts as Array<Record<string, unknown>>).find((entry) => entry.name === outputName);
  if (!artifact || artifact.contract !== expected.contract) invalid("FEEDBACK_STATE_INVALID", "Feedback generation is absent from its accepted attempt result.");
  const digest = sha256(artifact.data);
  if (generation.sha256 !== digest || manifest.sha256 !== digest) invalid("FEEDBACK_STATE_INVALID", "Feedback generation digest differs from its accepted attempt payload.");
  if (status === "accepted") {
    const materialized = parseJson(await readRequired(storage, projectRoot, runId, `nodes/${nodeId}/artifacts/${outputName}.json`), "accepted artifact materialization");
    if (!sameJson(materialized, artifact)) invalid("FEEDBACK_STATE_INVALID", "Accepted artifact materialization differs from its attempt result.");
  }
}

function validateRegionState(state: FeedbackRegionState, route: FeedbackRoutingDefinition): void {
  if (!Number.isSafeInteger(state.iteration) || state.iteration < 1 || state.iteration > route.limits.maxIterations
    || !Number.isSafeInteger(state.providerCalls) || (state.providerCalls ?? -1) < 0
    || !Array.isArray(state.generationHistory) || !Array.isArray(state.invalidatedSuffixes)
    || !Array.isArray(state.reusedPrefix) || !Array.isArray(state.eligibleNodes)) invalid("FEEDBACK_STATE_INVALID", "Feedback checkpoint fields are malformed or exceed the captured definition.");
  if (state.enteredAtMs === undefined) {
    if (state.deadlineAtMs !== undefined || state.completedAtMs !== undefined || state.iteration !== 1 || state.invalidatedSuffixes.length !== 0) invalid("FEEDBACK_STATE_INVALID", "Feedback checkpoint has routing data without a region entry.");
    return;
  }
  if (!Number.isFinite(state.enteredAtMs) || !Number.isFinite(state.deadlineAtMs) || state.deadlineAtMs !== state.enteredAtMs + route.limits.maxElapsedMs
    || (state.completedAtMs !== undefined && (!Number.isFinite(state.completedAtMs) || state.completedAtMs < state.enteredAtMs))) invalid("FEEDBACK_STATE_INVALID", "Feedback deadline or completion time does not match the captured definition.");
}

async function readRequired(storage: IntakeStorage, projectRoot: string, runId: string, relativePath: string): Promise<string> {
  try { return await storage.readRunFile(projectRoot, runId, relativePath); }
  catch (error) { invalid("FEEDBACK_STATE_INVALID", `Required feedback evidence '${relativePath}' is unavailable: ${messageOf(error)}`); }
}
function parseJson(raw: string, label: string): unknown {
  try { return JSON.parse(raw) as unknown; }
  catch { invalid("FEEDBACK_STATE_INVALID", `${label} is invalid JSON.`); }
}
function sha256(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function stateEntryPrefix(nodes: string[], startNode: string): string[] { return nodes.slice(0, nodes.indexOf(startNode)); }
function invalid(code: string, message: string): never { throw new NodulusError(code, message); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

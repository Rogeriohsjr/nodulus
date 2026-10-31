import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { resumeWorkflow, runWorkflow, type ApplicationRunResult, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type Outcome = { kind: "result"; result: ApplicationRunResult } | { kind: "error"; error: unknown };
type Role = "seed" | "d" | "a" | "b" | "c";
type Call = { nodeId: Role; callId: string; attempt: number; parentCallId: string | null; answers: Record<string, unknown> };
type Marker = { nodeId: Role; role: Role; runId: string; callId: string; attempt: number; pid: number; promptAnswers: Record<string, unknown> };
type Request = { id: string; nodeId: Role; callId: string; attempt: number; questions: Array<{ id: string; message: string }>; answerContract: Record<string, unknown> };
type AcceptedManifest = { attempt: number; callId: string; resultRef: string; resultSha256: string; validationRef: string; validationSha256: string; responseRef: string; responseSha256: string; artifacts: Array<{ name: string; contract: string; ref: string; sha256: string }> };
type Checkpoint = { runId: string; status: string; completedNodes: string[]; graph: { admissionClosed?: boolean; nextEventSequence: number; nodes: Record<string, { phase?: string; attempt?: number; callId?: string; accepted?: AcceptedManifest }>; pendingRequests: Record<string, Record<string, unknown>> } };
type Files = Map<string, Buffer>;
type AcceptedSnapshot = { files: Files; manifest: AcceptedManifest };
type Observation = { availability: string[]; invocations: Call[]; repairs: number; telemetry: string[]; launches: string[]; legacyUsage: number; delegated: Promise<void>[] };
type State = { directory: string; events: string; started: Record<string, string>; releases: Record<string, string> };

const fixtureSource = fileURLToPath(new URL("../fixtures/par-035-queued-answer-provider.mjs", import.meta.url));
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;

test("PAR-035 resumes an answered resource-blocked question across a later pause without losing its continuation", async () => {
  await exerciseQueuedContinuation();
}, 35_000);

async function exerciseQueuedContinuation(): Promise<void> {
  const deadline = Date.now() + scenarioBudgetMs;
  const label = "par-035-queued-answer-café";
  const project = createInitializedProject(label);
  const identity = realpathSync.native(project);
  const state = makeState(project);
  const observation: Observation = { availability: [], invocations: [], repairs: 0, telemetry: [], launches: [], legacyUsage: 0, delegated: [] };
  const publicOperations: Promise<Outcome>[] = [];
  const cleanupErrors: Error[] = [];
  let primaryError: unknown;
  let hasPrimaryError = false;
  let runId: string | undefined;

  try {
    assertOwnedProject(project, identity, label);
    const sentinels = configureProject(project, state);
    assertBefore(deadline, "project setup");

    let initialSettled: Outcome | undefined;
    const initial = capture(runWorkflow(runRequest(project), observe(project, observation)), publicOperations);
    void initial.then((outcome) => { initialSettled = outcome; });
    const seedMarker = await waitMarker(state, "seed-1", deadline, () => initialSettled);
    runId = seedMarker.runId;
    assertLive(seedMarker, "seed");
    release(state, "seed-1");
    await waitFor(() => checkpointIfReady(project, runId!)?.graph.nodes.seed?.phase === "accepted", deadline, "seed acceptance", () => initialSettled);

    const dMarkerPromise = waitMarker(state, "d-1", deadline, () => initialSettled);
    const a1MarkerPromise = waitMarker(state, "a-1", deadline, () => initialSettled);
    const b1MarkerPromise = waitMarker(state, "b-1", deadline, () => initialSettled);
    const [dMarker, a1Marker, b1Marker] = await withDeadline(Promise.all([dMarkerPromise, a1MarkerPromise, b1MarkerPromise]), deadline, "D/A/B initial barriers");
    for (const marker of [dMarker, a1Marker, b1Marker]) assertLive(marker, `${marker.nodeId} attempt 1`);
    expect(dMarker.runId).toBe(runId);
    expect(a1Marker.runId).toBe(runId);
    expect(b1Marker.runId).toBe(runId);
    expect(existsSync(state.started["c-1"]!)).toBe(false);
    expect(readCheckpoint(project, runId).graph.nodes).toMatchObject({ d: { phase: "active" }, a: { phase: "active" }, b: { phase: "active" }, c: { phase: "not_started" } });

    release(state, "a-1");
    release(state, "b-1");
    const a1 = await waitForQuestion(project, runId, "a", 1, deadline, () => initialSettled);
    const b1 = await waitForQuestion(project, runId, "b", 1, deadline, () => initialSettled);
    expect(a1.answerContract).toMatchObject({ required: ["aFirst"] });
    expect(b1.answerContract).toMatchObject({ required: ["bFirst"] });
    const draining = readCheckpoint(project, runId);
    expect(draining.graph.admissionClosed).toBe(true);
    expect(draining.graph.nodes).toMatchObject({ d: { phase: "active", callId: dMarker.callId }, a: { phase: "pending", callId: a1.callId }, b: { phase: "pending", callId: b1.callId } });
    expect(isLive(dMarker.pid)).toBe(true);
    release(state, "d-1");

    const initialResult = requireResult(await withDeadline(initial, deadline, "initial drained pause"), "initial pause");
    expect(initialResult.status).toBe("needs_input");
    expect(initialResult.runId).toBe(runId);
    expect(requests(initialResult.result)).toEqual([a1, b1]);
    expect(readCheckpoint(project, runId).graph.nodes).toMatchObject({ seed: { phase: "accepted" }, d: { phase: "accepted" }, c: { phase: "not_started" }, a: { phase: "pending" }, b: { phase: "pending" } });
    const initialState = capturePause(project, runId);
    const acceptedSeed = captureAccepted(project, runId, "seed");
    const acceptedD = captureAccepted(project, runId, "d");
    const initialInputs = readBytes(runFile(project, runId, "inputs.json"));
    expect(initialState.metrics).toHaveLength(4);
    expect(sorted(observation.availability)).toEqual(["a", "b", "d", "seed"]);
    expect(readPauseIds(project, runId)).toEqual([a1.id, b1.id]);
    assertQuestion(project, runId, a1);
    assertQuestion(project, runId, b1);
    assertPrompt(state, seedMarker, {});
    assertPrompt(state, dMarker, {});
    assertPrompt(state, a1Marker, {});
    assertPrompt(state, b1Marker, {});

    const beforePartialMethods = snapshotMethods(observation);
    const partial = requireResult(await withDeadline(capture(resumeWorkflow({ projectRoot: project, runId, requestId: a1.id, answers: { aFirst: "a-one" } }, observe(project, observation)), publicOperations), deadline, "partial A answer"), "partial A answer");
    expect(partial.status).toBe("needs_input");
    expect(requests(partial.result)).toEqual([b1]);
    expect(snapshotMethods(observation)).toEqual(beforePartialMethods);
    const afterPartial = capturePause(project, runId);
    expect(afterPartial.events.slice(0, initialState.events.length)).toEqual(initialState.events);
    const partialEvents = afterPartial.events.slice(initialState.events.length);
    expect(partialEvents.filter((event) => event.event === "request.answered" && event.requestId === a1.id)).toHaveLength(1);
    expect(partialEvents.filter((event) => event.event !== "request.answered" || event.requestId !== a1.id)).toEqual([]);
    assertAppendedSequences(afterPartial.events, initialState.events.length, initialState.nextEventSequence);
    expect(afterPartial.metricBytes).toEqual(initialState.metricBytes);
    assertFiles(project, runId, initialState.immutable);
    assertAccepted(project, runId, "seed", acceptedSeed);
    assertAccepted(project, runId, "d", acceptedD);

    const secondAvailabilityStart = observation.availability.length;
    let secondSettled: Outcome | undefined;
    const second = capture(resumeWorkflow({ projectRoot: project, runId, requestId: b1.id, answers: { bFirst: "b-one" } }, observe(project, observation)), publicOperations);
    void second.then((outcome) => { secondSettled = outcome; });
    const a2MarkerPromise = waitMarker(state, "a-2", deadline, () => secondSettled);
    const c1MarkerPromise = waitMarker(state, "c-1", deadline, () => secondSettled);
    const [a2Marker, c1Marker] = await withDeadline(Promise.all([a2MarkerPromise, c1MarkerPromise]), deadline, "A2/C1 barriers with B resource held");
    assertLive(a2Marker, "A attempt 2");
    assertLive(c1Marker, "C attempt 1");
    expect(a2Marker.runId).toBe(runId);
    expect(c1Marker.runId).toBe(runId);
    expect(existsSync(state.started["b-2"]!)).toBe(false);
    const heldCheckpoint = readCheckpoint(project, runId);
    expect(heldCheckpoint.graph.nodes).toMatchObject({ a: { phase: "active", callId: a2Marker.callId }, c: { phase: "active", callId: c1Marker.callId }, b: { phase: "pending", callId: b1.callId }, d: { phase: "accepted" } });
    expect(heldCheckpoint.graph.pendingRequests[b1.id]).toMatchObject({ answerRef: `answers/${b1.id}.json` });
    expect(sorted(observation.availability.slice(secondAvailabilityStart))).toEqual(["a", "c"]);
    expect(observation.invocations.some((call) => call.nodeId === "b" && call.attempt === 2)).toBe(false);
    expect(observation.invocations.map((call) => `${call.nodeId}/${call.attempt}`).sort(compareStrings)).toEqual(["a/1", "a/2", "b/1", "c/1", "d/1", "seed/1"]);
    assertPrompt(state, a2Marker, { aFirst: "a-one" });
    assertPrompt(state, c1Marker, {});
    release(state, "a-2");
    const a2 = await waitForQuestion(project, runId, "a", 2, deadline, () => secondSettled);
    expect(a2.answerContract).toMatchObject({ required: ["aSecond"] });
    const whileC = readCheckpoint(project, runId);
    expect(whileC.graph.nodes).toMatchObject({ a: { phase: "pending", callId: a2.callId }, c: { phase: "active", callId: c1Marker.callId }, b: { phase: "pending", callId: b1.callId } });
    expect(whileC.graph.pendingRequests[b1.id]).toMatchObject({ answerRef: `answers/${b1.id}.json` });
    expect(existsSync(state.started["b-2"]!)).toBe(false);
    release(state, "c-1");

    const secondResult = requireResult(await withDeadline(second, deadline, "A2 pause after C drains"), "A2 pause");
    expect(secondResult.status).toBe("needs_input");
    expect(requests(secondResult.result)).toEqual([a2]);
    expect(readPauseIds(project, runId)).toEqual([a2.id]);
    const secondState = capturePause(project, runId);
    const acceptedC = captureAccepted(project, runId, "c");
    expect(readCheckpoint(project, runId).graph.nodes).toMatchObject({ seed: { phase: "accepted" }, d: { phase: "accepted" }, c: { phase: "accepted" }, a: { phase: "pending", callId: a2.callId }, b: { phase: "pending", callId: b1.callId } });
    expect(readCheckpoint(project, runId).graph.pendingRequests[b1.id]).toMatchObject({ answerRef: `answers/${b1.id}.json` });
    expect(sorted(observation.availability.slice(secondAvailabilityStart))).toEqual(["a", "c"]);
    expect(secondState.events.slice(0, initialState.events.length)).toEqual(initialState.events);
    assertAppendedSequences(secondState.events, initialState.events.length, initialState.nextEventSequence);
    expect(secondState.metrics).toHaveLength(6);
    expect(secondState.metrics.slice(0, initialState.metrics.length)).toEqual(initialState.metrics);
    expect(readBytes(runFile(project, runId, "inputs.json"))).toEqual(initialInputs);
    assertFiles(project, runId, initialState.immutable);
    assertAccepted(project, runId, "seed", acceptedSeed);
    assertAccepted(project, runId, "d", acceptedD);
    assertAccepted(project, runId, "c", acceptedC);
    assertFiles(project, runId, secondState.immutable);
    assertAnswer(project, runId, a1, { aFirst: "a-one" });
    assertAnswer(project, runId, b1, { bFirst: "b-one" });
    assertCall(project, runId, a2Marker, a1.callId);
    assertCall(project, runId, c1Marker);

    const finalAvailabilityStart = observation.availability.length;
    let finalSettled: Outcome | undefined;
    const finalPromise = capture(resumeWorkflow({ projectRoot: project, runId, requestId: a2.id, answers: { aSecond: "a-two" } }, observe(project, observation)), publicOperations);
    void finalPromise.then((outcome) => { finalSettled = outcome; });
    const a3MarkerPromise = waitMarker(state, "a-3", deadline, () => finalSettled);
    const b2MarkerPromise = waitMarker(state, "b-2", deadline, () => finalSettled);
    const [a3Marker, b2Marker] = await withDeadline(Promise.all([a3MarkerPromise, b2MarkerPromise]), deadline, "A3/B2 final continuation barriers");
    assertLive(a3Marker, "A attempt 3");
    assertLive(b2Marker, "B attempt 2");
    expect(a3Marker.runId).toBe(runId);
    expect(b2Marker.runId).toBe(runId);
    assertPrompt(state, a3Marker, { aFirst: "a-one", aSecond: "a-two" });
    assertPrompt(state, b2Marker, { bFirst: "b-one" });
    expect(sorted(observation.availability.slice(finalAvailabilityStart))).toEqual(["a", "b"]);
    expect(observation.invocations.filter((call) => call.nodeId === "seed" || call.nodeId === "d" || call.nodeId === "c")).toHaveLength(3);
    release(state, "a-3");
    release(state, "b-2");
    const finalResult = requireResult(await withDeadline(finalPromise, deadline, "final graph success"), "final graph success");
    expect(finalResult.status).toBe("success");
    expect(finalResult.runId).toBe(runId);
    expect(outputArtifacts(finalResult.result)).toEqual([
      { name: "aResult", contract: "report.v1", data: { text: "a-one+a-two" } },
      { name: "bResult", contract: "report.v1", data: { text: "b-one" } },
    ]);
    const finalCheckpoint = readCheckpoint(project, runId);
    expect(finalCheckpoint.completedNodes).toEqual(["seed", "d", "a", "c", "b"]);
    for (const nodeId of ["seed", "d", "c"]) expect(finalCheckpoint.graph.nodes[nodeId]?.phase).toBe("accepted");
    expect(observation.invocations.map((call) => `${call.nodeId}/${call.attempt}`).sort(compareStrings)).toEqual(["a/1", "a/2", "a/3", "b/1", "b/2", "c/1", "d/1", "seed/1"]);
    expect(observation.invocations).toHaveLength(8);
    expect(observation.repairs).toBe(0);
    expect(observation.telemetry).toHaveLength(8);
    expect(observation.launches).toHaveLength(8);
    expect(observation.legacyUsage).toBe(0);
    expect(sorted(observation.availability)).toEqual(["a", "a", "a", "b", "b", "c", "d", "seed"]);
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);
    assertLifecycle(state, observation.invocations);
    expect(findCall(observation, "a", 3)).toMatchObject({ parentCallId: a2.callId, answers: { aFirst: "a-one", aSecond: "a-two" } });
    expect(findCall(observation, "b", 2)).toMatchObject({ parentCallId: b1.callId, answers: { bFirst: "b-one" } });
    assertCallForInvocation(project, runId, findCall(observation, "a", 3));
    assertCallForInvocation(project, runId, findCall(observation, "b", 2));
    const finalEvents = readEvents(project, runId);
    expect(finalEvents.slice(0, secondState.events.length)).toEqual(secondState.events);
    assertAppendedSequences(finalEvents, secondState.events.length, secondState.nextEventSequence);
    const finalMetrics = readMetrics(project, runId);
    expect(finalMetrics).toHaveLength(8);
    expect(finalMetrics.slice(0, secondState.metrics.length)).toEqual(secondState.metrics);
    expect(metricCallIds(finalMetrics)).toEqual(observation.invocations.map((call) => call.callId).sort(compareStrings));
    expect(readBytes(runFile(project, runId, "inputs.json"))).toEqual(initialInputs);
    assertFiles(project, runId, initialState.immutable);
    assertAccepted(project, runId, "seed", acceptedSeed);
    assertAccepted(project, runId, "d", acceptedD);
    assertAccepted(project, runId, "c", acceptedC);
    for (const request of [a1, a2, b1]) assertAnswer(project, runId, request, request.nodeId === "a" ? (request === a1 ? { aFirst: "a-one" } : { aSecond: "a-two" }) : { bFirst: "b-one" });
    for (const call of observation.invocations) assertCallForInvocation(project, runId, call);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    const cleanupDeadline = Date.now() + cleanupBudgetMs;
    releaseAll(state, cleanupErrors);
    try { await withDeadline(Promise.all(publicOperations), cleanupDeadline, "public workflow settlement"); }
    catch (error) { cleanupErrors.push(asError(error)); }
    try { await withDeadline(Promise.all([...observation.delegated]), cleanupDeadline, "adapter settlement"); }
    catch (error) { cleanupErrors.push(asError(error)); }
    if (!hasPrimaryError && cleanupErrors.length === 0) {
      try { assertOwnedProject(project, identity, label); rmSync(project, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(asError(error)); }
    } else console.error(`PAR-035 retained project for diagnosis (run ${runId ?? "not initialized"}): ${project}`);
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "PAR-035 scenario and cleanup failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-035 cleanup failed.");
}

function configureProject(project: string, state: State): { providerSentinel: string; validatorSentinel: string } {
  const sentinels = configureParallelProject(project);
  mkdirSync(state.directory, { recursive: true });
  writeFileSync(state.events, "", { encoding: "utf8", flag: "wx" });
  const fixturePath = path.join(project, ".nodulus", "fixtures", "par-035-queued-answer-provider.mjs");
  writeFileSync(fixturePath, readFileSync(fixtureSource, "utf8"), "utf8");
  const startedPaths = Object.fromEntries(Object.entries(state.started).map(([key, value]) => [key, path.relative(project, value)]));
  const releasePaths = Object.fromEntries(Object.entries(state.releases).map(([key, value]) => [key, path.relative(project, value)]));
  writeJson(project, ".nodulus/fixtures/par-035-queued-control.json", { eventsPath: path.relative(project, state.events), fixtureLifetimeMs, startedPaths, releasePaths });
  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  const base = profiles.fixture ?? {};
  for (const role of ["seed", "d", "a", "c", "b"] as Role[]) {
    const wrapperName = process.platform === "win32" ? `par-035-queued-${role}.cmd` : `par-035-queued-${role}.sh`;
    const wrapper = path.join(project, ".nodulus", "fixtures", wrapperName);
    if (process.platform === "win32") {
      writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-035-queued-answer-provider.mjs" "${role}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    } else {
      writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-035-queued-answer-provider.mjs' '${role}' "$@"\n`, "utf8");
      chmodSync(wrapper, 0o755);
    }
    profiles[role] = { ...base, enabled: true, executable: wrapper, kind: "codex", model: role, timeoutMs: profileTimeoutMs, capabilities: [], sandbox: "read-only", reasoningEffort: "medium" };
    const inputMap: Record<string, { from: string; contract: string }> = role === "seed" ? { request: { from: "request", contract: "request.v1" } }
      : role === "c" ? { report: { from: "d.report", contract: "report.v1" } }
      : { report: { from: "seed.report", contract: "report.v1" } };
    writeJson(project, `.nodulus/nodes/${role}.json`, {
      schemaVersion: 1,
      id: role,
      providerProfile: role,
      instructions: [`.nodulus/instructions/${role}.md`],
      inputs: inputMap,
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${role}.md`), `PAR-035 ${role} node.\n`, "utf8");
  }
  writeJson(project, ".nodulus/settings.json", settings);
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 2,
    id: "example",
    nodes: ["seed", "d", "a", "c", "b"],
    execution: {
      kind: "dag",
      maxConcurrency: 3,
      dependsOn: { seed: [], d: ["seed"], a: ["seed"], c: ["d"], b: ["seed"] },
      resources: { seed: [], d: [], a: [], c: ["shared"], b: ["shared"] },
    },
    outputs: [
      { name: "aResult", from: "a.report", contract: "report.v1" },
      { name: "bResult", from: "b.report", contract: "report.v1" },
    ],
  });
  return sentinels;
}

function makeState(project: string): State {
  const directory = path.join(project, ".nodulus", "fixtures", "par-035-queued-state");
  const started: Record<string, string> = {};
  const releases: Record<string, string> = {};
  for (const role of ["seed", "d", "a", "b", "c"] as Role[]) {
    const max = role === "a" ? 3 : role === "b" ? 2 : 1;
    for (let attempt = 1; attempt <= max; attempt += 1) {
      const key = `${role}-${attempt}`;
      started[key] = path.join(directory, `${key}.started.json`);
      releases[key] = path.join(directory, `${key}.release`);
    }
  }
  return { directory, events: path.join(directory, "provider-events.jsonl"), started, releases };
}

function observe(project: string, observation: Observation): ProviderPort {
  const delegate = createDefaultProviderPort(project);
  return {
    ...delegate,
    invoke(invocation) {
      const call = invocation.call;
      if (!call?.callId) throw new Error("PAR-035 provider invocation has no call ID.");
      observation.invocations.push({ nodeId: invocation.nodeId as Role, callId: call.callId, attempt: invocation.attempt, parentCallId: call.parentCallId ?? null, answers: structuredClone(invocation.answers ?? {}) });
      return track(delegate.invoke(invocation), observation);
    },
    ...(delegate.isAvailable ? { isAvailable(profile, options) {
      observation.availability.push(typeof profile.model === "string" ? profile.model : "unknown");
      return track(delegate.isAvailable!(profile, options), observation);
    } } : {}),
    ...(delegate.repairResponse ? { repairResponse(invocation, raw, errors) {
      observation.repairs += 1;
      return track(delegate.repairResponse!(invocation, raw, errors), observation);
    } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall(callId) {
      observation.telemetry.push(callId);
      return track(delegate.telemetryForCall!(callId), observation);
    } } : {}),
    ...(delegate.launchForCall ? { launchForCall(callId) {
      observation.launches.push(callId);
      return track(delegate.launchForCall!(callId), observation);
    } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall() {
      observation.legacyUsage += 1;
      return delegate.usageForLastCall!();
    } } : {}),
  };
}

function track<T>(operation: T, observation: Observation): T {
  if (typeof operation === "object" && operation !== null && "then" in operation && typeof operation.then === "function") {
    observation.delegated.push(Promise.resolve(operation).then(() => undefined, () => undefined));
  }
  return operation;
}

function capture(promise: Promise<ApplicationRunResult>, operations: Promise<Outcome>[]): Promise<Outcome> {
  const settled = promise.then<Outcome, Outcome>((result) => ({ kind: "result", result }), (error: unknown) => ({ kind: "error", error }));
  operations.push(settled);
  return settled;
}

function runRequest(projectRoot: string) {
  return { projectRoot, cwd: projectRoot, workflow: "example", sources: [{ kind: "inline" as const, text: "Keep queued answer continuations without replay." }] };
}

async function waitMarker(state: State, key: string, deadline: number, outcome: () => Outcome | undefined): Promise<Marker> {
  const file = state.started[key];
  if (!file) throw new Error(`PAR-035 has no marker path for '${key}'.`);
  await waitFor(() => existsSync(file), deadline, `${key} marker`, outcome);
  const value = readJson(file);
  if (typeof value.nodeId !== "string" || typeof value.role !== "string" || typeof value.runId !== "string" || typeof value.callId !== "string" ||
      !Number.isSafeInteger(value.attempt) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !isRecord(value.promptAnswers)) {
    throw new Error(`PAR-035 ${key} marker has invalid identity.`);
  }
  return value as unknown as Marker;
}

async function waitForQuestion(project: string, runId: string, nodeId: "a" | "b", attempt: number, deadline: number, outcome: () => Outcome | undefined): Promise<Request> {
  const resultPath = runFile(project, runId, `nodes/${nodeId}/attempt-${String(attempt).padStart(3, "0")}/result.json`);
  let committed: Request | undefined;
  await waitFor(() => {
    try {
      if (!existsSync(resultPath)) return false;
      const result = readJson(resultPath);
      if (result.status !== "needs_input" || !isRecord(result.request)) return false;
      const request = result.request as unknown as Request;
      if (request.nodeId !== nodeId || request.attempt !== attempt || typeof request.id !== "string" || typeof request.callId !== "string") return false;
      const checkpoint = readCheckpoint(project, runId);
      const entry = checkpoint.graph.pendingRequests[request.id];
      const current = checkpoint.graph.nodes[nodeId];
      if (!entry || entry.nodeId !== nodeId || entry.attempt !== attempt || entry.requestRef !== `pending/${request.id}.json` ||
          typeof entry.requestSha256 !== "string" || current?.phase !== "pending" || current.callId !== request.callId || current.attempt !== attempt || current.accepted !== undefined) return false;
      const bytes = readBytes(runFile(project, runId, entry.requestRef));
      if (digest(bytes) !== entry.requestSha256 || JSON.stringify(JSON.parse(bytes.toString("utf8"))) !== JSON.stringify(request)) return false;
      committed = request;
      return true;
    } catch { return false; }
  }, deadline, `${nodeId}/${attempt} checkpoint-committed question`, outcome);
  if (!committed) throw new Error(`PAR-035 ${nodeId}/${attempt} question was not committed.`);
  return committed;
}

async function waitFor(predicate: () => boolean, deadline: number, description: string, outcome: () => Outcome | undefined): Promise<void> {
  while (!predicate()) {
    const settled = outcome();
    if (settled) throw new Error(`PAR-035 operation settled before ${description}: ${describeOutcome(settled)}`);
    assertBefore(deadline, description);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`PAR-035 shared scenario deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`PAR-035 shared scenario deadline expired during ${description}.`)), remaining); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function checkpointIfReady(project: string, runId: string): Checkpoint | undefined {
  try { return readCheckpoint(project, runId); } catch { return undefined; }
}

function readCheckpoint(project: string, runId: string): Checkpoint {
  return readJson(runFile(project, runId, "run.json")) as unknown as Checkpoint;
}

function capturePause(project: string, runId: string): { events: Array<Record<string, unknown>>; metrics: unknown[]; metricBytes: Buffer; nextEventSequence: number; immutable: Files } {
  const checkpoint = readCheckpoint(project, runId);
  return { events: readEvents(project, runId), metrics: readMetrics(project, runId), metricBytes: readBytes(runFile(project, runId, "metrics.json")), nextEventSequence: checkpoint.graph.nextEventSequence, immutable: captureCurrentEvidence(project, runId) };
}

function captureCurrentEvidence(project: string, runId: string): Files {
  const snapshot: Files = new Map();
  const checkpoint = readCheckpoint(project, runId);
  for (const [id, entry] of Object.entries(checkpoint.graph.pendingRequests)) {
    captureFile(snapshot, project, runId, entry.requestRef as string);
    const request = readJson(runFile(project, runId, entry.requestRef as string));
    if (typeof request.callId === "string") captureTree(snapshot, project, runId, `calls/${request.callId}`);
    captureTree(snapshot, project, runId, `nodes/${String(entry.nodeId)}/attempt-${String(entry.attempt).padStart(3, "0")}`);
    if (typeof entry.answerRef === "string") captureFile(snapshot, project, runId, entry.answerRef);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("PAR-035 pending request ID is invalid.");
  }
  return snapshot;
}

function captureAccepted(project: string, runId: string, nodeId: Role): AcceptedSnapshot {
  const state = readCheckpoint(project, runId).graph.nodes[nodeId];
  const accepted = state?.accepted;
  if (!accepted) throw new Error(`PAR-035 accepted ${nodeId} node has no evidence.`);
  const snapshot: Files = new Map();
    const manifest = structuredClone(accepted);
    for (const reference of [accepted.resultRef, accepted.validationRef, accepted.responseRef, ...accepted.artifacts.map((artifact) => artifact.ref)]) {
      const bytes = readBytes(runFile(project, runId, reference));
      const expectedHash = reference === accepted.resultRef ? accepted.resultSha256
        : reference === accepted.validationRef ? accepted.validationSha256
        : reference === accepted.responseRef ? accepted.responseSha256
        : accepted.artifacts.find((artifact) => artifact.ref === reference)?.sha256;
      if (typeof expectedHash !== "string" || digest(bytes) !== expectedHash) throw new Error(`PAR-035 accepted ${nodeId} evidence hash does not match its manifest.`);
      snapshot.set(reference, bytes);
    }
  const attempt = Number(state.attempt);
  captureTree(snapshot, project, runId, `nodes/${nodeId}/attempt-${String(attempt).padStart(3, "0")}`);
  if (typeof state.callId === "string") captureTree(snapshot, project, runId, `calls/${state.callId}`);
  return { files: snapshot, manifest };
}

function assertAccepted(project: string, runId: string, nodeId: Role, snapshot: AcceptedSnapshot): void {
  expect(readCheckpoint(project, runId).graph.nodes[nodeId]?.accepted).toEqual(snapshot.manifest);
  assertFiles(project, runId, snapshot.files);
}

function captureTree(snapshot: Files, project: string, runId: string, relative: string): void {
  const directory = runFile(project, runId, relative);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) captureTree(snapshot, project, runId, child);
    else if (entry.isFile()) captureFile(snapshot, project, runId, child);
  }
}

function captureFile(snapshot: Files, project: string, runId: string, relative: string): void {
  snapshot.set(relative.replaceAll("\\", "/"), readBytes(runFile(project, runId, relative)));
}

function assertFiles(project: string, runId: string, snapshot: Files): void {
  for (const [relative, bytes] of snapshot) expect(readBytes(runFile(project, runId, relative))).toEqual(bytes);
}

function readEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(runFile(project, runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readMetrics(project: string, runId: string): unknown[] {
  const metrics: unknown = JSON.parse(readFileSync(runFile(project, runId, "metrics.json"), "utf8"));
  if (!Array.isArray(metrics)) throw new Error("PAR-035 metrics are not a call-keyed array.");
  return metrics;
}

function metricCallIds(metrics: unknown[]): string[] {
  return metrics.map((row) => {
    if (!isRecord(row) || typeof row.callId !== "string") throw new Error("PAR-035 metric row has no call ID.");
    return row.callId;
  }).sort(compareStrings);
}

function requests(value: unknown): Request[] {
  if (!isRecord(value) || !Array.isArray(value.requests)) throw new Error("PAR-035 result has no request list.");
  return value.requests as Request[];
}

function readPauseIds(project: string, runId: string): string[] {
  const pause = readEvents(project, runId).filter((event) => event.event === "run.needs_input").at(-1);
  if (!pause || !Array.isArray(pause.requestIds)) throw new Error("PAR-035 event history has no pause IDs.");
  return pause.requestIds as string[];
}

function assertQuestion(project: string, runId: string, request: Request): void {
  expect(request.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  const entry = readCheckpoint(project, runId).graph.pendingRequests[request.id];
  const bytes = readBytes(runFile(project, runId, entry.requestRef as string));
  expect(digest(bytes)).toBe(entry.requestSha256);
  expect(JSON.parse(bytes.toString("utf8"))).toEqual(request);
  const attempt = String(request.attempt).padStart(3, "0");
  expect(readJson(runFile(project, runId, `nodes/${request.nodeId}/attempt-${attempt}/result.json`))).toMatchObject({ status: "needs_input", request });
  expect(readJson(runFile(project, runId, `nodes/${request.nodeId}/attempt-${attempt}/validation.json`))).toEqual({ valid: true, outcome: "needs_input", errors: [] });
  expect(readJson(runFile(project, runId, `calls/${request.callId}/request.json`))).toMatchObject({ nodeId: request.nodeId, callId: request.callId, attempt: request.attempt, operation: "invoke" });
  expect(readJson(runFile(project, runId, `calls/${request.callId}/transport.json`))).toMatchObject({ callId: request.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
}

function assertAnswer(project: string, runId: string, request: Request, answer: Record<string, unknown>): void {
  const ref = `answers/${request.id}.json`;
  const bytes = readBytes(runFile(project, runId, ref));
  expect(JSON.parse(bytes.toString("utf8"))).toEqual(answer);
  expect(readCheckpoint(project, runId).graph.pendingRequests[request.id]).toMatchObject({ answerRef: ref, answerSha256: digest(bytes) });
  const events = readEvents(project, runId).filter((event) => event.event === "request.answered" && event.requestId === request.id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ nodeId: request.nodeId, kind: "node" });
  expect(events[0]).not.toHaveProperty("answer");
  expect(events[0]).not.toHaveProperty("answers");
  const serialized = JSON.stringify(events[0]);
  const answerValues = Object.values(answer).filter((value): value is string => typeof value === "string");
  for (const value of answerValues) expect(serialized).not.toContain(value);
}

function assertCall(project: string, runId: string, marker: Marker, parentCallId?: string): void {
  expect(readJson(runFile(project, runId, `calls/${marker.callId}/request.json`))).toMatchObject({ nodeId: marker.nodeId, callId: marker.callId, attempt: marker.attempt, ...(parentCallId ? { parentCallId } : {}) });
  expect(readJson(runFile(project, runId, `calls/${marker.callId}/transport.json`))).toMatchObject({ callId: marker.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
}

function assertCallForInvocation(project: string, runId: string, call: Call): void {
  expect(readJson(runFile(project, runId, `calls/${call.callId}/request.json`))).toMatchObject({ nodeId: call.nodeId, callId: call.callId, attempt: call.attempt, parentCallId: call.parentCallId });
  expect(readJson(runFile(project, runId, `calls/${call.callId}/transport.json`))).toMatchObject({ callId: call.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
}

function assertPrompt(state: State, marker: Marker, expected: Record<string, unknown>): void {
  const events = readFixtureEvents(state);
  const matches = events.filter((event) => event.stage === "inference-started" && event.callId === marker.callId);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ nodeId: marker.nodeId, runId: marker.runId, attempt: marker.attempt, promptAnswers: expected });
}

function assertLifecycle(state: State, calls: Call[]): void {
  const events = readFixtureEvents(state);
  const expected = calls.map((call) => `${call.nodeId}/${call.callId}/${call.attempt}`).sort(compareStrings);
  for (const stage of ["inference-started", "inference-completed"]) {
    const actual = events.filter((event) => event.stage === stage).map((event) => {
      if (typeof event.nodeId !== "string" || typeof event.callId !== "string" || typeof event.attempt !== "number" || !Number.isSafeInteger(event.attempt)) {
        throw new Error(`PAR-035 ${stage} fixture event has invalid call identity.`);
      }
      return `${event.nodeId}/${event.callId}/${event.attempt}`;
    }).sort(compareStrings);
    expect(actual).toEqual(expected);
  }
}

function snapshotMethods(observation: Observation): unknown {
  return {
    availability: [...observation.availability],
    invocations: structuredClone(observation.invocations),
    repairs: observation.repairs,
    telemetry: [...observation.telemetry],
    launches: [...observation.launches],
    legacyUsage: observation.legacyUsage,
    delegated: observation.delegated.length,
  };
}

function readFixtureEvents(state: State): Array<Record<string, unknown>> {
  return readFileSync(state.events, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertAppendedSequences(events: Array<Record<string, unknown>>, prefixCount: number, nextSequence: number): void {
  const appended = events.slice(prefixCount).map((event) => event.sequence);
  expect(appended.every((sequence) => typeof sequence === "number" && Number.isSafeInteger(sequence))).toBe(true);
  const numeric = appended as number[];
  expect(new Set(numeric).size).toBe(numeric.length);
  if (numeric.length > 0) expect(numeric[0]).toBe(nextSequence);
  for (let index = 1; index < numeric.length; index += 1) expect(numeric[index]).toBe(numeric[index - 1]! + 1);
}

function findCall(observation: Observation, nodeId: Role, attempt: number): Call {
  const matches = observation.invocations.filter((call) => call.nodeId === nodeId && call.attempt === attempt);
  if (matches.length !== 1) throw new Error(`PAR-035 expected exactly one ${nodeId}/${attempt} invocation.`);
  return matches[0]!;
}

function outputArtifacts(value: unknown): Array<{ name: string; contract: string; data: unknown }> {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) throw new Error("PAR-035 final result has no output aliases.");
  return value.artifacts as Array<{ name: string; contract: string; data: unknown }>;
}

function release(state: State, key: string): void {
  const target = state.releases[key];
  if (!target) throw new Error(`PAR-035 has no release path for '${key}'.`);
  if (!existsSync(target)) writeFileSync(target, "release\n", { encoding: "utf8", flag: "wx" });
}

function releaseAll(state: State, errors: Error[]): void {
  for (const key of Object.keys(state.releases)) {
    try { release(state, key); } catch (error) { errors.push(asError(error)); }
  }
}

function assertLive(marker: Marker, description: string): void {
  if (!isLive(marker.pid)) throw new Error(`PAR-035 ${description} process ${marker.pid} was not live at its held barrier.`);
}

function isLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function requireResult(outcome: Outcome, description: string): ApplicationRunResult {
  if (outcome.kind === "error") throw new Error(`PAR-035 ${description} rejected: ${describeError(outcome.error)}`);
  return outcome.result;
}

function describeOutcome(outcome: Outcome): string {
  return outcome.kind === "error" ? describeError(outcome.error) : `status=${outcome.result.status}`;
}

function describeError(error: unknown): string {
  if (isRecord(error)) return `${typeof error.code === "string" ? error.code : "unknown code"}: ${typeof error.message === "string" ? error.message.slice(0, 400) : "no message"}`;
  return typeof error === "string" ? error.slice(0, 400) : "non-Error rejection";
}

function assertBefore(deadline: number, operation: string): void {
  if (Date.now() >= deadline) throw new Error(`PAR-035 20-second scenario deadline expired during ${operation}.`);
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const canonical = realpathSync.native(project);
  if (canonical !== identity || path.dirname(identity) !== realpathSync.native(tmpdir()) || !path.basename(identity).startsWith(`nodulus-${label}-`)) {
    throw new Error("PAR-035 refused cleanup outside the exact owned temporary project.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function readBytes(file: string): Buffer { return readFileSync(file); }
function runDirectory(project: string, runId: string): string { return path.join(project, ".nodulus", "runs", runId); }
function runFile(project: string, runId: string, relative: string): string { return path.join(runDirectory(project, runId), relative); }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function sorted(values: string[]): string[] { return [...values].sort(compareStrings); }
function compareStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error("PAR-035 cleanup failed with a non-Error value."); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

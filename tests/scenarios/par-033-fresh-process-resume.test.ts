import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type Role = "seed" | "b" | "a";
type DriverOperation = "initial" | "partial" | "final";
type DriverHandle = {
  operation: DriverOperation;
  nonce: string;
  child: ChildProcessWithoutNullStreams;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  outputOverflow: boolean;
  stdinError?: Error;
};
type DriverObservations = {
  availability: string[];
  invocations: Array<{ nodeId: string; callId: string | null; attempt: number; parentCallId: string | null; answers: Record<string, unknown> | null }>;
  repairs: Array<{ nodeId: string; callId: string | null; attempt: number; parentCallId: string | null }>;
  telemetry: string[];
  launches: string[];
  legacyUsage: number;
  observationLimitExceeded: boolean;
};
type DriverEnvelope = {
  protocol: string;
  operation: DriverOperation;
  nonce: string;
  outcome: { kind: "result"; result: { runId: string; status: string; result: unknown } } | { kind: "error"; error: { name: string; code?: string; message: string } };
  observations: DriverObservations;
  settled: { public: boolean; delegated: boolean };
};
type ProviderMarker = { role: Role; nodeId: Role; runId: string; callId: string; attempt: number; pid: number };
type PendingRequest = { id: string; nodeId: string; attempt: number; callId: string; questions: Array<{ id: string; message: string }>; answerContract: Record<string, unknown> };
type AcceptedRecord = {
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
type GraphCheckpoint = {
  runId: string;
  status: string;
  completedNodes: string[];
  nextEventSequence?: number;
  graph: {
    nodes: Record<string, { phase?: string; attempt?: number; callId?: string; accepted?: AcceptedRecord }>;
    pendingRequests: Record<string, Record<string, unknown>>;
  };
};
type FixtureEvent = { stage: string; role: string; pid: number; atMs: number; nodeId?: string; runId?: string; callId?: string; attempt?: number; promptAnswers?: Record<string, unknown> };
type CapturedFile = { bytes: Buffer; sha256: string };
type InitialState = {
  runId: string;
  requests: { b: PendingRequest; a: PendingRequest };
  markers: { seed: ProviderMarker; b: ProviderMarker; a: ProviderMarker };
  acceptedSeed: AcceptedRecord;
  inputBytes: Buffer;
  events: Array<Record<string, unknown>>;
  metrics: unknown[];
  metricBytes: Buffer;
  fixtureEventBytes: Buffer;
  immutableFiles: Map<string, CapturedFile>;
};
type PartialState = { events: Array<Record<string, unknown>>; metrics: unknown[]; metricBytes: Buffer; fixtureEventBytes: Buffer };

const fixtureSource = fileURLToPath(new URL("../fixtures/par-031-graph-provider.mjs", import.meta.url));
const driverSource = fileURLToPath(new URL("../fixtures/par-033-fresh-resume-driver.mjs", import.meta.url));
const roles: Role[] = ["seed", "b", "a"];
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 35_000;
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;
const maxCapturedDriverOutputBytes = 256_000;
const expectedFixtureSha256 = "36ce63620be97c9ca0c4c6090b9d56dceb03eb0820d361ccfb95facc0940ef32";

test("PAR-033 resumes a paused parallel graph through three fresh processes without replaying accepted work", async () => {
  await exerciseFreshResume();
}, testCeilingMs);

async function exerciseFreshResume(): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = "par-033-fresh-resume-café";
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const stateDirectory = path.join(fixtureDirectory, "par-033-state");
  const eventsPath = path.join(stateDirectory, "events.jsonl");
  const startedPaths: Record<string, string> = {};
  for (const role of roles) {
    for (const attempt of [1, 2]) startedPaths[`${role}-${attempt}`] = path.join(stateDirectory, `${role}-${attempt}.started.json`);
  }
  const releasePaths = { a: path.join(stateDirectory, "release-a"), b: path.join(stateDirectory, "release-b") };
  const driverHandles: DriverHandle[] = [];
  const cleanupErrors: Error[] = [];
  let primaryError: unknown;
  let hasPrimaryError = false;
  let runId: string | undefined;

  try {
    assertOwnedProject(project, projectIdentity, label);
    const sentinels = configureProject(project, eventsPath, stateDirectory, startedPaths, releasePaths);
    assertBeforeDeadline(scenarioDeadline, "project setup");

    const initialDriver = startDriver(driverHandles, "initial", randomUUID(), project);
    const seedMarkerPromise = waitForMarker(startedPaths["seed-1"]!, "seed inference", scenarioDeadline, initialDriver);
    const seedAcceptedPromise = seedMarkerPromise.then((marker) => waitForAcceptedSeed(project, marker.runId, scenarioDeadline, initialDriver));
    const bMarkerPromise = waitForMarker(startedPaths["b-1"]!, "B initial question", scenarioDeadline, initialDriver);
    const aMarkerPromise = waitForMarker(startedPaths["a-1"]!, "A initial question", scenarioDeadline, initialDriver);
    const [seedMarker, , bMarker, aMarker] = await withDeadline(
      Promise.all([seedMarkerPromise, seedAcceptedPromise, bMarkerPromise, aMarkerPromise]),
      scenarioDeadline,
      "seed acceptance and both initial question barriers",
    );
    runId = seedMarker.runId;
    expect(seedMarker).toMatchObject({ role: "seed", nodeId: "seed", attempt: 1 });
    expect(aMarker).toMatchObject({ role: "a", nodeId: "a", runId, attempt: 1 });
    expect(bMarker).toMatchObject({ role: "b", nodeId: "b", runId, attempt: 1 });
    expect(isProcessAlive(initialDriver.child.pid), "The initial public driver must remain alive at both provider barriers.").toBe(true);
    expect(isProcessAlive(aMarker.pid), "A's actual provider process must be alive before releasing either branch.").toBe(true);
    expect(isProcessAlive(bMarker.pid), "B's actual provider process must be alive before releasing either branch.").toBe(true);

    writeFileSync(releasePaths.a, "release\n", { encoding: "utf8", flag: "wx" });
    const aRequest = await waitForQuestion(project, runId, aMarker, scenarioDeadline, initialDriver);
    const checkpointWhileBActive = readCheckpoint(project, runId);
    expect(checkpointWhileBActive.graph.pendingRequests[aRequest.id]).toMatchObject({ nodeId: "a", kind: "node" });
    expect(checkpointWhileBActive.graph.nodes.b?.phase).toBe("active");
    expect(isProcessAlive(bMarker.pid), "B must still be active after A's request is committed.").toBe(true);
    writeFileSync(releasePaths.b, "release\n", { encoding: "utf8", flag: "wx" });

    const initialEnvelope = await readDriverEnvelope(initialDriver, scenarioDeadline);
    const initialResult = requireResult(initialEnvelope, "initial run");
    runId = initialResult.runId;
    expect(initialResult.runId).toBe(seedMarker.runId);
    expect(initialResult.status).toBe("needs_input");
    const initialRequests = requestProjection(initialResult.result);
    expect(initialRequests.requests.map((request) => request.nodeId)).toEqual(["b", "a"]);
    const bRequest = initialRequests.requests.find((request) => request.nodeId === "b");
    const returnedA = initialRequests.requests.find((request) => request.nodeId === "a");
    if (!bRequest || !returnedA) throw new Error("PAR-033 initial run did not return both runtime requests.");
    expect(returnedA).toEqual(aRequest);
    expect(initialRequests.request).toEqual(bRequest);
    assertRequest(aRequest, "a", aMarker);
    assertRequest(bRequest, "b", bMarker);
    expect(isUuid(aRequest.id)).toBe(true);
    expect(isUuid(bRequest.id)).toBe(true);
    expect(aRequest.id).not.toBe("provider-untrusted-a");
    expect(bRequest.id).not.toBe("provider-untrusted-b");
    expect(aRequest.answerContract).toEqual(answerContract("a"));
    expect(bRequest.answerContract).toEqual(answerContract("b"));
    expect(initialEnvelope.observations.observationLimitExceeded).toBe(false);
    expect(initialEnvelope.observations.invocations.map(({ nodeId }) => nodeId).sort(compareStrings)).toEqual(["a", "b", "seed"]);
    expect(initialEnvelope.observations.invocations).toHaveLength(3);
    const initialInvocationByNode = new Map(initialEnvelope.observations.invocations.map((invocation) => [invocation.nodeId, invocation]));
    for (const marker of [seedMarker, bMarker, aMarker]) {
      expect(initialInvocationByNode.get(marker.nodeId)).toMatchObject({ nodeId: marker.nodeId, callId: marker.callId, attempt: 1, parentCallId: null, answers: null });
    }
    expect(initialEnvelope.observations.repairs).toHaveLength(0);
    expect(initialEnvelope.settled).toEqual({ public: true, delegated: true });
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);
    expect(readFixtureEvents(eventsPath).filter((event) => event.stage === "inference-started" && event.attempt === 1)).toHaveLength(3);

    const initialState = captureInitialState(project, runId, eventsPath, {
      seed: seedMarker,
      b: bMarker,
      a: aMarker,
    }, { b: bRequest, a: aRequest });
    expect(initialState.metrics).toHaveLength(3);
    expect(initialState.events.length).toBeGreaterThan(0);
    expect(initialState.acceptedSeed.artifacts).toHaveLength(1);
    for (const marker of [seedMarker, bMarker, aMarker]) assertTransport(project, runId, marker);
    assertSeedEvidence(project, runId, initialState);

    const partialAnswersPath = path.join(stateDirectory, "answers-a.json");
    writeFileSync(partialAnswersPath, `${JSON.stringify(answerFor("a"))}\n`, { encoding: "utf8", flag: "wx" });
    const partialDriver = startDriver(driverHandles, "partial", randomUUID(), project, runId, aRequest.id, partialAnswersPath);
    expect(partialDriver.nonce).not.toBe(initialDriver.nonce);
    const partialEnvelope = await readDriverEnvelope(partialDriver, scenarioDeadline);
    const partialResult = requireResult(partialEnvelope, "partial A resume");
    expect(partialEnvelope.observations).toMatchObject({ availability: [], invocations: [], repairs: [], telemetry: [], launches: [], legacyUsage: 0, observationLimitExceeded: false });
    expect(partialEnvelope.settled).toEqual({ public: true, delegated: true });
    expect(partialResult.runId).toBe(runId);
    expect(partialResult.status).toBe("needs_input");
    const partialRequests = requestProjection(partialResult.result);
    expect(partialRequests.requests).toEqual([bRequest]);
    expect(partialRequests.request).toEqual(bRequest);
    const partialState = capturePartialState(project, runId, eventsPath);
    expect(partialState.metricBytes.equals(initialState.metricBytes)).toBe(true);
    expect(partialState.metrics).toEqual(initialState.metrics);
    expect(partialState.fixtureEventBytes.equals(initialState.fixtureEventBytes)).toBe(true);
    expect(partialState.events.slice(0, initialState.events.length)).toEqual(initialState.events);
    const partialCallEvents = partialState.events.slice(initialState.events.length).filter(isProviderCallEvent);
    expect(partialCallEvents).toHaveLength(0);
    assertImmutableEvidence(runDirectory(project, runId), initialState.immutableFiles);
    assertSeedEvidence(project, runId, initialState);
    assertAnswerCommit(project, runId, aRequest, answerFor("a"), initialState.events.length);
    expect(readCheckpoint(project, runId).graph.pendingRequests[bRequest.id]).toMatchObject({ nodeId: "b", kind: "node" });

    const finalAnswersPath = path.join(stateDirectory, "answers-b.json");
    writeFileSync(finalAnswersPath, `${JSON.stringify(answerFor("b"))}\n`, { encoding: "utf8", flag: "wx" });
    const finalDriver = startDriver(driverHandles, "final", randomUUID(), project, runId, bRequest.id, finalAnswersPath);
    expect(finalDriver.nonce).not.toBe(initialDriver.nonce);
    expect(finalDriver.nonce).not.toBe(partialDriver.nonce);
    const finalEnvelope = await readDriverEnvelope(finalDriver, scenarioDeadline);
    const finalResult = requireResult(finalEnvelope, "final B resume");
    expect(finalResult.runId).toBe(runId);
    expect(finalResult.status).toBe("success");
    expect(finalEnvelope.observations.observationLimitExceeded).toBe(false);
    expect(finalEnvelope.observations.repairs).toHaveLength(0);
    expect(finalEnvelope.observations.availability).not.toContain("p4c1-seed");
    expect(finalEnvelope.observations.invocations.map(({ nodeId }) => nodeId).sort(compareStrings)).toEqual(["a", "b"]);
    expect(finalEnvelope.observations.invocations).toHaveLength(2);
    expect(finalEnvelope.settled).toEqual({ public: true, delegated: true });

    const finalCheckpoint = readCheckpoint(project, runId);
    expect(finalCheckpoint.status).toBe("success");
    expect(finalCheckpoint.graph.nodes.seed).toMatchObject({ phase: "accepted", callId: seedMarker.callId, attempt: 1 });
    expect([...finalCheckpoint.completedNodes].sort(compareStrings)).toEqual(["a", "b", "seed"]);
    expect(new Set(finalCheckpoint.completedNodes).size).toBe(3);
    assertSeedEvidence(project, runId, initialState);
    assertImmutableEvidence(runDirectory(project, runId), initialState.immutableFiles);
    assertAnswerCommit(project, runId, bRequest, answerFor("b"), partialState.events.length);

    const finalEvents = readRunEvents(project, runId);
    expect(finalEvents.slice(0, partialState.events.length)).toEqual(partialState.events);
    assertContiguousAppendedEvents(finalEvents, partialState.events.length);
    const finalMetrics = readMetrics(project, runId);
    expect(finalMetrics).toHaveLength(5);
    expect(finalMetrics.slice(0, initialState.metrics.length)).toEqual(initialState.metrics);
    expect(finalMetrics.slice(0, partialState.metrics.length)).toEqual(partialState.metrics);

    const invocationByNode = new Map(finalEnvelope.observations.invocations.map((invocation) => [invocation.nodeId, invocation]));
    const continuationMarkers: ProviderMarker[] = [];
    for (const nodeId of ["a", "b"] as const) {
      const oldRequest = nodeId === "a" ? aRequest : bRequest;
      const invocation = invocationByNode.get(nodeId);
      expect(invocation).toMatchObject({ nodeId, attempt: 2, parentCallId: oldRequest.callId, answers: answerFor(nodeId) });
      expect(invocation?.callId).toEqual(expect.any(String));
      expect(invocation?.callId).not.toBe(oldRequest.callId);
      expect(initialEnvelope.observations.invocations.filter((call) => call.nodeId === nodeId)).toHaveLength(1);
      expect(finalEnvelope.observations.invocations.filter((call) => call.nodeId === nodeId)).toHaveLength(1);
      expect(finalCheckpoint.graph.nodes[nodeId]).toMatchObject({ phase: "accepted", attempt: 2, callId: invocation?.callId });
      const marker = readMarker(startedPaths[`${nodeId}-2`]!);
      expect(marker).toMatchObject({ role: nodeId, nodeId, runId, callId: invocation?.callId, attempt: 2 });
      continuationMarkers.push(marker);
      const savedRequest = readJson(path.join(runDirectory(project, runId), "calls", marker.callId, "request.json"));
      expect(savedRequest).toMatchObject({ nodeId, runId, callId: marker.callId, attempt: 2, parentCallId: oldRequest.callId });
      assertTransport(project, runId, marker);
      assertContinuationAcceptance(project, runId, nodeId, marker, `${nodeId}-continued-${nodeId === "a" ? "A" : "B"}-approved`);
    }
    expect(finalEnvelope.observations.invocations.some(({ nodeId }) => nodeId === "seed")).toBe(false);
    const continuationIds = continuationMarkers.map(({ callId }) => callId).sort(compareStrings);
    const continuationCallEvents = finalEvents.slice(partialState.events.length).filter(isProviderCallEvent);
    expect(continuationCallEvents).toHaveLength(4);
    const continuationEventCallIds = continuationCallEvents.map((event) => {
      if (typeof event.callId !== "string") throw new Error("PAR-033 continuation call event has no call identity.");
      return event.callId;
    });
    expect(continuationEventCallIds.sort(compareStrings)).toEqual([...continuationIds, ...continuationIds].sort(compareStrings));
    for (const callId of continuationIds) {
      expect(continuationCallEvents.filter((event) => event.callId === callId && event.event === "provider.call.started")).toHaveLength(1);
      expect(continuationCallEvents.filter((event) => event.callId === callId && event.event === "provider.call.completed")).toHaveLength(1);
    }
    const appendedMetrics = finalMetrics.slice(initialState.metrics.length);
    expect(appendedMetrics.map(metricCallId).sort(compareStrings)).toEqual(continuationIds);

    const continuationFixtureEvents = readFixtureEvents(eventsPath).filter((event) => event.stage === "inference-started" && event.attempt === 2);
    expect(continuationFixtureEvents).toHaveLength(2);
    for (const event of continuationFixtureEvents) {
      const nodeId = event.role as "a" | "b";
      const invocation = invocationByNode.get(nodeId);
      const oldRequest = nodeId === "a" ? aRequest : bRequest;
      expect(event).toMatchObject({ runId, callId: invocation?.callId, attempt: 2, promptAnswers: answerFor(nodeId) });
      expect(event.promptAnswers).not.toHaveProperty(nodeId === "a" ? "bApproval" : "aApproval");
      expect(invocation?.parentCallId).toBe(oldRequest.callId);
    }
    const outputs = outputArtifacts(finalResult.result);
    expect(outputs.map(({ name, contract }) => ({ name, contract }))).toEqual([
      { name: "bFinal", contract: "report.v1" },
      { name: "aFinal", contract: "report.v1" },
    ]);
    expect(outputs.map((artifact) => artifact.data)).toEqual([
      { text: "b-continued-B-approved" },
      { text: "a-continued-A-approved" },
    ]);
    expect(JSON.parse(readFileSync(path.join(runDirectory(project, runId), "outputs.json"), "utf8"))).toEqual(outputs);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  for (const releasePath of Object.values(releasePaths)) {
    try {
      mkdirSync(path.dirname(releasePath), { recursive: true });
      if (!existsSync(releasePath)) writeFileSync(releasePath, "cleanup release\n", { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) cleanupErrors.push(asError(error));
    }
  }

  let driversClosed = false;
  try {
    await withDeadline(Promise.all(driverHandles.map((handle) => handle.closed)), cleanupDeadline, "fresh driver close events");
    driversClosed = true;
  } catch (error) {
    cleanupErrors.push(asError(error));
  }

  if (driversClosed && driverHandles.length === 3 && !hasPrimaryError && cleanupErrors.length === 0) {
    try {
      assertOwnedProject(project, projectIdentity, label);
      rmSync(project, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(asError(error));
    }
  } else if (!hasPrimaryError && driversClosed && driverHandles.length !== 3) {
    cleanupErrors.push(new Error(`PAR-033 expected three completed fresh drivers but observed ${driverHandles.length}; retained project at ${project}.`));
  }

  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], `PAR-033 scenario failed; retained evidence at ${project}.`);
  if (hasPrimaryError) throw new Error(`PAR-033 scenario failed; retained evidence at ${project}: ${describeError(primaryError)}`, { cause: primaryError });
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `PAR-033 cleanup failed; retained evidence at ${project}.`);
}

function configureProject(
  project: string,
  eventsPath: string,
  stateDirectory: string,
  startedPaths: Record<string, string>,
  releasePaths: { a: string; b: string },
): { providerSentinel: string; validatorSentinel: string } {
  const fixtureBytes = readFileSync(fixtureSource);
  const canonicalFixtureBytes = Buffer.from(fixtureBytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  expect(digest(canonicalFixtureBytes)).toBe(expectedFixtureSha256);
  const sentinels = configureParallelProject(project);
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const projectFixture = path.join(fixtureDirectory, "par-031-graph-provider.mjs");
  writeFileSync(projectFixture, fixtureBytes);
  expect(readFileSync(projectFixture).equals(fixtureBytes)).toBe(true);
  writeFileSync(path.join(fixtureDirectory, "par-031-control.json"), JSON.stringify({
    eventsPath: path.relative(project, eventsPath),
    fixtureLifetimeMs,
    startedPaths: Object.fromEntries(Object.entries(startedPaths).map(([key, value]) => [key, path.relative(project, value)])),
    releasePaths: Object.fromEntries(Object.entries(releasePaths).map(([key, value]) => [key, path.relative(project, value)])),
  }), "utf8");

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  const baseProfile = profiles.fixture ?? {};
  for (const role of roles) {
    const wrapper = path.join(fixtureDirectory, process.platform === "win32" ? `par-033-${role}.cmd` : `par-033-${role}.sh`);
    if (process.platform === "win32") {
      writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-031-graph-provider.mjs" "${role}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    } else {
      writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-031-graph-provider.mjs' '${role}' "$@"\n`, "utf8");
      chmodSync(wrapper, 0o755);
    }
    profiles[role] = {
      ...baseProfile,
      enabled: true,
      executable: wrapper,
      kind: "codex",
      model: `p4c1-${role}`,
      timeoutMs: profileTimeoutMs,
      capabilities: [],
      sandbox: "read-only",
    };
  }
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = [...roles];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { seed: [], b: ["seed"], a: ["seed"] };
  workflow.execution.resources = { seed: [], b: [], a: [] };
  workflow.outputs = [
    { name: "bFinal", from: "b.report", contract: "report.v1" },
    { name: "aFinal", from: "a.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  const template = readProjectJson(project, ".nodulus/nodes/prepare.json");
  for (const role of roles) {
    const instruction = `.nodulus/instructions/${role}.md`;
    writeFileSync(path.join(project, instruction), `P4C1 fresh-process continuation instructions for ${role}.\n`, "utf8");
    const inputs = role === "seed"
      ? { request: { from: "request", contract: "request.v1" } }
      : { report: { from: "seed.report", contract: "report.v1" } };
    writeJson(project, `.nodulus/nodes/${role}.json`, {
      ...template,
      id: role,
      providerProfile: role,
      instructions: [instruction],
      inputs,
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
  }
  return sentinels;
}

function startDriver(
  handles: DriverHandle[],
  operation: DriverOperation,
  nonce: string,
  project: string,
  runId?: string,
  requestId?: string,
  answersPath?: string,
): DriverHandle {
  const args = [driverSource, operation, nonce, project];
  if (operation !== "initial") args.push(runId ?? "", requestId ?? "", answersPath ?? "");
  const child = spawn(process.execPath, args, { cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const handle: DriverHandle = {
    operation,
    nonce,
    child,
    closed: Promise.resolve({ code: null, signal: null }),
    stdout: [],
    stderr: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    outputOverflow: false,
  };
  handle.closed = new Promise((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal, ...(spawnError === undefined ? {} : { error: spawnError }) }));
  });
  child.stdin.on("error", (error) => { handle.stdinError = boundedDriverError(error); });
  child.stdout.on("data", (chunk: Buffer | string) => appendBoundedOutput(handle, "stdout", chunk));
  child.stderr.on("data", (chunk: Buffer | string) => appendBoundedOutput(handle, "stderr", chunk));
  child.stdin.end();
  void handle.closed.catch(() => undefined);
  handles.push(handle);
  if (typeof child.pid !== "number" || !Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error(`PAR-033 ${operation} driver has no operating-system PID.`);
  return handle;
}

function appendBoundedOutput(handle: DriverHandle, stream: "stdout" | "stderr", chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
  const stored = stream === "stdout" ? handle.stdout : handle.stderr;
  const key = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
  const remaining = maxCapturedDriverOutputBytes - handle[key];
  if (remaining <= 0) {
    handle.outputOverflow = true;
    return;
  }
  stored.push(bytes.subarray(0, remaining));
  handle[key] += Math.min(bytes.length, remaining);
  if (bytes.length > remaining) handle.outputOverflow = true;
}

async function readDriverEnvelope(handle: DriverHandle, deadline: number): Promise<DriverEnvelope> {
  const closed = await withDeadline(handle.closed, deadline, `${handle.operation} fresh driver close`);
  if (closed.error) throw new Error(`PAR-033 ${handle.operation} driver could not start: ${closed.error.message}`);
  if (closed.code !== 0 || closed.signal !== null) {
    throw new Error(`PAR-033 ${handle.operation} driver exited code=${String(closed.code)} signal=${String(closed.signal)}; stdout=${driverOutput(handle.stdout)}; stderr=${driverOutput(handle.stderr)}`);
  }
  if (handle.stdinError) throw new Error(`PAR-033 ${handle.operation} driver stdin failed: ${handle.stdinError.message}`, { cause: handle.stdinError });
  if (handle.outputOverflow) throw new Error(`PAR-033 ${handle.operation} driver exceeded its bounded stdio capture; stderr=${driverOutput(handle.stderr)}`);
  const stdout = Buffer.concat(handle.stdout).toString("utf8");
  const stderr = Buffer.concat(handle.stderr).toString("utf8");
  expect(stderr, `PAR-033 ${handle.operation} driver stderr`).toBe("");
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  expect(lines, `PAR-033 ${handle.operation} driver must emit one bounded envelope`).toHaveLength(1);
  const envelope = JSON.parse(lines[0]!) as DriverEnvelope;
  expect(envelope.protocol).toBe("par-033-fresh-resume-driver-v1");
  expect(envelope.operation).toBe(handle.operation);
  expect(envelope.nonce).toBe(handle.nonce);
  if ("driverError" in (envelope as unknown as Record<string, unknown>)) {
    throw new Error(`PAR-033 ${handle.operation} driver setup failed: ${JSON.stringify((envelope as unknown as Record<string, unknown>).driverError)}`);
  }
  expect(envelope.settled).toEqual({ public: true, delegated: true });
  expect(envelope.observations.observationLimitExceeded).toBe(false);
  return envelope;
}

function driverOutput(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").slice(-1800);
}

function boundedDriverError(error: Error): Error {
  return new Error(`${error.name.slice(0, 100)}: ${error.message.slice(0, 1000)}`, { cause: error });
}

function requestProjection(value: unknown): { request: PendingRequest; requests: PendingRequest[] } {
  if (!isRecord(value) || !isRecord(value.request) || !Array.isArray(value.requests)) {
    throw new Error("PAR-033 public result has no request/requests projection.");
  }
  return { request: value.request as unknown as PendingRequest, requests: value.requests as PendingRequest[] };
}

function requireResult(envelope: DriverEnvelope, operation: string): { runId: string; status: string; result: unknown } {
  if (envelope.outcome.kind === "error") {
    throw new Error(`PAR-033 ${operation} rejected (${envelope.outcome.error.name}${envelope.outcome.error.code ? ` ${envelope.outcome.error.code}` : ""}): ${envelope.outcome.error.message}`);
  }
  return envelope.outcome.result;
}

function assertRequest(request: PendingRequest, nodeId: "a" | "b", marker: ProviderMarker): void {
  expect(request).toMatchObject({ nodeId, callId: marker.callId, attempt: 1 });
  expect(request.questions).toHaveLength(1);
  expect(request.questions[0]).toMatchObject({ id: `${nodeId}-question` });
}

function captureInitialState(
  project: string,
  runId: string,
  eventsPath: string,
  markers: { seed: ProviderMarker; b: ProviderMarker; a: ProviderMarker },
  requests: { b: PendingRequest; a: PendingRequest },
): InitialState {
  const runRoot = runDirectory(project, runId);
  const checkpoint = readCheckpoint(project, runId);
  const acceptedSeed = checkpoint.graph.nodes.seed?.accepted;
  if (!acceptedSeed) throw new Error("PAR-033 seed acceptance record is missing after the initial pause.");
  const immutableFiles = new Map<string, CapturedFile>();
  for (const reference of [acceptedSeed.resultRef, acceptedSeed.validationRef, acceptedSeed.responseRef, ...acceptedSeed.artifacts.map((artifact) => artifact.ref)]) {
    captureFileInto(runRoot, reference, immutableFiles);
  }
  for (const marker of [markers.seed, markers.b, markers.a]) {
    captureTree(runRoot, `calls/${marker.callId}`, immutableFiles);
    captureTree(runRoot, `nodes/${marker.nodeId}/attempt-001`, immutableFiles);
  }
  for (const request of [requests.b, requests.a]) captureFileInto(runRoot, `pending/${request.id}.json`, immutableFiles);
  const metricBytes = readFileSync(path.join(runRoot, "metrics.json"));
  const fixtureEventBytes = readFileSync(eventsPath);
  return {
    runId,
    requests,
    markers,
    acceptedSeed: structuredClone(acceptedSeed),
    inputBytes: readFileSync(path.join(runRoot, "inputs.json")),
    events: readRunEvents(project, runId),
    metrics: structuredClone(readMetrics(project, runId)),
    metricBytes,
    fixtureEventBytes,
    immutableFiles,
  };
}

function capturePartialState(project: string, runId: string, eventsPath: string): PartialState {
  const runRoot = runDirectory(project, runId);
  const metricBytes = readFileSync(path.join(runRoot, "metrics.json"));
  return {
    events: readRunEvents(project, runId),
    metrics: structuredClone(readMetrics(project, runId)),
    metricBytes,
    fixtureEventBytes: readFileSync(eventsPath),
  };
}

function assertSeedEvidence(project: string, runId: string, initial: InitialState): void {
  const checkpoint = readCheckpoint(project, runId);
  expect(checkpoint.graph.nodes.seed?.accepted).toEqual(initial.acceptedSeed);
  expect(checkpoint.graph.nodes.seed).toMatchObject({ phase: "accepted", callId: initial.markers.seed.callId, attempt: 1 });
  expect(checkpoint.completedNodes.filter((nodeId) => nodeId === "seed")).toHaveLength(1);
  expect(readFileSync(path.join(runDirectory(project, runId), "inputs.json")).equals(initial.inputBytes)).toBe(true);
  for (const reference of [initial.acceptedSeed.resultRef, initial.acceptedSeed.validationRef, initial.acceptedSeed.responseRef, ...initial.acceptedSeed.artifacts.map((artifact) => artifact.ref)]) {
    const captured = initial.immutableFiles.get(reference.replaceAll("\\", "/"));
    if (!captured) throw new Error(`PAR-033 accepted seed reference '${reference}' was not captured.`);
    const current = readFileSync(path.join(runDirectory(project, runId), reference));
    expect(digest(current)).toBe(captured.sha256);
    expect(current.equals(captured.bytes)).toBe(true);
  }
}

function assertAnswerCommit(project: string, runId: string, request: PendingRequest, answer: Record<string, unknown>, priorEventCount: number): void {
  const relative = `answers/${request.id}.json`;
  const answerBytes = readFileSync(path.join(runDirectory(project, runId), relative));
  expect(JSON.parse(answerBytes.toString("utf8"))).toEqual(answer);
  const pending = readCheckpoint(project, runId).graph.pendingRequests[request.id];
  expect(pending).toMatchObject({ nodeId: request.nodeId, kind: "node", answerRef: relative, answerSha256: digest(answerBytes) });
  const answerEvents = readRunEvents(project, runId).slice(priorEventCount).filter((event) => event.event === "request.answered" && event.requestId === request.id);
  expect(answerEvents).toHaveLength(1);
  expect(answerEvents[0]).toMatchObject({ event: "request.answered", requestId: request.id, kind: "node", nodeId: request.nodeId });
  expect(answerEvents[0]).not.toHaveProperty("answer");
  expect(answerEvents[0]).not.toHaveProperty("answers");
  const serialized = JSON.stringify(answerEvents[0]);
  for (const value of Object.values(answer)) expect(serialized).not.toContain(String(value));
}

function assertTransport(project: string, runId: string, marker: ProviderMarker): void {
  const callRoot = path.join(runDirectory(project, runId), "calls", marker.callId);
  const transport = readJson(path.join(callRoot, "transport.json"));
  expect(transport).toMatchObject({ callId: marker.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
  const request = readJson(path.join(callRoot, "request.json"));
  expect(request).toMatchObject({ nodeId: marker.nodeId, runId: marker.runId, callId: marker.callId, attempt: marker.attempt });
}

function assertContinuationAcceptance(project: string, runId: string, nodeId: "a" | "b", marker: ProviderMarker, text: string): void {
  const runRoot = runDirectory(project, runId);
  const accepted = readCheckpoint(project, runId).graph.nodes[nodeId]?.accepted;
  if (!accepted) throw new Error(`PAR-033 resumed node '${nodeId}' has no accepted record.`);
  expect(accepted).toMatchObject({ attempt: 2, callId: marker.callId });
  const expectedOutcome = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text } }] };
  const resultBytes = readFileSync(path.join(runRoot, accepted.resultRef));
  expect(digest(resultBytes)).toBe(accepted.resultSha256);
  expect(JSON.parse(resultBytes.toString("utf8"))).toEqual(expectedOutcome);
  const validationBytes = readFileSync(path.join(runRoot, accepted.validationRef));
  expect(digest(validationBytes)).toBe(accepted.validationSha256);
  expect(JSON.parse(validationBytes.toString("utf8"))).toMatchObject({ valid: true, outcome: "success" });
  const responseBytes = readFileSync(path.join(runRoot, accepted.responseRef));
  expect(digest(responseBytes)).toBe(accepted.responseSha256);
  expect(JSON.parse(responseBytes.toString("utf8"))).toEqual(expectedOutcome);
  expect(accepted.artifacts).toHaveLength(1);
  const artifact = accepted.artifacts[0];
  if (!artifact) throw new Error(`PAR-033 resumed node '${nodeId}' accepted no output artifact reference.`);
  expect(artifact).toMatchObject({ name: "report", contract: "report.v1" });
  const artifactBytes = readFileSync(path.join(runRoot, artifact.ref));
  expect(digest(artifactBytes)).toBe(artifact.sha256);
  expect(JSON.parse(artifactBytes.toString("utf8"))).toEqual({ name: "report", contract: "report.v1", data: { text } });
}

function assertImmutableEvidence(runRoot: string, files: Map<string, CapturedFile>): void {
  for (const [relative, captured] of files) {
    const current = readFileSync(path.join(runRoot, relative));
    expect(digest(current)).toBe(captured.sha256);
    expect(current.equals(captured.bytes)).toBe(true);
  }
}

function assertContiguousAppendedEvents(events: Array<Record<string, unknown>>, previousLength: number): void {
  const prior = events.slice(0, previousLength);
  const appended = events.slice(previousLength);
  const priorSequences = prior.map((event) => event.sequence).filter((sequence): sequence is number => typeof sequence === "number" && Number.isSafeInteger(sequence));
  const appendedSequences = appended.map((event) => event.sequence);
  expect(appendedSequences.every((sequence) => typeof sequence === "number" && Number.isSafeInteger(sequence))).toBe(true);
  const numeric = appendedSequences as number[];
  expect(new Set(numeric).size).toBe(numeric.length);
  if (numeric.length > 0 && priorSequences.length > 0) expect(numeric[0]).toBe(priorSequences[priorSequences.length - 1]! + 1);
  for (let index = 1; index < numeric.length; index += 1) expect(numeric[index]).toBe(numeric[index - 1]! + 1);
}

async function waitForAcceptedSeed(project: string, runId: string, deadline: number, driver: DriverHandle): Promise<void> {
  await waitForCondition(() => readCheckpoint(project, runId).graph.nodes.seed?.phase === "accepted", deadline, "seed acceptance", driver);
}

async function waitForMarker(file: string, description: string, deadline: number, driver: DriverHandle): Promise<ProviderMarker> {
  await waitForCondition(() => existsSync(file), deadline, description, driver);
  const marker = readMarker(file);
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0 || typeof marker.callId !== "string" || typeof marker.runId !== "string") {
    throw new Error(`PAR-033 ${description} marker has invalid process or call identity.`);
  }
  return marker;
}

function readMarker(file: string): ProviderMarker {
  const marker = readJson(file) as unknown as ProviderMarker;
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0 || typeof marker.callId !== "string" || typeof marker.runId !== "string"
    || typeof marker.role !== "string" || typeof marker.nodeId !== "string" || !Number.isSafeInteger(marker.attempt)) {
    throw new Error("PAR-033 provider marker has invalid process or call identity.");
  }
  return marker;
}

async function waitForQuestion(project: string, runId: string, marker: ProviderMarker, deadline: number, driver: DriverHandle): Promise<PendingRequest> {
  let found: PendingRequest | undefined;
  await waitForCondition(() => {
    const pendingDirectory = path.join(runDirectory(project, runId), "pending");
    if (!existsSync(pendingDirectory)) return false;
    for (const name of readdirSync(pendingDirectory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const request = JSON.parse(readFileSync(path.join(pendingDirectory, name), "utf8")) as PendingRequest;
        if (request.nodeId !== marker.nodeId || request.callId !== marker.callId || request.attempt !== marker.attempt) continue;
        const bytes = readFileSync(path.join(pendingDirectory, name));
        const committed = readCheckpoint(project, runId).graph.pendingRequests[request.id];
        if (committed?.nodeId === marker.nodeId
          && committed.attempt === marker.attempt
          && committed.requestRef === `pending/${name}`
          && committed.requestSha256 === digest(bytes)
          && readCheckpoint(project, runId).graph.nodes[marker.nodeId]?.callId === marker.callId) {
          found = request;
          return true;
        }
      } catch { /* request and checkpoint may be in the middle of atomic publication */ }
    }
    return false;
  }, deadline, `${marker.nodeId} committed runtime question`, driver);
  if (!found) throw new Error(`PAR-033 ${marker.nodeId} question was not found after its committed checkpoint.`);
  return found;
}

async function waitForCondition(predicate: () => boolean, deadline: number, description: string, driver: DriverHandle): Promise<void> {
  while (!predicate()) {
    if (driver.child.exitCode !== null || driver.child.signalCode !== null) {
      throw new Error(`PAR-033 fresh ${driver.operation} driver closed before ${description}: ${driverOutput(driver.stdout)} ${driverOutput(driver.stderr)}`);
    }
    assertBeforeDeadline(deadline, description);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`PAR-033 shared deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`PAR-033 shared deadline expired during ${description}.`)), remaining); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function outputArtifacts(value: unknown): Array<{ name: string; contract: string; data: unknown }> {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) throw new Error("PAR-033 completed public result has no output artifact array.");
  return value.artifacts as Array<{ name: string; contract: string; data: unknown }>;
}

function readCheckpoint(project: string, runId: string): GraphCheckpoint {
  return readJson(path.join(runDirectory(project, runId), "run.json")) as unknown as GraphCheckpoint;
}

function readRunEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(runDirectory(project, runId), "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readMetrics(project: string, runId: string): unknown[] {
  const metrics = JSON.parse(readFileSync(path.join(runDirectory(project, runId), "metrics.json"), "utf8")) as unknown;
  if (!Array.isArray(metrics)) throw new Error("PAR-033 metrics.json is not a provider-call array.");
  return metrics;
}

function readFixtureEvents(eventsPath: string): FixtureEvent[] {
  return readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function captureFileInto(runRoot: string, relative: string, files: Map<string, CapturedFile>): void {
  const normalized = relative.replaceAll("\\", "/");
  const bytes = readFileSync(path.join(runRoot, relative));
  files.set(normalized, { bytes, sha256: digest(bytes) });
}

function captureTree(runRoot: string, relative: string, files: Map<string, CapturedFile>): void {
  const root = path.join(runRoot, relative);
  if (!existsSync(root)) throw new Error(`PAR-033 expected evidence directory '${relative}'.`);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) captureFileInto(runRoot, path.relative(runRoot, child), files);
    }
  };
  visit(root);
}

function runDirectory(project: string, runId: string): string {
  return path.join(project, ".nodulus", "runs", runId);
}

function answerContract(role: "a" | "b"): Record<string, unknown> {
  const key = role === "a" ? "aApproval" : "bApproval";
  const value = role === "a" ? "A-approved" : "B-approved";
  return { type: "object", required: [key], properties: { [key]: { const: value, type: "string" } }, additionalProperties: false };
}

function answerFor(role: "a" | "b"): Record<string, unknown> {
  return role === "a" ? { aApproval: "A-approved" } : { bApproval: "B-approved" };
}

function metricCallId(metric: unknown): string {
  if (!isRecord(metric) || typeof metric.callId !== "string") throw new Error("PAR-033 provider metric is missing its call identity.");
  return metric.callId;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isProviderCallEvent(event: Record<string, unknown>): boolean {
  return event.event === "provider.call.started" || event.event === "provider.call.completed";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH"); }
}

function assertBeforeDeadline(deadline: number, operation: string): void {
  if (Date.now() >= deadline) throw new Error(`PAR-033 shared scenario deadline expired during ${operation}.`);
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const nativeTemp = realpathSync.native(tmpdir());
  const current = realpathSync.native(project);
  if (current !== identity || path.dirname(identity) !== nativeTemp || !path.basename(identity).startsWith(`nodulus-${label}-`)) {
    throw new Error("PAR-033 refused cleanup outside its exact native temporary project.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("PAR-033 cleanup failed with a non-Error value.");
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : "a non-Error failure";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

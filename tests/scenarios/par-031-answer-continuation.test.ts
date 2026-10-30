import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { resumeWorkflow, runWorkflow, type ApplicationRunResult, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type Outcome = { kind: "result"; result: ApplicationRunResult } | { kind: "error"; error: unknown };
type Role = "seed" | "b" | "a";
type FixtureEvent = { stage: string; role: string; pid: number; atMs: number; nodeId?: string; runId?: string; callId?: string; attempt?: number; promptAnswers?: Record<string, unknown> };
type ProviderMarker = { role: Role; nodeId: Role; runId: string; callId: string; attempt: number; pid: number };
type PendingRequest = { id: string; nodeId: string; attempt: number; callId: string; questions: Array<{ id: string; message: string }>; answerContract: Record<string, unknown> };
type AcceptedRecord = { attempt: number; callId: string; resultRef: string; resultSha256: string; validationRef: string; validationSha256: string; responseRef: string; responseSha256: string; artifacts: Array<{ name: string; contract: string; ref: string; sha256: string }> };
type GraphCheckpoint = { runId: string; status: string; graph: { nextEventSequence?: number; nodes: Record<string, { phase?: string; attempt?: number; callId?: string; accepted?: AcceptedRecord }>; pendingRequests: Record<string, Record<string, unknown>> } };
type InvocationObservation = { nodeId: string; callId?: string; attempt: number; parentCallId?: string; answers?: Record<string, unknown> };
type ObservationLog = { availability: string[]; invocations: InvocationObservation[]; repairs: number; telemetry: number; launches: number; legacyUsage: number; delegatedSettlements: Array<Promise<void>>; publicSettlements: Array<Promise<void>> };
type ProviderActivity = Pick<ObservationLog, "availability" | "invocations" | "repairs" | "telemetry" | "launches" | "legacyUsage">;
type CapturedFile = { bytes: Buffer; sha256: string };
type InitialState = { runId: string; requests: { b: PendingRequest; a: PendingRequest }; markers: { seed: ProviderMarker; b: ProviderMarker; a: ProviderMarker }; inputBytes: Buffer; events: Array<Record<string, unknown>>; metricsCalls: unknown[]; immutableFiles: Map<string, CapturedFile> };

const fixtureSource = fileURLToPath(new URL("../fixtures/par-031-graph-provider.mjs", import.meta.url));
const roles: Role[] = ["seed", "b", "a"];
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 35_000;
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;

test("PAR-031 rejects mismatched and invalid answers without mutation, then durably applies only A", async () => {
  await exerciseAnswerContinuation("partial");
}, testCeilingMs);

test("PAR-031 resumes A and B once with isolated answers and preserves prior run history", async () => {
  await exerciseAnswerContinuation("complete");
}, testCeilingMs);

async function exerciseAnswerContinuation(mode: "partial" | "complete"): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = `par-031-answer-continuation-${mode}`;
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const stateDirectory = path.join(fixtureDirectory, "par-031-state");
  const eventsPath = path.join(stateDirectory, "events.jsonl");
  const startedPaths = Object.fromEntries(roles.flatMap((role) => [1, 2].map((attempt) => [`${role}-${attempt}`, path.join(stateDirectory, `${role}-${attempt}.started.json`)]))) as Record<string, string>;
  const releasePaths = { a: path.join(stateDirectory, "release-a"), b: path.join(stateDirectory, "release-b") };
  const cleanupErrors: Error[] = [];
  const observations: ObservationLog = { availability: [], invocations: [], repairs: 0, telemetry: 0, launches: 0, legacyUsage: 0, delegatedSettlements: [], publicSettlements: [] };
  let initialRun: Promise<Outcome> | undefined;
  let observedInitial: Outcome | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;

  try {
    assertOwnedProject(project, projectIdentity, label);
    const sentinels = configureProject(project, eventsPath, stateDirectory, startedPaths, releasePaths);
    assertBeforeDeadline(scenarioDeadline, "project setup");
    const initialProvider = observeProvider(project, observations);
    initialRun = capturePublic(runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Resolve independent branch questions and preserve their saved answers." }],
    }, initialProvider), observations);
    void initialRun.then((outcome) => { observedInitial = outcome; });

    const seedMarkerPromise = waitForMarker(startedPaths["seed-1"], "seed inference", scenarioDeadline, () => observedInitial);
    const bMarkerPromise = waitForMarker(startedPaths["b-1"], "B initial inference", scenarioDeadline, () => observedInitial);
    const aMarkerPromise = waitForMarker(startedPaths["a-1"], "A initial inference", scenarioDeadline, () => observedInitial);
    const seedAcceptedPromise = seedMarkerPromise.then((marker) => waitForAcceptedSeed(project, marker.runId, scenarioDeadline, () => observedInitial));
    const [seedMarker, , bMarker, aMarker] = await withDeadline(Promise.all([seedMarkerPromise, seedAcceptedPromise, bMarkerPromise, aMarkerPromise]), scenarioDeadline, "seed and question process barriers");
    expect(bMarker).toMatchObject({ nodeId: "b", runId: seedMarker.runId, attempt: 1 });
    expect(aMarker).toMatchObject({ nodeId: "a", runId: seedMarker.runId, attempt: 1 });
    expect(isProcessAlive(bMarker.pid), "B's real question process must be alive before its barrier is released.").toBe(true);
    expect(isProcessAlive(aMarker.pid), "A's real question process must be alive before its barrier is released.").toBe(true);

    writeFileSync(releasePaths.a, "release\n", { encoding: "utf8", flag: "wx" });
    const aRequest = await waitForQuestion(project, seedMarker.runId, aMarker, scenarioDeadline, () => observedInitial);
    writeFileSync(releasePaths.b, "release\n", { encoding: "utf8", flag: "wx" });
    const initialOutcome = await awaitOutcome(initialRun, scenarioDeadline, "initial two-question pause", () => observedInitial);
    const paused = requireResult(initialOutcome);
    expect(paused.runId).toBe(seedMarker.runId);
    expect(paused.status).toBe("needs_input");
    const requestProjection = paused.result as { request?: PendingRequest; requests?: PendingRequest[] };
    expect(requestProjection.requests?.map((request) => request.nodeId)).toEqual(["b", "a"]);
    expect(requestProjection.requests?.[1]).toEqual(aRequest);
    expect(requestProjection.request).toEqual(requestProjection.requests?.[0]);
    const bRequest = requestProjection.requests?.[0];
    if (!bRequest) throw new Error("P4B initial graph did not return the B runtime request.");
    const bEvidence = await waitForQuestion(project, paused.runId, bMarker, scenarioDeadline, () => observedInitial);
    expect(bEvidence).toEqual(bRequest);
    expect(isUuid(aRequest.id)).toBe(true);
    expect(isUuid(bRequest.id)).toBe(true);
    expect(aRequest.id).not.toBe("provider-untrusted-a");
    expect(bRequest.id).not.toBe("provider-untrusted-b");
    expect(aRequest.answerContract).toEqual(answerContract("a"));
    expect(bRequest.answerContract).toEqual(answerContract("b"));
    expect(readCheckpoint(project, paused.runId).graph.nodes.seed?.phase).toBe("accepted");
    assertTransport(project, paused.runId, seedMarker);
    assertTransport(project, paused.runId, bMarker);
    assertTransport(project, paused.runId, aMarker);

    const initialState = captureInitialState(project, paused.runId, { seed: seedMarker, b: bMarker, a: aMarker }, { b: bRequest, a: aRequest });
    expect(initialState.events.length).toBeGreaterThan(0);
    expect(initialState.metricsCalls).toHaveLength(3);
    expect(observations.invocations.map((call) => call.nodeId).sort((left, right) => left.localeCompare(right))).toEqual(["a", "b", "seed"]);
    expect(observations.invocations).toHaveLength(3);
    expect(readFixtureEvents(eventsPath).filter((event) => event.stage === "inference-started" && event.attempt === 1)).toHaveLength(3);
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);

    const providerEventsBeforeResume = readFileSync(eventsPath);
    const observationsBeforeResume = snapshotProviderActivity(observations);
    const availabilityCountBeforeResume = observations.availability.length;
    const runTreeBeforeResume = snapshotRunTree(project, paused.runId);
    const wrongIdPromise = capturePublic(resumeWorkflow({
      projectRoot: project,
      runId: paused.runId,
      requestId: randomUUID(),
      answers: { aApproval: "A-approved" },
    }, observeProvider(project, observations)), observations);
    const wrongIdOutcome = await withDeadline(wrongIdPromise, scenarioDeadline, "mismatched request rejection");
    expect(snapshotRunTree(project, paused.runId)).toEqual(runTreeBeforeResume);
    expect(readFileSync(eventsPath).equals(providerEventsBeforeResume)).toBe(true);
    expect(snapshotProviderActivity(observations)).toEqual(observationsBeforeResume);

    const invalidAnswerPromise = capturePublic(resumeWorkflow({
      projectRoot: project,
      runId: paused.runId,
      requestId: aRequest.id,
      answers: { aApproval: "" },
    }, observeProvider(project, observations)), observations);
    const invalidAnswerOutcome = await withDeadline(invalidAnswerPromise, scenarioDeadline, "invalid answer rejection");
    expect(snapshotRunTree(project, paused.runId)).toEqual(runTreeBeforeResume);
    expect(readFileSync(eventsPath).equals(providerEventsBeforeResume)).toBe(true);
    expect(snapshotProviderActivity(observations)).toEqual(observationsBeforeResume);

    const answeredAPromise = capturePublic(resumeWorkflow({
      projectRoot: project,
      runId: paused.runId,
      requestId: aRequest.id,
      answers: answerFor("a"),
    }, observeProvider(project, observations)), observations);
    const answeredAOutcome = await withDeadline(answeredAPromise, scenarioDeadline, "partial A answer continuation");

    expect(wrongIdOutcome.kind).toBe("error");
    if (wrongIdOutcome.kind === "error") expect(wrongIdOutcome.error).toMatchObject({ code: "PENDING_REQUEST_MISMATCH" });
    expect(invalidAnswerOutcome.kind).toBe("error");
    if (invalidAnswerOutcome.kind === "error") expect(invalidAnswerOutcome.error).toMatchObject({ code: "ANSWERS_INVALID" });
    expect(answeredAOutcome.kind).toBe("result");
    if (answeredAOutcome.kind === "result") {
      const partial = answeredAOutcome.result;
      expect(partial.status).toBe("needs_input");
      const partialProjection = partial.result as { request?: PendingRequest; requests?: PendingRequest[] };
      expect(partialProjection.requests?.map((request) => request.nodeId)).toEqual(["b"]);
      expect(partialProjection.request).toEqual(partialProjection.requests?.[0]);
      expect(snapshotProviderActivity(observations)).toEqual(observationsBeforeResume);
      expect(readFileSync(eventsPath).equals(providerEventsBeforeResume)).toBe(true);
      assertHistoryPrefix(project, paused.runId, initialState);
      assertImmutableEvidence(project, paused.runId, initialState.immutableFiles);
      assertAnswerCommit(project, paused.runId, aRequest, answerFor("a"), initialState.events.length);
      const pendingAfterA = readCheckpoint(project, paused.runId);
      expect(pendingAfterA.status).toBe("needs_input");
      expect(pendingAfterA.graph.pendingRequests[aRequest.id]).toMatchObject({
        nodeId: "a",
        kind: "node",
        answerRef: `answers/${aRequest.id}.json`,
        answerSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(pendingAfterA.graph.pendingRequests[bRequest.id]).toMatchObject({ nodeId: "b", kind: "node" });

      if (mode === "complete") {
        const stateAfterA = captureIntermediateState(project, paused.runId, eventsPath);
        expect(stateAfterA.metricsCalls).toEqual(initialState.metricsCalls);
        const finalPromise = capturePublic(resumeWorkflow({
          projectRoot: project,
          runId: paused.runId,
          requestId: bRequest.id,
          answers: answerFor("b"),
        }, observeProvider(project, observations)), observations);
        const finalOutcome = await withDeadline(finalPromise, scenarioDeadline, "final B answer continuation");
        expect(finalOutcome.kind).toBe("result");
        if (finalOutcome.kind === "result") {
          const completed = finalOutcome.result;
          expect(completed.runId).toBe(paused.runId);
          expect(completed.status).toBe("success");
          expect(observations.availability.slice(availabilityCountBeforeResume)).not.toContain("p4b-seed");
          assertHistoryPrefix(project, paused.runId, initialState);
          assertImmutableEvidence(project, paused.runId, initialState.immutableFiles);
          assertIntermediateHistory(project, paused.runId, stateAfterA);
          const finalFixtureEvents = readFileSync(eventsPath);
          expect(finalFixtureEvents.subarray(0, stateAfterA.fixtureEvents.length).equals(stateAfterA.fixtureEvents)).toBe(true);
          assertAnswerCommit(project, paused.runId, bRequest, answerFor("b"), stateAfterA.events.length);

          const finalCheckpoint = readCheckpoint(project, paused.runId);
          expect(finalCheckpoint.status).toBe("success");
          expect(finalCheckpoint.graph.nodes.seed).toMatchObject({ phase: "accepted", callId: seedMarker.callId, attempt: 1 });
          expect(finalCheckpoint.graph.nodes.a).toMatchObject({ phase: "accepted", attempt: 2 });
          expect(finalCheckpoint.graph.nodes.b).toMatchObject({ phase: "accepted", attempt: 2 });
          const finalMetrics = readMetrics(project, paused.runId);
          expect(finalMetrics).toHaveLength(5);
          expect(finalMetrics.slice(0, initialState.metricsCalls.length)).toEqual(initialState.metricsCalls);
          const continuedInvocations = observations.invocations.filter((call) => call.attempt === 2);
          expect(continuedInvocations.map((call) => call.nodeId).sort((left, right) => left.localeCompare(right))).toEqual(["a", "b"]);
          expect(continuedInvocations).toHaveLength(2);
          const invocationByNode = new Map(continuedInvocations.map((call) => [call.nodeId, call]));
          for (const [nodeId, oldRequest] of [["a", aRequest], ["b", bRequest]] as const) {
            const invocation = invocationByNode.get(nodeId);
            expect(invocation).toMatchObject({ nodeId, attempt: 2, parentCallId: oldRequest.callId, answers: answerFor(nodeId) });
            expect(invocation?.callId).toEqual(expect.any(String));
            expect(invocation?.callId).not.toBe(oldRequest.callId);
            expect(observations.invocations.filter((call) => call.nodeId === nodeId)).toHaveLength(2);
          }
          expect(observations.invocations.filter((call) => call.nodeId === "seed")).toHaveLength(1);
          const continuedCallIds = continuedInvocations.map((call) => call.callId).filter((callId): callId is string => callId !== undefined).sort((left, right) => left.localeCompare(right));
          const finalMetricCallIds = finalMetrics.slice(initialState.metricsCalls.length).map((metric) => metricCallId(metric)).sort((left, right) => left.localeCompare(right));
          expect(finalMetricCallIds).toEqual(continuedCallIds);

          const continuationEvents = readFixtureEvents(eventsPath).filter((event) => event.stage === "inference-started" && event.attempt === 2);
          expect(continuationEvents.map((event) => event.role).sort((left, right) => left.localeCompare(right))).toEqual(["a", "b"]);
          expect(continuationEvents).toHaveLength(2);
          for (const event of continuationEvents) {
            const nodeId = event.role as "a" | "b";
            expect(event.promptAnswers).toEqual(answerFor(nodeId));
            expect(event.promptAnswers).not.toHaveProperty(nodeId === "a" ? "bApproval" : "aApproval");
            const continued = invocationByNode.get(nodeId);
            expect(event).toMatchObject({ runId: paused.runId, callId: continued?.callId, attempt: 2 });
          }
          const outputs = (completed.result as { artifacts?: Array<{ name: string; contract: string; data: { text: string } }> }).artifacts;
          expect(outputs?.map(({ name, contract }) => ({ name, contract }))).toEqual([
            { name: "bFinal", contract: "report.v1" },
            { name: "aFinal", contract: "report.v1" },
          ]);
          expect(outputs?.map((artifact) => artifact.data.text)).toEqual(["b-continued-B-approved", "a-continued-A-approved"]);
          expect(JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", paused.runId, "outputs.json"), "utf8"))).toEqual(outputs);
          assertTransportForInvocations(project, paused.runId, continuedInvocations);
          assertContiguousRunEvents(project, paused.runId, stateAfterA);
        }
      }
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  for (const releasePath of Object.values(releasePaths)) {
    try {
      mkdirSync(path.dirname(releasePath), { recursive: true });
      if (!existsSync(releasePath)) writeFileSync(releasePath, "cleanup release\n", { encoding: "utf8", flag: "wx" });
    } catch (error) { if (!isAlreadyExists(error)) cleanupErrors.push(asError(error)); }
  }
  let operationsDrained = false;
  let processesExited = false;
  const operationsDrain = Promise.all([...observations.publicSettlements])
    .then(() => Promise.all([...observations.delegatedSettlements]))
    .then(() => true);
  const processesDrain = waitForInferencePids(startedPaths, cleanupDeadline).then((exited) => ({ exited }), (error: unknown) => {
    cleanupErrors.push(asError(error));
    return { exited: false };
  });
  try {
    const [drained, processResult] = await withDeadline(Promise.all([operationsDrain, processesDrain]), cleanupDeadline, "all public, delegated and child operations cleanup");
    operationsDrained = drained;
    processesExited = processResult.exited;
  } catch (error) { cleanupErrors.push(asError(error)); }

  if (operationsDrained && processesExited) {
    if (!hasPrimaryError && cleanupErrors.length === 0) {
      try {
        assertOwnedProject(project, projectIdentity, label);
        rmSync(project, { recursive: true, force: true });
      } catch (error) { cleanupErrors.push(asError(error)); }
    }
  } else {
    cleanupErrors.push(new Error(`P4B retained its owned project because public, delegated, or child operations did not settle: ${project}`));
  }

  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "P4B scenario failed and cleanup also reported errors.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P4B cleanup failed.");
}

function configureProject(project: string, eventsPath: string, stateDirectory: string, startedPaths: Record<string, string>, releasePaths: Record<"a" | "b", string>): { providerSentinel: string; validatorSentinel: string } {
  const sentinels = configureParallelProject(project);
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  writeFileSync(path.join(fixtureDirectory, "par-031-graph-provider.mjs"), readFileSync(fixtureSource, "utf8"), "utf8");
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
    const wrapper = path.join(fixtureDirectory, process.platform === "win32" ? `par-031-${role}.cmd` : `par-031-${role}.sh`);
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
      model: `p4b-${role}`,
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
  for (const nodeId of roles) {
    const instruction = `.nodulus/instructions/${nodeId}.md`;
    writeFileSync(path.join(project, instruction), `P4B local continuation instructions for ${nodeId}.\n`, "utf8");
    const inputs = nodeId === "seed"
      ? { request: { from: "request", contract: "request.v1" } }
      : { report: { from: "seed.report", contract: "report.v1" } };
    writeJson(project, `.nodulus/nodes/${nodeId}.json`, {
      ...template,
      id: nodeId,
      providerProfile: nodeId,
      instructions: [instruction],
      inputs,
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
  }
  return sentinels;
}

function observeProvider(project: string, log: ObservationLog): ProviderPort {
  const delegate = createDefaultProviderPort(project);
  return {
    ...delegate,
    invoke(invocation) {
      log.invocations.push({
        nodeId: invocation.nodeId,
        ...(invocation.call?.callId ? { callId: invocation.call.callId } : {}),
        attempt: invocation.attempt,
        ...(invocation.call?.parentCallId ? { parentCallId: invocation.call.parentCallId } : {}),
        ...(invocation.answers === undefined ? {} : { answers: structuredClone(invocation.answers) }),
      });
      return trackDelegated(delegate.invoke(invocation), log);
    },
    ...(delegate.repairResponse ? { repairResponse: (invocation, previousRawResponse, validationErrors) => {
      log.repairs += 1;
      return trackDelegated(delegate.repairResponse!(invocation, previousRawResponse, validationErrors), log);
    } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall: () => { log.legacyUsage += 1; return delegate.usageForLastCall!(); } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall: (callId) => { log.telemetry += 1; return delegate.telemetryForCall!(callId); } } : {}),
    ...(delegate.launchForCall ? { launchForCall: (callId) => { log.launches += 1; return delegate.launchForCall!(callId); } } : {}),
    ...(delegate.isAvailable ? { isAvailable: (profile, options) => {
      log.availability.push(typeof profile.model === "string" ? profile.model : "unknown");
      return trackDelegated(delegate.isAvailable!(profile, options), log);
    } } : {}),
  };
}

function captureOutcome(promise: Promise<ApplicationRunResult>): Promise<Outcome> {
  return promise.then((result) => ({ kind: "result", result }), (error: unknown) => ({ kind: "error", error }));
}

function capturePublic(promise: Promise<ApplicationRunResult>, log: ObservationLog): Promise<Outcome> {
  const outcome = captureOutcome(promise);
  log.publicSettlements.push(outcome.then(() => undefined));
  return outcome;
}

function trackDelegated<T>(operation: T, log: ObservationLog): T {
  if (typeof operation === "object" && operation !== null && "then" in operation && typeof operation.then === "function") {
    log.delegatedSettlements.push(Promise.resolve(operation).then(() => undefined, () => undefined));
  }
  return operation;
}

function snapshotProviderActivity(log: ObservationLog): ProviderActivity {
  return {
    availability: [...log.availability],
    invocations: structuredClone(log.invocations),
    repairs: log.repairs,
    telemetry: log.telemetry,
    launches: log.launches,
    legacyUsage: log.legacyUsage,
  };
}

async function awaitOutcome(promise: Promise<Outcome>, deadline: number, description: string, getOutcome: () => Outcome | undefined): Promise<Outcome> {
  const current = getOutcome();
  return current ?? withDeadline(promise, deadline, description);
}

function requireResult(outcome: Outcome): ApplicationRunResult {
  if (outcome.kind === "error") throw outcome.error;
  return outcome.result;
}

async function waitForAcceptedSeed(project: string, runId: string, deadline: number, getOutcome: () => Outcome | undefined): Promise<void> {
  await waitForCondition(() => {
    try { return readCheckpoint(project, runId).graph.nodes.seed?.phase === "accepted"; }
    catch { return false; }
  }, deadline, "seed acceptance", getOutcome);
}

async function waitForQuestion(project: string, runId: string, marker: ProviderMarker, deadline: number, getOutcome: () => Outcome | undefined): Promise<PendingRequest> {
  const resultPath = path.join(project, ".nodulus", "runs", runId, `nodes/${marker.nodeId}/attempt-001/result.json`);
  await waitForCondition(() => existsSync(resultPath), deadline, `${marker.nodeId} saved question`, getOutcome);
  const saved = readJson(resultPath) as { status?: string; request?: PendingRequest };
  if (saved.status !== "needs_input" || !saved.request) throw new Error(`P4B ${marker.nodeId} did not persist its question.`);
  expect(saved.request).toMatchObject({ nodeId: marker.nodeId, callId: marker.callId, attempt: 1 });
  const pendingPath = path.join(project, ".nodulus", "runs", runId, `pending/${saved.request.id}.json`);
  await waitForCondition(() => existsSync(pendingPath), deadline, `${marker.nodeId} runtime pending record`, getOutcome);
  expect(readJson(pendingPath)).toEqual(saved.request);
  expect(readJson(path.join(project, ".nodulus", "runs", runId, `nodes/${marker.nodeId}/attempt-001/validation.json`))).toEqual({ valid: true, outcome: "needs_input", errors: [] });
  return saved.request;
}

function captureInitialState(project: string, runId: string, markers: Record<Role, ProviderMarker>, requests: Record<"a" | "b", PendingRequest>): InitialState {
  const checkpoint = readCheckpoint(project, runId);
  const seed = checkpoint.graph.nodes.seed?.accepted;
  if (!seed) throw new Error("P4B seed was not accepted before branch questions.");
  const immutableFiles = new Map<string, CapturedFile>();
  for (const reference of [seed.resultRef, seed.validationRef, seed.responseRef, ...seed.artifacts.map((artifact) => artifact.ref)]) {
    const relative = reference.replaceAll("\\", "/");
    const captured = captureFile(path.join(runDirectory(project, runId), reference));
    expect(captured.sha256).toBe(seedHash(seed, reference));
    immutableFiles.set(relative, captured);
  }
  for (const nodeId of roles) {
    captureTree(runDirectory(project, runId), `calls/${markers[nodeId].callId}`, immutableFiles);
    captureTree(runDirectory(project, runId), `nodes/${nodeId}/attempt-001`, immutableFiles);
  }
  for (const request of [requests.b, requests.a]) {
    captureFileInto(runDirectory(project, runId), `pending/${request.id}.json`, immutableFiles);
  }
  const metricsCalls = readMetrics(project, runId);
  if (metricsCalls.length !== 3) throw new Error("P4B initial graph did not persist exactly three provider call metrics.");
  return {
    runId,
    requests,
    markers,
    inputBytes: readFileSync(path.join(runDirectory(project, runId), "inputs.json")),
    events: readRunEvents(project, runId),
    metricsCalls: structuredClone(metricsCalls),
    immutableFiles,
  };
}

function captureIntermediateState(project: string, runId: string, fixtureEventsPath: string): { events: Array<Record<string, unknown>>; metricsCalls: unknown[]; fixtureEvents: Buffer; nextEventSequence: number } {
  const checkpoint = readCheckpoint(project, runId);
  const nextEventSequence = checkpoint.graph.nextEventSequence;
  if (typeof nextEventSequence !== "number" || !Number.isSafeInteger(nextEventSequence) || nextEventSequence < 1) {
    throw new Error("P4B paused checkpoint did not persist its next event sequence.");
  }
  return { events: readRunEvents(project, runId), metricsCalls: structuredClone(readMetrics(project, runId)), fixtureEvents: readFileSync(fixtureEventsPath), nextEventSequence };
}

function assertHistoryPrefix(project: string, runId: string, initial: InitialState): void {
  expect(readFileSync(path.join(runDirectory(project, runId), "inputs.json")).equals(initial.inputBytes)).toBe(true);
  const events = readRunEvents(project, runId);
  expect(events.slice(0, initial.events.length)).toEqual(initial.events);
  expect(readMetrics(project, runId).slice(0, initial.metricsCalls.length)).toEqual(initial.metricsCalls);
}

function assertIntermediateHistory(project: string, runId: string, state: ReturnType<typeof captureIntermediateState>): void {
  const events = readRunEvents(project, runId);
  expect(events.slice(0, state.events.length)).toEqual(state.events);
  expect(readMetrics(project, runId).slice(0, state.metricsCalls.length)).toEqual(state.metricsCalls);
}

function readMetrics(project: string, runId: string): unknown[] {
  const metrics = JSON.parse(readFileSync(path.join(runDirectory(project, runId), "metrics.json"), "utf8")) as unknown;
  if (!Array.isArray(metrics)) throw new Error("P4B graph metrics must use the persisted provider-call array format.");
  return metrics;
}

function metricCallId(metric: unknown): string {
  if (typeof metric !== "object" || metric === null || !("callId" in metric) || typeof metric.callId !== "string") {
    throw new Error("P4B resumed call metric is missing its call ID.");
  }
  return metric.callId;
}

function assertContiguousRunEvents(project: string, runId: string, paused: ReturnType<typeof captureIntermediateState>): void {
  const events = readRunEvents(project, runId);
  const appended = events.slice(paused.events.length);
  const sequences = appended.map((event) => event.sequence);
  expect(sequences.every((sequence) => typeof sequence === "number" && Number.isSafeInteger(sequence))).toBe(true);
  const numeric = sequences as number[];
  expect(new Set(numeric).size).toBe(numeric.length);
  if (numeric.length > 0) expect(numeric[0]).toBe(paused.nextEventSequence);
  for (let index = 1; index < numeric.length; index += 1) expect(numeric[index]).toBe(numeric[index - 1]! + 1);
}

function assertImmutableEvidence(project: string, runId: string, files: Map<string, CapturedFile>): void {
  for (const [relative, captured] of files) {
    const current = readFileSync(path.join(runDirectory(project, runId), relative));
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
  const events = readRunEvents(project, runId);
  const answerEvents = events.slice(priorEventCount).filter((event) => event.event === "request.answered" && event.requestId === request.id);
  expect(answerEvents).toHaveLength(1);
  expect(answerEvents[0]).toMatchObject({ event: "request.answered", requestId: request.id, kind: "node", nodeId: request.nodeId });
  expect(answerEvents[0]).not.toHaveProperty("answer");
  expect(answerEvents[0]).not.toHaveProperty("answers");
  const serializedEvent = JSON.stringify(answerEvents[0]);
  expect(serializedEvent).not.toContain(JSON.stringify(answer));
  for (const value of Object.values(answer)) expect(serializedEvent).not.toContain(String(value));
}

function assertTransport(project: string, runId: string, marker: ProviderMarker): void {
  expect(readJson(path.join(runDirectory(project, runId), `calls/${marker.callId}/transport.json`))).toMatchObject({
    callId: marker.callId,
    started: true,
    exitCode: 0,
    cancelled: false,
    timedOut: false,
    outputLimitExceeded: false,
  });
}

function assertTransportForInvocations(project: string, runId: string, invocations: InvocationObservation[]): void {
  for (const invocation of invocations) {
    if (!invocation.callId) throw new Error("P4B continuation invocation did not capture its runtime call ID.");
    expect(readJson(path.join(runDirectory(project, runId), `calls/${invocation.callId}/transport.json`))).toMatchObject({ callId: invocation.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
    const saved = readJson(path.join(runDirectory(project, runId), `calls/${invocation.callId}/request.json`));
    expect(saved).toMatchObject({ nodeId: invocation.nodeId, callId: invocation.callId, attempt: 2, parentCallId: invocation.parentCallId });
  }
}

function captureFile(file: string): CapturedFile {
  const bytes = readFileSync(file);
  return { bytes, sha256: digest(bytes) };
}

function captureFileInto(root: string, relative: string, files: Map<string, CapturedFile>): void {
  files.set(relative, captureFile(path.join(root, relative)));
}

function captureTree(root: string, relative: string, files: Map<string, CapturedFile>): void {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) throw new Error(`P4B expected saved evidence directory '${relative}'.`);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.set(path.relative(root, child).replaceAll("\\", "/"), captureFile(child));
    }
  };
  visit(absolute);
}

function captureRunTree(project: string, runId: string): Array<{ relative: string; sha256: string }> {
  const root = runDirectory(project, runId);
  const files: Array<{ relative: string; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ relative: path.relative(root, absolute).replaceAll("\\", "/"), sha256: digest(readFileSync(absolute)) });
    }
  };
  visit(root);
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function snapshotRunTree(project: string, runId: string): Array<{ relative: string; sha256: string }> {
  return captureRunTree(project, runId);
}

async function waitForMarker(file: string, description: string, deadline: number, getOutcome: () => Outcome | undefined): Promise<ProviderMarker> {
  await waitForCondition(() => existsSync(file), deadline, description, getOutcome);
  const marker = readJson(file) as unknown as ProviderMarker;
  if (typeof marker.pid !== "number" || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || typeof marker.callId !== "string" || typeof marker.runId !== "string") {
    throw new Error(`P4B ${description} marker has invalid process or call identity.`);
  }
  return marker;
}

async function waitForCondition(predicate: () => boolean, deadline: number, description: string, getOutcome: () => Outcome | undefined): Promise<void> {
  while (!predicate()) {
    const outcome = getOutcome();
    if (outcome) {
      if (outcome.kind === "error") throw outcome.error;
      throw new Error(`P4B public run completed before ${description}.`);
    }
    assertBeforeDeadline(deadline, description);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`P4B shared scenario deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`P4B shared deadline expired during ${description}.`)), remaining); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function waitForInferencePids(startedPaths: Record<string, string>, deadline: number): Promise<boolean> {
  const pids: number[] = [];
  for (const file of Object.values(startedPaths)) {
    if (!existsSync(file)) continue;
    const marker = readJson(file) as { pid?: unknown };
    if (typeof marker.pid !== "number" || !Number.isSafeInteger(marker.pid) || marker.pid <= 0) throw new Error("P4B refusing to discard an inference marker with an invalid owned PID.");
    pids.push(marker.pid);
  }
  const unique = [...new Set(pids)];
  while (unique.some(isProcessAlive)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function readCheckpoint(project: string, runId: string): GraphCheckpoint {
  return readJson(path.join(runDirectory(project, runId), "run.json")) as unknown as GraphCheckpoint;
}

function readRunEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(runDirectory(project, runId), "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readFixtureEvents(eventsPath: string): FixtureEvent[] {
  return readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
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

function seedHash(seed: AcceptedRecord, reference: string): string {
  if (seed.resultRef === reference) return seed.resultSha256;
  if (seed.validationRef === reference) return seed.validationSha256;
  if (seed.responseRef === reference) return seed.responseSha256;
  const artifact = seed.artifacts.find((item) => item.ref === reference);
  if (!artifact) throw new Error(`P4B accepted seed reference '${reference}' is absent from its manifest.`);
  return artifact.sha256;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function assertBeforeDeadline(deadline: number, operation: string): void {
  if (Date.now() >= deadline) throw new Error(`P4B shared scenario deadline expired during ${operation}.`);
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const nativeTemp = realpathSync.native(tmpdir());
  const current = realpathSync.native(project);
  if (current !== identity || path.dirname(identity) !== nativeTemp || !path.basename(identity).startsWith(`nodulus-${label}-`)) {
    throw new Error("P4B refused cleanup outside the exact owned native temporary project.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("P4B cleanup failed with a non-Error value.");
}

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
type Role = "seed" | "a" | "b";
type Invocation = { nodeId: string; callId: string; attempt: number; parentCallId?: string; answers?: Record<string, unknown> };
type Marker = { nodeId: Role; role: Role; runId: string; callId: string; attempt: number; pid: number; promptAnswers?: Record<string, unknown> };
type Request = { id: string; nodeId: string; callId: string; attempt: number; questions: Array<{ id: string; message: string }>; answerContract: Record<string, unknown> };
type Accepted = { attempt: number; callId: string; resultRef: string; resultSha256: string; validationRef: string; validationSha256: string; responseRef: string; responseSha256: string; artifacts: Array<{ name: string; contract: string; ref: string; sha256: string }> };
type Checkpoint = { runId: string; status: string; completedNodes: string[]; graph: { nextEventSequence: number; nodes: Record<string, { phase?: string; attempt?: number; callId?: string; accepted?: Accepted }>; pendingRequests: Record<string, Record<string, unknown>> } };
type FileSnapshot = Map<string, Buffer>;
type ObservationLog = {
  availability: string[];
  invocations: Invocation[];
  repairs: number;
  telemetry: number;
  launches: number;
  legacyUsage: number;
  publicSettlements: Array<Promise<void>>;
  delegatedSettlements: Array<Promise<void>>;
};

const oldFixture = fileURLToPath(new URL("../fixtures/par-031-graph-provider.mjs", import.meta.url));
const repeatedFixture = fileURLToPath(new URL("../fixtures/par-035-repeated-question.mjs", import.meta.url));
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;

test("PAR-035 preserves an answered A question as history while B becomes the next question wave", async () => {
  await exerciseSequentialWaves();
}, 35_000);

test("PAR-035 merges distinct answers across two questions from the same node", async () => {
  await exerciseRepeatedNodeQuestion();
}, 35_000);

async function exerciseSequentialWaves(): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = "par-035-question-history-café";
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const state = makeStatePaths(project, ["seed", "a", "b"], 2);
  const observations = createObservationLog();
  const cleanupErrors: Error[] = [];
  const publicRuns: Array<Promise<Outcome>> = [];
  let primaryError: unknown;
  let hasPrimaryError = false;
  let runId: string | undefined;

  try {
    assertOwnedProject(project, projectIdentity, label);
    const sentinels = configureProject(project, state, ["seed", "a", "b"], oldFixture, {
      dependsOn: { seed: [], a: ["seed"], b: ["a"] },
      outputs: [
        { name: "aSummary", from: "a.report", contract: "report.v1" },
        { name: "bSummary", from: "b.report", contract: "report.v1" },
      ],
    });
    assertBeforeDeadline(scenarioDeadline, "sequential-wave project setup");

    let initialOutcome: Outcome | undefined;
    const initial = capturePublic(runWorkflow(runRequest(project), observeProvider(project, observations)), observations);
    publicRuns.push(initial);
    void initial.then((outcome) => { initialOutcome = outcome; });
    const seedMarkerPromise = waitForMarker(state.started["seed-1"]!, "seed process", scenarioDeadline, () => initialOutcome);
    const aMarkerPromise = waitForMarker(state.started["a-1"]!, "A question process", scenarioDeadline, () => initialOutcome);
    const [seedMarker, aMarker] = await withDeadline(Promise.all([seedMarkerPromise, aMarkerPromise]), scenarioDeadline, "seed and A process markers");
    runId = seedMarker.runId;
    expect(aMarker).toMatchObject({ nodeId: "a", runId, attempt: 1 });
    expect(isProcessAlive(aMarker.pid), "A's actual inference process must be live at its controlled barrier.").toBe(true);
    assertFixturePromptAnswers(state.events, seedMarker, {});
    assertFixturePromptAnswers(state.events, aMarker, {});
    release(state.releases["a-1"]!);
    const initialResult = requireResult(await withDeadline(initial, scenarioDeadline, "first A question pause"), "initial A question");
    runId = initialResult.runId;
    expect(initialResult.status).toBe("needs_input");
    const aQuestion = readQuestion(project, runId, "a", 1);
    expect(publicRequests(initialResult.result).map((request) => request.id)).toEqual([aQuestion.id]);
    expect(readCheckpoint(project, runId).graph.nodes.seed?.phase).toBe("accepted");
    expect(readCheckpoint(project, runId).graph.nodes.b?.phase).toBe("not_started");
    assertQuestionEvidence(project, runId, aQuestion);
    const initialState = capturePauseState(project, runId);
    const seedEvidence = captureAcceptedEvidence(project, runId, "seed");
    const seedCallId = readCheckpoint(project, runId).graph.nodes.seed?.callId;
    expect(initialState.metrics).toHaveLength(2);
    expect(new Set(observations.invocations.map(({ nodeId }) => nodeId))).toEqual(new Set(["seed", "a"]));
    expect(sorted(observations.availability)).toEqual(["par-035-a", "par-035-seed"]);

    let aResumeOutcome: Outcome | undefined;
    const aResumeAvailabilityStart = observations.availability.length;
    const aResume = capturePublic(resumeWorkflow({ projectRoot: project, runId, requestId: aQuestion.id, answers: { aApproval: "A-approved" } }, observeProvider(project, observations)), observations);
    publicRuns.push(aResume);
    void aResume.then((outcome) => { aResumeOutcome = outcome; });
    const aContinuationMarkerPromise = waitForMarker(state.started["a-2"]!, "A continuation process", scenarioDeadline, () => aResumeOutcome);
    const bQuestionMarkerPromise = waitForMarker(state.started["b-1"]!, "B question process", scenarioDeadline, () => aResumeOutcome);
    const [aContinuationMarker, bQuestionMarker] = await withDeadline(Promise.all([aContinuationMarkerPromise, bQuestionMarkerPromise]), scenarioDeadline, "A continuation and B question process markers");
    expect(aContinuationMarker).toMatchObject({ nodeId: "a", runId, attempt: 2 });
    expect(bQuestionMarker).toMatchObject({ nodeId: "b", runId, attempt: 1 });
    assertFixturePromptAnswers(state.events, aContinuationMarker, { aApproval: "A-approved" });
    assertFixturePromptAnswers(state.events, bQuestionMarker, {});
    expect(isProcessAlive(bQuestionMarker.pid), "B's real inference process must be live at its controlled barrier.").toBe(true);
    const duringB = readCheckpoint(project, runId);
    expect(duringB.graph.nodes.a).toMatchObject({ phase: "accepted", attempt: 2, callId: aContinuationMarker.callId });
    expect(duringB.graph.nodes.b?.phase).toBe("active");
    expect(duringB.graph.pendingRequests[aQuestion.id]).toMatchObject({ nodeId: "a", answerRef: `answers/${aQuestion.id}.json` });
    release(state.releases["b-1"]!);

    const bPauseResult = requireResult(await withDeadline(aResume, scenarioDeadline, "second B question pause"), "B question after A acceptance");
    expect(bPauseResult.status).toBe("needs_input");
    const bQuestion = readQuestion(project, runId, "b", 1);
    expect(publicRequests(bPauseResult.result)).toEqual([bQuestion]);
    expect((bPauseResult.result as { request?: Request }).request).toEqual(bQuestion);
    const bPauseState = capturePauseState(project, runId);
    const acceptedAEvidence = captureAcceptedEvidence(project, runId, "a");
    expect(readLatestPauseIds(project, runId)).toEqual([bQuestion.id]);
    assertAppendedSequences(bPauseState.events, initialState.events.length, initialState.nextEventSequence);
    expect(bPauseState.events.slice(0, initialState.events.length)).toEqual(initialState.events);
    expect(bPauseState.metrics.slice(0, initialState.metrics.length)).toEqual(initialState.metrics);
    expect(bPauseState.metrics).toHaveLength(4);
    expect(sorted(observations.availability.slice(aResumeAvailabilityStart))).toEqual(["par-035-a", "par-035-b"]);
    expect(readFileSync(runFile(project, runId, "inputs.json")).equals(initialState.inputsBytes)).toBe(true);
    assertCapturedFiles(project, runId, initialState.files);
    assertCapturedFiles(project, runId, seedEvidence);
    assertAnswerEvidence(project, runId, aQuestion, { aApproval: "A-approved" });
    assertCall(project, runId, aContinuationMarker, { parentCallId: aQuestion.callId, attempt: 2 });
    assertCall(project, runId, bQuestionMarker, { attempt: 1 });

    const finalAvailabilityStart = observations.availability.length;
    const finalPromise = capturePublic(resumeWorkflow({ projectRoot: project, runId, requestId: bQuestion.id, answers: { bApproval: "B-approved" } }, observeProvider(project, observations)), observations);
    publicRuns.push(finalPromise);
    const finalOutcome = await withDeadline(finalPromise, scenarioDeadline, "final B answer continuation");
    const finalResult = requireResult(finalOutcome, "final B answer continuation");
    expect(finalResult.status).toBe("success");
    expect(finalResult.runId).toBe(runId);
    const finalCheckpoint = readCheckpoint(project, runId);
    expect(finalCheckpoint.graph.nodes.seed).toMatchObject({ phase: "accepted", callId: seedCallId, attempt: 1 });
    expect(finalCheckpoint.graph.nodes.a).toMatchObject({ phase: "accepted", callId: aContinuationMarker.callId, attempt: 2 });
    expect(finalCheckpoint.graph.nodes.b).toMatchObject({ phase: "accepted", callId: expect.any(String), attempt: 2 });
    expect(finalCheckpoint.completedNodes).toEqual(["seed", "a", "b"]);
    expect(outputArtifacts(finalResult.result)).toEqual([
      { name: "aSummary", contract: "report.v1", data: { text: "a-continued-A-approved" } },
      { name: "bSummary", contract: "report.v1", data: { text: "b-continued-B-approved" } },
    ]);
    expect(observations.invocations.map(({ nodeId, attempt }) => `${nodeId}/${attempt}`).sort(compareStrings)).toEqual(["a/1", "a/2", "b/1", "b/2", "seed/1"]);
    expect(observations.invocations).toHaveLength(5);
    expect(observations.repairs).toBe(0);
    expect(sorted(observations.availability.slice(finalAvailabilityStart))).toEqual(["par-035-b"]);
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);
    assertFixtureLifecycle(state.events, observations.invocations);
    expect(observations.invocations.find((call) => call.nodeId === "a" && call.attempt === 2)).toMatchObject({ parentCallId: aQuestion.callId, answers: { aApproval: "A-approved" } });
    expect(observations.invocations.find((call) => call.nodeId === "b" && call.attempt === 2)).toMatchObject({ parentCallId: bQuestion.callId, answers: { bApproval: "B-approved" } });
    const finalEvents = readEvents(project, runId);
    expect(finalEvents.slice(0, bPauseState.events.length)).toEqual(bPauseState.events);
    assertAppendedSequences(finalEvents, bPauseState.events.length, bPauseState.nextEventSequence);
    const finalMetrics = readMetrics(project, runId);
    expect(finalMetrics).toHaveLength(5);
    expect(finalMetrics.slice(0, bPauseState.metrics.length)).toEqual(bPauseState.metrics);
    expect(metricCallIds(finalMetrics)).toEqual(observations.invocations.map(({ callId }) => callId).sort(compareStrings));
    expect(readFileSync(runFile(project, runId, "inputs.json")).equals(initialState.inputsBytes)).toBe(true);
    assertCapturedFiles(project, runId, initialState.files);
    assertCapturedFiles(project, runId, seedEvidence);
    assertCapturedFiles(project, runId, acceptedAEvidence);
    assertAnswerEvidence(project, runId, aQuestion, { aApproval: "A-approved" });
    assertAnswerEvidence(project, runId, bQuestion, { bApproval: "B-approved" });
    for (const invocation of observations.invocations) assertCallForInvocation(project, runId, invocation);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    const cleanupDeadline = Date.now() + cleanupBudgetMs;
    releaseAll(Object.values(state.releases), cleanupErrors);
    try {
      await withDeadline(Promise.all([...publicRuns, ...observations.publicSettlements]), cleanupDeadline, "sequential-wave public settlement");
    } catch (error) { cleanupErrors.push(asError(error)); }
    try { await withDeadline(Promise.all([...observations.delegatedSettlements]), cleanupDeadline, "sequential-wave adapter settlement"); }
    catch (error) { cleanupErrors.push(asError(error)); }
    if (!hasPrimaryError && cleanupErrors.length === 0) {
      try { assertOwnedProject(project, projectIdentity, label); rmSync(project, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(asError(error)); }
    } else {
      console.error(`PAR-035 retained project for diagnosis: ${project}`);
    }
  }

  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "PAR-035 sequential-wave test and cleanup both failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-035 sequential-wave cleanup failed.");
}

async function exerciseRepeatedNodeQuestion(): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = "par-035-repeated-question-café";
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const state = makeStatePaths(project, ["seed", "a"], 3);
  const observations = createObservationLog();
  const cleanupErrors: Error[] = [];
  const publicRuns: Array<Promise<Outcome>> = [];
  let primaryError: unknown;
  let hasPrimaryError = false;
  let runId: string | undefined;

  try {
    assertOwnedProject(project, projectIdentity, label);
    const sentinels = configureProject(project, state, ["seed", "a"], repeatedFixture, {
      dependsOn: { seed: [], a: ["seed"] },
      outputs: [{ name: "approved", from: "a.report", contract: "report.v1" }],
    });
    assertBeforeDeadline(scenarioDeadline, "repeated-question project setup");

    let initialOutcome: Outcome | undefined;
    const initial = capturePublic(runWorkflow(runRequest(project), observeProvider(project, observations)), observations);
    publicRuns.push(initial);
    void initial.then((outcome) => { initialOutcome = outcome; });
    const seedMarker = await waitForMarker(state.started["seed-1"]!, "seed process", scenarioDeadline, () => initialOutcome);
    runId = seedMarker.runId;
    expect(isProcessAlive(seedMarker.pid), "Seed's actual process must be live at its controlled entry barrier.").toBe(true);
    release(state.releases["seed-1"]!);
    const a1Marker = await waitForMarker(state.started["a-1"]!, "A first-question process", scenarioDeadline, () => initialOutcome);
    expect(a1Marker).toMatchObject({ nodeId: "a", runId, attempt: 1, promptAnswers: {} });
    expect(isProcessAlive(a1Marker.pid), "A attempt 1's actual process must be live at its controlled entry barrier.").toBe(true);
    release(state.releases["a-1"]!);
    const firstPause = requireResult(await withDeadline(initial, scenarioDeadline, "A first-question pause"), "A first question");
    expect(firstPause.status).toBe("needs_input");
    const a1Question = readQuestion(project, runId, "a", 1);
    expect(publicRequests(firstPause.result)).toEqual([a1Question]);
    const firstPauseState = capturePauseState(project, runId);
    expect(sorted(observations.availability)).toEqual(["par-035-a", "par-035-seed"]);
    const firstStateFiles = firstPauseState.files;
    const seedEvidence = captureAcceptedEvidence(project, runId, "seed");
    const inputBytes = readFileSync(runFile(project, runId, "inputs.json"));
    expect(firstPauseState.metrics).toHaveLength(2);
    expect(readLatestPauseIds(project, runId)).toEqual([a1Question.id]);
    assertQuestionEvidence(project, runId, a1Question);

    let secondPauseOutcome: Outcome | undefined;
    const secondPauseAvailabilityStart = observations.availability.length;
    const answer1 = { firstAnswer: "first-approved" };
    const secondPausePromise = capturePublic(resumeWorkflow({ projectRoot: project, runId, requestId: a1Question.id, answers: answer1 }, observeProvider(project, observations)), observations);
    publicRuns.push(secondPausePromise);
    void secondPausePromise.then((outcome) => { secondPauseOutcome = outcome; });
    const a2Marker = await waitForMarker(state.started["a-2"]!, "A second-question process", scenarioDeadline, () => secondPauseOutcome);
    expect(a2Marker).toMatchObject({ nodeId: "a", runId, attempt: 2, promptAnswers: answer1 });
    assertFixturePromptAnswers(state.events, a2Marker, answer1);
    expect(isProcessAlive(a2Marker.pid), "A attempt 2's actual process must be live at its controlled entry barrier.").toBe(true);
    release(state.releases["a-2"]!);
    const secondPause = requireResult(await withDeadline(secondPausePromise, scenarioDeadline, "A second-question pause"), "A second question");
    expect(secondPause.status).toBe("needs_input");
    const a2Question = readQuestion(project, runId, "a", 2);
    expect(a2Question.id).not.toBe(a1Question.id);
    expect(publicRequests(secondPause.result)).toEqual([a2Question]);
    expect((secondPause.result as { request?: Request }).request).toEqual(a2Question);
    const secondPauseState = capturePauseState(project, runId);
    expect(sorted(observations.availability.slice(secondPauseAvailabilityStart))).toEqual(["par-035-a"]);
    assertAppendedSequences(secondPauseState.events, firstPauseState.events.length, firstPauseState.nextEventSequence);
    expect(readLatestPauseIds(project, runId)).toEqual([a2Question.id]);
    expect(secondPauseState.events.slice(0, firstPauseState.events.length)).toEqual(firstPauseState.events);
    expect(secondPauseState.metrics.slice(0, firstPauseState.metrics.length)).toEqual(firstPauseState.metrics);
    expect(secondPauseState.metrics).toHaveLength(3);
    expect(readCheckpoint(project, runId).graph.pendingRequests[a1Question.id]).toMatchObject({ nodeId: "a", answerRef: `answers/${a1Question.id}.json` });
    expect(readCheckpoint(project, runId).graph.pendingRequests[a2Question.id]).toMatchObject({ nodeId: "a", attempt: 2 });
    expect(readCheckpoint(project, runId).graph.nodes.a).toMatchObject({ phase: "pending", attempt: 2, callId: a2Question.callId });
    assertCapturedFiles(project, runId, firstStateFiles);
    assertCapturedFiles(project, runId, seedEvidence);
    assertAnswerEvidence(project, runId, a1Question, answer1);
    expect(readFileSync(runFile(project, runId, "inputs.json")).equals(inputBytes)).toBe(true);

    const answer2 = { secondAnswer: "second-approved" };
    let finalOutcomeObserved: Outcome | undefined;
    const finalAvailabilityStart = observations.availability.length;
    const finalPromise = capturePublic(resumeWorkflow({ projectRoot: project, runId, requestId: a2Question.id, answers: answer2 }, observeProvider(project, observations)), observations);
    publicRuns.push(finalPromise);
    void finalPromise.then((outcome) => { finalOutcomeObserved = outcome; });
    const a3Marker = await waitForMarker(state.started["a-3"]!, "A third-attempt success process", scenarioDeadline, () => finalOutcomeObserved);
    expect(a3Marker).toMatchObject({ nodeId: "a", runId, attempt: 3, promptAnswers: { ...answer1, ...answer2 } });
    expect(isProcessAlive(a3Marker.pid), "A attempt 3's actual process must be live at its controlled entry barrier.").toBe(true);
    release(state.releases["a-3"]!);
    const finalResult = requireResult(await withDeadline(finalPromise, scenarioDeadline, "A third-attempt success"), "A third attempt");
    expect(finalResult.status).toBe("success");
    expect(outputArtifacts(finalResult.result)).toEqual([{ name: "approved", contract: "report.v1", data: { text: "both approvals accepted" } }]);
    const finalCheckpoint = readCheckpoint(project, runId);
    expect(finalCheckpoint.graph.nodes.seed?.phase).toBe("accepted");
    expect(finalCheckpoint.graph.nodes.a).toMatchObject({ phase: "accepted", attempt: 3, callId: a3Marker.callId });
    expect(finalCheckpoint.completedNodes).toEqual(["seed", "a"]);
    expect(observations.invocations.map(({ nodeId, attempt }) => `${nodeId}/${attempt}`).sort(compareStrings)).toEqual(["a/1", "a/2", "a/3", "seed/1"]);
    expect(observations.invocations).toHaveLength(4);
    expect(observations.repairs).toBe(0);
    expect(sorted(observations.availability.slice(finalAvailabilityStart))).toEqual(["par-035-a"]);
    assertFixturePromptAnswers(state.events, a3Marker, { ...answer1, ...answer2 });
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);
    assertFixtureLifecycle(state.events, observations.invocations);
    const a2Invocation = observations.invocations.find((call) => call.nodeId === "a" && call.attempt === 2);
    const a3Invocation = observations.invocations.find((call) => call.nodeId === "a" && call.attempt === 3);
    expect(a2Invocation).toMatchObject({ callId: a2Marker.callId, parentCallId: a1Question.callId, answers: answer1 });
    expect(a3Invocation).toMatchObject({ callId: a3Marker.callId, parentCallId: a2Question.callId, answers: { ...answer1, ...answer2 } });
    const finalEvents = readEvents(project, runId);
    expect(finalEvents.slice(0, secondPauseState.events.length)).toEqual(secondPauseState.events);
    assertAppendedSequences(finalEvents, secondPauseState.events.length, secondPauseState.nextEventSequence);
    const finalMetrics = readMetrics(project, runId);
    expect(finalMetrics).toHaveLength(4);
    expect(finalMetrics.slice(0, secondPauseState.metrics.length)).toEqual(secondPauseState.metrics);
    expect(metricCallIds(finalMetrics)).toEqual(observations.invocations.map(({ callId }) => callId).sort(compareStrings));
    expect(readFileSync(runFile(project, runId, "inputs.json")).equals(inputBytes)).toBe(true);
    assertCapturedFiles(project, runId, firstStateFiles);
    assertCapturedFiles(project, runId, seedEvidence);
    assertAnswerEvidence(project, runId, a1Question, answer1);
    assertAnswerEvidence(project, runId, a2Question, answer2);
    for (const invocation of observations.invocations) assertCallForInvocation(project, runId, invocation);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    const cleanupDeadline = Date.now() + cleanupBudgetMs;
    releaseAll(Object.values(state.releases), cleanupErrors);
    try {
      await withDeadline(Promise.all([...publicRuns, ...observations.publicSettlements]), cleanupDeadline, "repeated-question public settlement");
    } catch (error) { cleanupErrors.push(asError(error)); }
    try { await withDeadline(Promise.all([...observations.delegatedSettlements]), cleanupDeadline, "repeated-question adapter settlement"); }
    catch (error) { cleanupErrors.push(asError(error)); }
    if (!hasPrimaryError && cleanupErrors.length === 0) {
      try { assertOwnedProject(project, projectIdentity, label); rmSync(project, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(asError(error)); }
    } else {
      console.error(`PAR-035 retained project for diagnosis: ${project}`);
    }
  }

  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "PAR-035 repeated-question test and cleanup both failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-035 repeated-question cleanup failed.");
}

function configureProject(
  project: string,
  state: ReturnType<typeof makeStatePaths>,
  roles: Role[],
  providerFixture: string,
  graph: { dependsOn: Record<string, string[]>; outputs: Array<{ name: string; from: string; contract: string }> },
): { providerSentinel: string; validatorSentinel: string } {
  const sentinels = configureParallelProject(project);
  mkdirSync(state.directory, { recursive: true });
  writeFileSync(state.events, "", { encoding: "utf8", flag: "wx" });
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const fixtureName = providerFixture === oldFixture ? "par-031-graph-provider.mjs" : "par-035-repeated-question.mjs";
  writeFileSync(path.join(fixtureDirectory, fixtureName), readFileSync(providerFixture, "utf8"), "utf8");
  const startedPaths = Object.fromEntries(Object.entries(state.started).map(([key, value]) => [key, path.relative(project, value)]));
  const releasePaths = Object.fromEntries(Object.entries(state.releases).map(([key, value]) => [key, path.relative(project, value)]));
  writeFileSync(path.join(fixtureDirectory, "par-035-control.json"), JSON.stringify({
    eventsPath: path.relative(project, state.events),
    fixtureLifetimeMs,
    startedPaths,
    releasePaths,
  }), "utf8");
  if (providerFixture === oldFixture) {
    writeFileSync(path.join(fixtureDirectory, "par-031-control.json"), JSON.stringify({
      eventsPath: path.relative(project, state.events),
      fixtureLifetimeMs,
      startedPaths,
      releasePaths: { a: releasePaths["a-1"], b: releasePaths["b-1"] },
    }), "utf8");
  }

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  const baseProfile = profiles.fixture ?? {};
  for (const role of roles) {
    const wrapperName = process.platform === "win32" ? `par-035-${role}.cmd` : `par-035-${role}.sh`;
    const wrapper = path.join(fixtureDirectory, wrapperName);
    if (process.platform === "win32") {
      writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\${fixtureName}" "${role}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    } else {
      writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/${fixtureName}' '${role}' "$@"\n`, "utf8");
      chmodSync(wrapper, 0o755);
    }
    profiles[role] = {
      ...baseProfile,
      enabled: true,
      executable: wrapper,
      kind: "codex",
      model: `par-035-${role}`,
      timeoutMs: profileTimeoutMs,
      capabilities: [],
      sandbox: "read-only",
    };
  }
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = [...roles];
  workflow.execution.maxConcurrency = 1;
  workflow.execution.dependsOn = graph.dependsOn;
  workflow.execution.resources = Object.fromEntries(roles.map((role) => [role, []]));
  workflow.outputs = graph.outputs;
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  const template = readProjectJson(project, ".nodulus/nodes/prepare.json");
  for (const role of roles) {
    const instruction = `.nodulus/instructions/${role}.md`;
    writeFileSync(path.join(project, instruction), `PAR-035 local question-history instructions for ${role}.\n`, "utf8");
    const input = role === "seed" ? { request: { from: "request", contract: "request.v1" } }
      : { report: { from: "seed.report", contract: "report.v1" } };
    writeJson(project, `.nodulus/nodes/${role}.json`, {
      ...template,
      id: role,
      providerProfile: role,
      instructions: [instruction],
      inputs: input,
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
  }
  return sentinels;
}

function makeStatePaths(project: string, roles: Role[], maxAttempt: number): { directory: string; events: string; started: Record<string, string>; releases: Record<string, string> } {
  const directory = path.join(project, ".nodulus", "fixtures", "par-035-state");
  const started: Record<string, string> = {};
  const releases: Record<string, string> = {};
  for (const role of roles) for (let attempt = 1; attempt <= maxAttempt; attempt += 1) {
    const key = `${role}-${attempt}`;
    started[key] = path.join(directory, `${key}.started.json`);
    releases[key] = path.join(directory, `${key}.release`);
  }
  return { directory, events: path.join(directory, "provider-events.jsonl"), started, releases };
}

function observeProvider(project: string, log: ObservationLog): ProviderPort {
  const delegate = createDefaultProviderPort(project);
  return {
    ...delegate,
    invoke(invocation) {
      const call = invocation.call;
      if (!call?.callId) throw new Error("PAR-035 observed invocation has no runtime call ID.");
      log.invocations.push({
        nodeId: invocation.nodeId,
        callId: call.callId,
        attempt: invocation.attempt,
        ...(call.parentCallId === undefined ? {} : { parentCallId: call.parentCallId }),
        ...(invocation.answers === undefined ? {} : { answers: structuredClone(invocation.answers) }),
      });
      return trackDelegated(delegate.invoke(invocation), log);
    },
    ...(delegate.isAvailable ? { isAvailable: (profile, options) => {
      log.availability.push(typeof profile.model === "string" ? profile.model : "unknown");
      return trackDelegated(delegate.isAvailable!(profile, options), log);
    } } : {}),
    ...(delegate.repairResponse ? { repairResponse: (invocation, raw, errors) => {
      log.repairs += 1;
      return trackDelegated(delegate.repairResponse!(invocation, raw, errors), log);
    } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall: (callId) => {
      log.telemetry += 1;
      return delegate.telemetryForCall!(callId);
    } } : {}),
    ...(delegate.launchForCall ? { launchForCall: (callId) => {
      log.launches += 1;
      return delegate.launchForCall!(callId);
    } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall: () => {
      log.legacyUsage += 1;
      return delegate.usageForLastCall!();
    } } : {}),
  };
}

function createObservationLog(): ObservationLog {
  return { availability: [], invocations: [], repairs: 0, telemetry: 0, launches: 0, legacyUsage: 0, publicSettlements: [], delegatedSettlements: [] };
}

function capturePublic(promise: Promise<ApplicationRunResult>, log: ObservationLog): Promise<Outcome> {
  const outcome = promise.then<Outcome, Outcome>((result) => ({ kind: "result", result }), (error: unknown) => ({ kind: "error", error }));
  log.publicSettlements.push(outcome.then(() => undefined));
  return outcome;
}

function trackDelegated<T>(operation: T, log: ObservationLog): T {
  if (typeof operation === "object" && operation !== null && "then" in operation && typeof operation.then === "function") {
    log.delegatedSettlements.push(Promise.resolve(operation).then(() => undefined, () => undefined));
  }
  return operation;
}

function runRequest(projectRoot: string) {
  return { projectRoot, cwd: projectRoot, workflow: "example", sources: [{ kind: "inline" as const, text: "Preserve each question answer in the graph history." }] };
}

function readQuestion(project: string, runId: string, nodeId: string, attempt: number): Request {
  const result = readJson(runFile(project, runId, `nodes/${nodeId}/attempt-${String(attempt).padStart(3, "0")}/result.json`));
  if (result.status !== "needs_input" || !isRecord(result.request)) throw new Error(`PAR-035 expected ${nodeId} attempt ${attempt} to save a question.`);
  const request = result.request as unknown as Request;
  const checkpoint = readCheckpoint(project, runId);
  const entry = checkpoint.graph.pendingRequests[request.id];
  expect(entry).toMatchObject({ nodeId, kind: "node", attempt, requestRef: `pending/${request.id}.json` });
  expect(readBytes(runFile(project, runId, entry.requestRef as string))).toEqual(Buffer.from(`${JSON.stringify(request, null, 2)}\n`));
  return request;
}

function assertQuestionEvidence(project: string, runId: string, request: Request): void {
  const runRoot = runDirectory(project, runId);
  const entry = readCheckpoint(project, runId).graph.pendingRequests[request.id];
  const requestBytes = readBytes(path.join(runRoot, entry.requestRef as string));
  expect(digest(requestBytes)).toBe(entry.requestSha256);
  expect(request.id).not.toMatch(/^provider-untrusted-/);
  expect(readJson(path.join(runRoot, `nodes/${request.nodeId}/attempt-${String(request.attempt).padStart(3, "0")}/result.json`))).toMatchObject({ status: "needs_input", request });
  expect(readJson(path.join(runRoot, `nodes/${request.nodeId}/attempt-${String(request.attempt).padStart(3, "0")}/validation.json`))).toEqual({ valid: true, outcome: "needs_input", errors: [] });
  const raw = readJson(path.join(runRoot, `nodes/${request.nodeId}/attempt-${String(request.attempt).padStart(3, "0")}/response.raw.txt`));
  expect(raw).toMatchObject({ status: "needs_input", request: { questions: request.questions, answerContract: request.answerContract } });
  expect(readJson(path.join(runRoot, `calls/${request.callId}/request.json`))).toMatchObject({ nodeId: request.nodeId, callId: request.callId, attempt: request.attempt, operation: "invoke" });
  expect(readJson(path.join(runRoot, `calls/${request.callId}/transport.json`))).toMatchObject({ callId: request.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
}

function publicRequests(result: unknown): Request[] {
  if (!isRecord(result) || !Array.isArray(result.requests)) throw new Error("PAR-035 public result has no request array.");
  return result.requests as Request[];
}

function capturePauseState(project: string, runId: string): { events: Array<Record<string, unknown>>; metrics: unknown[]; nextEventSequence: number; inputsBytes: Buffer; files: FileSnapshot } {
  const checkpoint = readCheckpoint(project, runId);
  if (!Number.isSafeInteger(checkpoint.graph.nextEventSequence)) throw new Error("PAR-035 pause checkpoint has no valid next event sequence.");
  return {
    events: readEvents(project, runId),
    metrics: structuredClone(readMetrics(project, runId)),
    nextEventSequence: checkpoint.graph.nextEventSequence,
    inputsBytes: readBytes(runFile(project, runId, "inputs.json")),
    files: captureCurrentRequestAndAttempts(project, runId),
  };
}

function captureCurrentRequestAndAttempts(project: string, runId: string): FileSnapshot {
  const snapshot: FileSnapshot = new Map();
  for (const [requestId, entry] of Object.entries(readCheckpoint(project, runId).graph.pendingRequests)) {
    captureFile(snapshot, runDirectory(project, runId), entry.requestRef as string);
    const request = readJson(runFile(project, runId, entry.requestRef as string));
    if (typeof request.callId !== "string") throw new Error("PAR-035 pending request evidence has no call ID.");
    captureTree(snapshot, runDirectory(project, runId), `calls/${request.callId}`);
    const attempt = Number(entry.attempt);
    const nodeId = String(entry.nodeId);
    captureTree(snapshot, runDirectory(project, runId), `nodes/${nodeId}/attempt-${String(attempt).padStart(3, "0")}`);
    if (typeof entry.answerRef === "string") captureFile(snapshot, runDirectory(project, runId), entry.answerRef);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
  }
  return snapshot;
}

function captureAcceptedEvidence(project: string, runId: string, nodeId: string): FileSnapshot {
  const nodeState = readCheckpoint(project, runId).graph.nodes[nodeId];
  const record = nodeState?.accepted;
  if (!record) throw new Error(`PAR-035 accepted node '${nodeId}' has no evidence manifest.`);
  const snapshot: FileSnapshot = new Map();
  const runRoot = runDirectory(project, runId);
  for (const [reference, expectedHash] of [
    [record.resultRef, record.resultSha256],
    [record.validationRef, record.validationSha256],
    [record.responseRef, record.responseSha256],
    ...record.artifacts.map((artifact) => [artifact.ref, artifact.sha256]),
  ] as Array<[string, string]>) {
    captureFile(snapshot, runRoot, reference);
    expect(digest(snapshot.get(reference)!)).toBe(expectedHash);
  }
  if (typeof nodeState.callId !== "string") throw new Error(`PAR-035 accepted node '${nodeId}' has no current call ID.`);
  captureTree(snapshot, runRoot, `calls/${nodeState.callId}`);
  return snapshot;
}

function assertCapturedFiles(project: string, runId: string, snapshot: FileSnapshot): void {
  for (const [relative, expected] of snapshot) expect(readBytes(runFile(project, runId, relative))).toEqual(expected);
}

function assertAnswerEvidence(project: string, runId: string, request: Request, answer: Record<string, unknown>): void {
  const answerRef = `answers/${request.id}.json`;
  const answerBytes = readBytes(runFile(project, runId, answerRef));
  expect(JSON.parse(answerBytes.toString("utf8"))).toEqual(answer);
  const entry = readCheckpoint(project, runId).graph.pendingRequests[request.id];
  expect(entry).toMatchObject({ answerRef, answerSha256: digest(answerBytes) });
  const event = readEvents(project, runId).filter((item) => item.event === "request.answered" && item.requestId === request.id);
  expect(event).toHaveLength(1);
  expect(event[0]).toMatchObject({ event: "request.answered", requestId: request.id, kind: "node", nodeId: request.nodeId });
  expect(event[0]).not.toHaveProperty("answer");
  expect(event[0]).not.toHaveProperty("answers");
  const serialized = JSON.stringify(event[0]);
  for (const value of Object.values(answer)) expect(serialized).not.toContain(String(value));
}

function assertCall(project: string, runId: string, marker: Marker, expected: { attempt: number; parentCallId?: string }): void {
  const saved = readJson(runFile(project, runId, `calls/${marker.callId}/request.json`));
  expect(saved).toMatchObject({ nodeId: marker.nodeId, callId: marker.callId, attempt: expected.attempt, ...(expected.parentCallId ? { parentCallId: expected.parentCallId } : {}) });
  expect(readJson(runFile(project, runId, `calls/${marker.callId}/transport.json`))).toMatchObject({ callId: marker.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
}

function assertCallForInvocation(project: string, runId: string, invocation: Invocation): void {
  const saved = readJson(runFile(project, runId, `calls/${invocation.callId}/request.json`));
  expect(saved).toMatchObject({ nodeId: invocation.nodeId, callId: invocation.callId, attempt: invocation.attempt, parentCallId: invocation.parentCallId ?? null });
  expect(readJson(runFile(project, runId, `calls/${invocation.callId}/transport.json`))).toMatchObject({ callId: invocation.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
}

function readLatestPauseIds(project: string, runId: string): string[] {
  const pause = readEvents(project, runId).filter((event) => event.event === "run.needs_input").at(-1);
  if (!pause || !Array.isArray(pause.requestIds)) throw new Error("PAR-035 run history has no current needs-input event.");
  return pause.requestIds as string[];
}

function assertFixtureLifecycle(eventsPath: string, invocations: Invocation[]): void {
  const fixtureEvents = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const expected = invocations.map(({ nodeId, callId, attempt }) => `${nodeId}/${callId}/${attempt}`).sort(compareStrings);
  const started = fixtureEvents.filter((event) => event.stage === "inference-started").map(fixtureCallIdentity).sort(compareStrings);
  const completed = fixtureEvents.filter((event) => event.stage === "inference-completed").map(fixtureCallIdentity).sort(compareStrings);
  expect(started).toEqual(expected);
  expect(completed).toEqual(expected);
}

function assertFixturePromptAnswers(eventsPath: string, marker: Marker, expected: Record<string, unknown>): void {
  const matches = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.stage === "inference-started" && event.callId === marker.callId);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ nodeId: marker.nodeId, runId: marker.runId, attempt: marker.attempt, promptAnswers: expected });
}

function fixtureCallIdentity(event: Record<string, unknown>): string {
  if (typeof event.nodeId !== "string" || typeof event.callId !== "string" || typeof event.attempt !== "number" || !Number.isSafeInteger(event.attempt)) {
    throw new Error("PAR-035 fixture lifecycle event has invalid call identity.");
  }
  return `${event.nodeId}/${event.callId}/${event.attempt}`;
}

function assertAppendedSequences(events: Array<Record<string, unknown>>, prefixLength: number, nextSequence: number): void {
  const appended = events.slice(prefixLength);
  const sequences = appended.map((event) => event.sequence);
  expect(sequences.every((sequence) => typeof sequence === "number" && Number.isSafeInteger(sequence))).toBe(true);
  const numeric = sequences as number[];
  expect(new Set(numeric).size).toBe(numeric.length);
  if (numeric.length > 0) expect(numeric[0]).toBe(nextSequence);
  for (let index = 1; index < numeric.length; index += 1) expect(numeric[index]).toBe(numeric[index - 1]! + 1);
}

async function waitForMarker(file: string, description: string, deadline: number, getOutcome: () => Outcome | undefined): Promise<Marker> {
  await waitForCondition(() => existsSync(file), deadline, description, getOutcome);
  const marker = readJson(file);
  if (typeof marker.nodeId !== "string" || typeof marker.role !== "string" || typeof marker.runId !== "string" ||
      typeof marker.callId !== "string" || !Number.isSafeInteger(marker.attempt) || typeof marker.pid !== "number" ||
      !Number.isSafeInteger(marker.pid) || marker.pid <= 0 ||
      (marker.promptAnswers !== undefined && !isRecord(marker.promptAnswers))) throw new Error(`PAR-035 ${description} marker has invalid identity.`);
  return marker as unknown as Marker;
}

async function waitForCondition(predicate: () => boolean, deadline: number, description: string, getOutcome: () => Outcome | undefined): Promise<void> {
  while (!predicate()) {
    const outcome = getOutcome();
    if (outcome) throw new Error(`PAR-035 operation settled before ${description}: ${describeOutcome(outcome)}`);
    assertBeforeDeadline(deadline, description);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`PAR-035 shared deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`PAR-035 shared deadline expired during ${description}.`)), remaining); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function release(file: string): void {
  try { writeFileSync(file, "release\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!isAlreadyExists(error)) throw error; }
}

function releaseAll(files: string[], errors: Error[]): void {
  for (const file of files) {
    try { release(file); }
    catch (error) { errors.push(asError(error)); }
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function requireResult(outcome: Outcome, description: string): ApplicationRunResult {
  if (outcome.kind === "error") throw new Error(`PAR-035 ${description} rejected: ${describeError(outcome.error)}`);
  return outcome.result;
}

function describeOutcome(outcome: Outcome): string {
  if (outcome.kind === "error") return describeError(outcome.error);
  const result = outcome.result;
  return `status=${result.status}`;
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === "string" ? record.code : "unknown code";
    const message = typeof record.message === "string" ? record.message.slice(0, 500) : "no message";
    return `${code}: ${message}`;
  }
  return typeof error === "string" ? error.slice(0, 500) : "non-Error rejection";
}

function outputArtifacts(result: unknown): Array<{ name: string; contract: string; data: unknown }> {
  if (!isRecord(result) || !Array.isArray(result.artifacts)) throw new Error("PAR-035 success result has no artifact aliases.");
  return result.artifacts as Array<{ name: string; contract: string; data: unknown }>;
}

function readCheckpoint(project: string, runId: string): Checkpoint {
  return readJson(runFile(project, runId, "run.json")) as unknown as Checkpoint;
}

function readEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(runFile(project, runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readMetrics(project: string, runId: string): unknown[] {
  const value: unknown = JSON.parse(readFileSync(runFile(project, runId, "metrics.json"), "utf8"));
  if (!Array.isArray(value)) throw new Error("PAR-035 graph metrics are not a call-keyed array.");
  return value;
}

function metricCallIds(metrics: unknown[]): string[] {
  return metrics.map((metric) => {
    if (!isRecord(metric) || typeof metric.callId !== "string") throw new Error("PAR-035 metric row has no call ID.");
    return metric.callId;
  }).sort(compareStrings);
}

function captureTree(snapshot: FileSnapshot, root: string, relative: string): void {
  const directory = path.join(root, relative);
  if (!existsSync(directory)) throw new Error(`PAR-035 expected evidence directory '${relative}'.`);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const childRelative = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) captureTree(snapshot, root, childRelative);
    else if (entry.isFile()) captureFile(snapshot, root, childRelative);
  }
}

function captureFile(snapshot: FileSnapshot, root: string, relative: string): void {
  snapshot.set(relative.replaceAll("\\", "/"), readBytes(path.join(root, relative)));
}

function runDirectory(project: string, runId: string): string {
  return path.join(project, ".nodulus", "runs", runId);
}

function runFile(project: string, runId: string, relative: string): string {
  return path.join(runDirectory(project, runId), relative);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function readBytes(file: string): Buffer {
  return readFileSync(file);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const nativeTemp = realpathSync.native(tmpdir());
  const current = realpathSync.native(project);
  if (current !== identity || path.dirname(identity) !== nativeTemp || !path.basename(identity).startsWith(`nodulus-${label}-`)) {
    throw new Error("PAR-035 refused cleanup outside the exact owned native temporary project.");
  }
}

function assertBeforeDeadline(deadline: number, operation: string): void {
  if (Date.now() >= deadline) throw new Error(`PAR-035 shared scenario deadline expired during ${operation}.`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("PAR-035 cleanup failed with a non-Error value.");
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: string[]): string[] {
  return [...values].sort(compareStrings);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

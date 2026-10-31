import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createInitializedProject } from "../support/intake-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type DriverOperation = "initial" | "partial" | "final";
type RecordValue = Record<string, unknown>;
type Outcome =
  | { kind: "result"; result: { runId: string; status: string; result: unknown } }
  | { kind: "error"; error: { name: string; code?: string; message: string } };
type DriverObservations = {
  availability: string[];
  invocations: Array<{ nodeId: string; callId: string | null; attempt: number; parentCallId: string | null; answers: RecordValue | null }>;
  repairs: Array<RecordValue>;
  telemetry: string[];
  launches: string[];
  legacyUsage: number;
  observationLimitExceeded: boolean;
};
type DriverEnvelope = {
  protocol: string;
  operation: DriverOperation;
  nonce: string;
  outcome: Outcome;
  observations: DriverObservations;
  settled: { public: boolean; delegated: boolean };
};
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
type CallerRequest = { id: string; nodeId: null; kind: "caller_inputs"; attempt: 0; questions: Array<{ id: string; message: string }>; answerContract: RecordValue };
type NodeRequest = { id: string; nodeId: "root"; attempt: number; callId: string; questions: Array<{ id: string; message: string }>; answerContract: RecordValue };
type FixtureEvent = { stage: string; pid: number; runId?: string; nodeId?: string; callId?: string; attempt?: number; model?: string; containsCallerGoal?: boolean; containsNodeAnswer?: boolean };
type GraphCheckpoint = { status: string; completedNodes: string[]; graph: { admissionClosed: boolean; nextEventSequence: number; callerInputs: RecordValue; nodes: Record<string, RecordValue>; pendingRequests: Record<string, RecordValue> } };

const fixtureSource = fileURLToPath(new URL("../fixtures/par-037-caller-node-history-provider.mjs", import.meta.url));
const driverSource = fileURLToPath(new URL("../fixtures/par-033-fresh-resume-driver.mjs", import.meta.url));
const callerGoal = "The caller supplied this independent goal.";
const nodeAnswer = { rootApproval: "approve-root" };
const nodeAnswerText = "approve-root";
const resultText = "caller and node history preserved";
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const profileTimeoutMs = 20_000;
const testCeilingMs = 35_000;
const fixtureLifetimeMs = 60_000;
const maxCapturedDriverOutputBytes = 256_000;
const labelPrefix = "par-037-caller-node-history-";

test("PAR-037 caller answers remain verified history through node-question continuation", async () => {
  await exerciseCallerNodeHistory();
}, testCeilingMs);

async function exerciseCallerNodeHistory(): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = `${labelPrefix}café`;
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const stateDirectory = path.join(fixtureDirectory, "par-037-history-state");
  const eventsPath = path.join(stateDirectory, "events.jsonl");
  const handles: DriverHandle[] = [];
  let hasPrimaryError = false;
  let primaryError: unknown;
  let cleanupErrors: Error[] = [];

  try {
    assertOwnedProject(project, projectIdentity, label);
    const configured = configureProject(project, fixtureDirectory, stateDirectory, eventsPath);
    assertBeforeDeadline(scenarioDeadline, "project setup");

    const initial = await runDriver(handles, "initial", randomUUID(), project, scenarioDeadline);
    const initialResult = requireResult(initial, "initial caller-input pause");
    const runId = initialResult.runId;
    expect(initialResult.status).toBe("needs_input");
    const callerRequest = callerRequestFromResult(initialResult.result);
    assertCallerPause(project, runId, callerRequest, eventsPath);
    expect(initial.observations).toMatchObject({ availability: [], invocations: [], repairs: [], telemetry: [], launches: [], legacyUsage: 0, observationLimitExceeded: false });
    expect(readFixtureEvents(eventsPath)).toEqual([]);

    const initialInputs = readRunBytes(project, runId, "inputs.json");
    const initialInputsSha256 = digest(initialInputs);
    expect(readFileSync(runFile(project, runId, "request.md"), "utf8")).not.toContain(callerGoal);
    const capturedInputs = readJson(runFile(project, runId, "inputs.json"));
    expect(capturedInputs.callerInputs).toEqual({});
    expect(JSON.stringify(capturedInputs.instructions)).not.toContain(callerGoal);
    const beforeWrongId = snapshotRunTree(project, runId);
    const fixtureBytesBeforeWrongId = readFileSync(eventsPath);
    const wrongAnswersPath = path.join(stateDirectory, "answers-wrong-id.json");
    writeJsonFile(wrongAnswersPath, { goal: callerGoal });
    const wrongId = await runDriver(handles, "partial", randomUUID(), project, scenarioDeadline, runId, randomUUID(), wrongAnswersPath);
    expect(publicErrorCode(wrongId)).toBe("PENDING_REQUEST_MISMATCH");
    expect(wrongId.observations).toMatchObject({ availability: [], invocations: [], repairs: [], telemetry: [], launches: [], legacyUsage: 0, observationLimitExceeded: false });
    expect(snapshotRunTree(project, runId)).toEqual(beforeWrongId);
    expect(readFileSync(eventsPath)).toEqual(fixtureBytesBeforeWrongId);

    const callerAnswersPath = path.join(stateDirectory, "answers-caller.json");
    writeJsonFile(callerAnswersPath, { goal: callerGoal });
    const callerResume = await runDriver(handles, "partial", randomUUID(), project, scenarioDeadline, runId, callerRequest.id, callerAnswersPath);
    const callerResumeResult = requireResult(callerResume, "caller answer continuation");
    expect(callerResumeResult.status).toBe("needs_input");
    const rootRequest = nodeRequestFromResult(callerResumeResult.result);
    expect(rootRequest.id).not.toBe("provider-untrusted-root-question");
    expect(rootRequest.nodeId).toBe("root");
    expect(rootRequest.attempt).toBe(1);
    expect(rootRequest.answerContract).toMatchObject({ type: "object", required: ["rootApproval"], additionalProperties: false, properties: { rootApproval: { const: nodeAnswerText } } });
    const nodeAnswersPath = path.join(stateDirectory, "answers-root.json");
    writeJsonFile(nodeAnswersPath, nodeAnswer);
    const originalOrderEventsBytes = readRunBytes(project, runId, "events.jsonl");
    const originalOrderEvents = readRunEvents(project, runId);
    const callerAnsweredEvents = originalOrderEvents.filter((event) => event.event === "request.answered" && event.requestId === callerRequest.id);
    const callerResumedEvents = originalOrderEvents.filter((event) => event.event === "run.resumed" && event.requestId === callerRequest.id);
    const rootStartedEvents = originalOrderEvents.filter((event) => event.event === "node.started" && event.nodeId === "root");
    const rootCallStartedEvents = originalOrderEvents.filter((event) => event.event === "provider.call.started" && event.nodeId === "root");
    expect(callerAnsweredEvents).toHaveLength(1);
    expect(callerResumedEvents).toHaveLength(1);
    expect(rootStartedEvents).toHaveLength(1);
    expect(rootCallStartedEvents).toHaveLength(1);
    const callerAnsweredEvent = callerAnsweredEvents[0]!;
    const callerResumedEvent = callerResumedEvents[0]!;
    const rootStartedEvent = rootStartedEvents[0]!;
    const rootCallStartedEvent = rootCallStartedEvents[0]!;
    if (typeof callerAnsweredEvent.sequence !== "number" || typeof callerResumedEvent.sequence !== "number" ||
        typeof rootStartedEvent.sequence !== "number" || typeof rootCallStartedEvent.sequence !== "number" ||
        typeof callerResume.observations.invocations[0]?.callId !== "string") {
      throw new Error("PAR-037 caller/node transition events have incomplete sequence or call identity.");
    }
    expect(new Set([callerAnsweredEvent.sequence, callerResumedEvent.sequence, rootStartedEvent.sequence, rootCallStartedEvent.sequence]).size).toBe(4);
    expect(callerAnsweredEvent).toMatchObject({ runId, requestId: callerRequest.id, kind: "caller_inputs", nodeId: null });
    expect(callerResumedEvent).toMatchObject({ runId, requestId: callerRequest.id });
    const rootAdmissionCallId = callerResume.observations.invocations[0]?.callId;
    expect(rootStartedEvent).toMatchObject({ runId, nodeId: "root", callId: rootAdmissionCallId, attempt: 1 });
    expect(rootCallStartedEvent).toMatchObject({ runId, nodeId: "root", callId: rootAdmissionCallId, attempt: 1, operation: "invoke" });
    expect(rootCallStartedEvent).not.toHaveProperty("parentCallId");
    const originalEventIndex = (event: RecordValue): number => originalOrderEvents.indexOf(event);
    expect(originalEventIndex(callerAnsweredEvent)).toBeLessThan(originalEventIndex(callerResumedEvent));
    expect(originalEventIndex(callerResumedEvent)).toBeLessThan(originalEventIndex(rootStartedEvent));
    expect(originalEventIndex(rootStartedEvent)).toBeLessThan(originalEventIndex(rootCallStartedEvent));
    expect(callerAnsweredEvent.sequence).toBeLessThan(callerResumedEvent.sequence);
    expect(callerResumedEvent.sequence).toBeLessThan(rootStartedEvent.sequence);
    expect(rootStartedEvent.sequence).toBeLessThan(rootCallStartedEvent.sequence);

    const runTreeBeforeOrderMutation = snapshotRunTree(project, runId);
    const checkpointBeforeOrderMutation = readCheckpoint(project, runId);
    const fixtureBeforeOrderMutation = readFileSync(eventsPath);
    const fixtureTreeBeforeOrderMutation = snapshotDirectory(stateDirectory);
    const originalPositions = [callerAnsweredEvent, callerResumedEvent, rootStartedEvent, rootCallStartedEvent]
      .map(originalEventIndex)
      .sort((left, right) => left - right);
    const reorderedEvents = originalOrderEvents.map((event) => ({ ...event }));
    const reorderedEntries = [rootStartedEvent, rootCallStartedEvent, callerAnsweredEvent, callerResumedEvent];
    originalPositions.forEach((position, index) => { reorderedEvents[position] = { ...reorderedEntries[index]! }; });
    const firstSequence = originalOrderEvents[0]?.sequence;
    if (typeof firstSequence !== "number" || !Number.isSafeInteger(firstSequence)) throw new Error("PAR-037 node pause has no valid initial event sequence.");
    for (let index = 0; index < reorderedEvents.length; index += 1) reorderedEvents[index]!.sequence = firstSequence + index;
    const movedPositions = new Set(originalPositions);
    originalPositions.forEach((position, index) => {
      expect(reorderedEvents[position]).toEqual({ ...reorderedEntries[index], sequence: firstSequence + position });
    });
    for (let index = 0; index < reorderedEvents.length; index += 1) {
      if (!movedPositions.has(index)) expect(reorderedEvents[index]).toEqual(originalOrderEvents[index]);
    }
    assertContiguousSequences(reorderedEvents);
    const reorderedEventsBytes = Buffer.from(`${reorderedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    writeFileSync(runFile(project, runId, "events.jsonl"), reorderedEventsBytes);
    const runTreeWithOrderMutation = snapshotRunTree(project, runId);
    expect(changedRunFiles(runTreeBeforeOrderMutation, runTreeWithOrderMutation)).toEqual(["events.jsonl"]);
    expect(readFileSync(eventsPath)).toEqual(fixtureBeforeOrderMutation);
    expect(snapshotDirectory(stateDirectory)).toEqual(fixtureTreeBeforeOrderMutation);
    expect(reorderedEvents).toHaveLength(originalOrderEvents.length);
    expect(readCheckpoint(project, runId).graph.nextEventSequence).toBe(checkpointBeforeOrderMutation.graph.nextEventSequence);
    const orderMutationBaseline = snapshotRunTree(project, runId);
    const orderMutationFixtureBaseline = readFileSync(eventsPath);
    const orderMutationRejected = await runDriver(handles, "partial", randomUUID(), project, scenarioDeadline, runId, rootRequest.id, nodeAnswersPath);
    expect(publicErrorCode(orderMutationRejected)).toBe("RUN_STATE_INVALID");
    expect(orderMutationRejected.observations).toMatchObject({ availability: [], invocations: [], repairs: [], telemetry: [], launches: [], legacyUsage: 0, observationLimitExceeded: false });
    expect(snapshotRunTree(project, runId)).toEqual(orderMutationBaseline);
    expect(readFileSync(eventsPath)).toEqual(orderMutationFixtureBaseline);
    expect(snapshotDirectory(stateDirectory)).toEqual(fixtureTreeBeforeOrderMutation);
    writeFileSync(runFile(project, runId, "events.jsonl"), originalOrderEventsBytes);
    expect(snapshotRunTree(project, runId)).toEqual(runTreeBeforeOrderMutation);
    expect(readFileSync(eventsPath)).toEqual(fixtureBeforeOrderMutation);
    expect(snapshotDirectory(stateDirectory)).toEqual(fixtureTreeBeforeOrderMutation);

    const rootPendingBytes = readRunBytes(project, runId, `pending/${rootRequest.id}.json`);
    expect(JSON.parse(rootPendingBytes.toString("utf8"))).toEqual(rootRequest);
    expect(readCheckpoint(project, runId).graph.pendingRequests[rootRequest.id]).toMatchObject({
      nodeId: "root",
      kind: "node",
      attempt: 1,
      requestRef: `pending/${rootRequest.id}.json`,
      requestSha256: digest(rootPendingBytes),
    });
    expect(callerResume.observations.observationLimitExceeded).toBe(false);
    expect(callerResume.observations.invocations).toHaveLength(1);
    expect(callerResume.observations.invocations[0]).toMatchObject({ nodeId: "root", attempt: 1, parentCallId: null, answers: null });
    expect(callerResume.observations.availability).toEqual(["p4d-caller-history-captured"]);
    expect(callerResume.observations.repairs).toHaveLength(0);
    const rootCallId = callerResume.observations.invocations[0]?.callId;
    if (!rootCallId) throw new Error("PAR-037 root attempt 1 did not expose its runtime call ID.");
    expect(callerResume.observations.telemetry).toEqual([rootCallId]);
    expect(callerResume.observations.launches).toEqual([rootCallId]);
    expect(callerResume.observations.legacyUsage).toBe(0);

    const rootInvocation = readJson(runFile(project, runId, "nodes/root/attempt-001/invocation.json"));
    expect(rootInvocation).toMatchObject({
      callId: rootCallId,
      nodeId: "root",
      attempt: 1,
      inputs: { goal: callerGoal },
      inputMappings: { goal: { from: "caller.goal", contract: "goal.v1" } },
      resolvedProviderProfile: { model: "p4d-caller-history-captured" },
    });
    expect(rootInvocation).not.toHaveProperty("answers");
    expect(rootInvocation.parentCallId).toBeUndefined();
    expect(readFileSync(runFile(project, runId, "nodes/root/attempt-001/prompt.md"), "utf8")).toContain(callerGoal);
    const rootCallRequest = readJson(runFile(project, runId, `calls/${rootCallId}/request.json`));
    expect(rootCallRequest).toMatchObject({ runId, nodeId: "root", callId: rootCallId, attempt: 1, parentCallId: null, requestedModel: "p4d-caller-history-captured" });
    assertTransport(project, runId, rootCallId, configured.executable);
    const callerAnswer = { goal: callerGoal };
    const callerAnswerPath = runFile(project, runId, `answers/${callerRequest.id}.json`);
    const callerAnswerBytes = readFileSync(callerAnswerPath);
    expect(JSON.parse(callerAnswerBytes.toString("utf8"))).toEqual(callerAnswer);
    expect(digest(callerAnswerBytes)).toBe(readCheckpoint(project, runId).graph.pendingRequests[callerRequest.id]?.answerSha256);
    expect(readCheckpoint(project, runId).graph.pendingRequests[callerRequest.id]).toMatchObject({
      nodeId: null,
      kind: "caller_inputs",
      attempt: 0,
      answerRef: `answers/${callerRequest.id}.json`,
      answerSha256: digest(callerAnswerBytes),
    });
    assertCallerAnswerEvent(project, runId, callerRequest);
    expect(readRunBytes(project, runId, "inputs.json")).toEqual(initialInputs);
    expect(digest(readRunBytes(project, runId, "inputs.json"))).toBe(initialInputsSha256);
    expect(readFixtureEvents(eventsPath).map(({ stage }) => stage)).toEqual(["version", "readiness", "version", "readiness", "inference"]);
    expect(readFixtureEvents(eventsPath).at(-1)).toMatchObject({ runId, nodeId: "root", callId: rootCallId, attempt: 1, model: "p4d-caller-history-captured", containsCallerGoal: true, containsNodeAnswer: false });
    expect(callerResume.observations.repairs).toHaveLength(0);
    expect(readRunEvents(project, runId).some((event) => event.event === "run.needs_input" && Array.isArray(event.requestIds) && event.requestIds.includes(rootRequest.id))).toBe(true);

    const beforeTamper = snapshotRunTree(project, runId);
    const fixtureBytesBeforeTamper = readFileSync(eventsPath);
    const tamperedCallerAnswer = Buffer.from(`${JSON.stringify({ goal: "tampered caller goal" })}\n`, "utf8");
    writeFileSync(callerAnswerPath, tamperedCallerAnswer);
    const afterTamper = snapshotRunTree(project, runId);
    const callerHashFailure = await runDriver(handles, "partial", randomUUID(), project, scenarioDeadline, runId, rootRequest.id, nodeAnswersPath);
    expect(publicErrorCode(callerHashFailure)).toBe("RUN_STATE_INVALID");
    expect(callerHashFailure.observations).toMatchObject({ availability: [], invocations: [], repairs: [], telemetry: [], launches: [], legacyUsage: 0, observationLimitExceeded: false });
    expect(snapshotRunTree(project, runId)).toEqual(afterTamper);
    expect(snapshotRunTree(project, runId)).not.toEqual(beforeTamper);
    expect(readFileSync(eventsPath)).toEqual(fixtureBytesBeforeTamper);
    writeFileSync(callerAnswerPath, callerAnswerBytes);

    const eventsBeforeFinal = readRunEvents(project, runId);
    const metricsBeforeFinal = readMetrics(project, runId);
    expect(metricsBeforeFinal).toHaveLength(1);
    expect(metricsBeforeFinal[0]).toMatchObject({ nodeId: "root", attempt: 1, callId: rootCallId });
    const finalResume = await runDriver(handles, "final", randomUUID(), project, scenarioDeadline, runId, rootRequest.id, nodeAnswersPath);
    const finalResult = requireResult(finalResume, "final node answer continuation");
    expect(finalResult.runId).toBe(runId);
    expect(finalResult.status).toBe("success");
    expect(finalResult.result).toMatchObject({ artifacts: [{ name: "finalReport", contract: "report.v1", data: { text: resultText } }] });
    expect(finalResume.observations).toMatchObject({ observationLimitExceeded: false, repairs: [] });
    expect(finalResume.observations.invocations).toHaveLength(1);
    const finalInvocation = finalResume.observations.invocations[0];
    expect(finalInvocation).toMatchObject({ nodeId: "root", attempt: 2, parentCallId: rootCallId, answers: nodeAnswer });
    expect(finalInvocation?.callId).not.toBe(rootCallId);
    const finalCallId = finalInvocation?.callId;
    if (!finalCallId) throw new Error("PAR-037 root attempt 2 did not expose its runtime call ID.");

    const finalCheckpoint = readCheckpoint(project, runId);
    expect(finalCheckpoint).toMatchObject({ status: "success", completedNodes: ["root"], graph: { callerInputs: { goal: callerGoal }, nodes: { root: { phase: "accepted", attempt: 2, callId: finalCallId } } } });
    expect(finalCheckpoint.graph.pendingRequests[callerRequest.id]).toMatchObject({ kind: "caller_inputs", answerRef: `answers/${callerRequest.id}.json`, answerSha256: digest(callerAnswerBytes) });
    expect(finalCheckpoint.graph.pendingRequests[rootRequest.id]).toMatchObject({ kind: "node", nodeId: "root", attempt: 1, answerRef: `answers/${rootRequest.id}.json` });
    const rootAnswerBytes = readRunBytes(project, runId, `answers/${rootRequest.id}.json`);
    expect(JSON.parse(rootAnswerBytes.toString("utf8"))).toEqual(nodeAnswer);
    expect(finalCheckpoint.graph.pendingRequests[rootRequest.id]).toMatchObject({ answerSha256: digest(rootAnswerBytes) });
    expect(readRunBytes(project, runId, "inputs.json")).toEqual(initialInputs);
    expect(readFileSync(callerAnswerPath)).toEqual(callerAnswerBytes);
    const finalInvocationFile = readJson(runFile(project, runId, "nodes/root/attempt-002/invocation.json"));
    expect(finalInvocationFile).toMatchObject({
      callId: finalCallId,
      parentCallId: rootCallId,
      nodeId: "root",
      attempt: 2,
      inputs: { goal: callerGoal },
      inputMappings: { goal: { from: "caller.goal", contract: "goal.v1" } },
      resolvedProviderProfile: { model: "p4d-caller-history-captured" },
    });
    expect(finalResume.observations.availability).toEqual(["p4d-caller-history-captured"]);
    expect(finalResume.observations.invocations).toHaveLength(1);
    expect(finalResume.observations.invocations[0]?.answers).toEqual(nodeAnswer);
    expect(finalResume.observations.invocations[0]?.answers).not.toHaveProperty("goal");
    expect(finalResume.observations.telemetry).toEqual([finalCallId]);
    expect(finalResume.observations.launches).toEqual([finalCallId]);
    expect(finalResume.observations.legacyUsage).toBe(0);
    assertTransport(project, runId, finalCallId, configured.executable);
    expect(readFixtureEvents(eventsPath).at(-1)).toMatchObject({ runId, nodeId: "root", callId: finalCallId, attempt: 2, model: "p4d-caller-history-captured", containsCallerGoal: true, containsNodeAnswer: true });
    const finalMetrics = readMetrics(project, runId);
    expect(finalMetrics).toHaveLength(2);
    expect(finalMetrics.map(metricCallId).sort(compareStrings)).toEqual([rootCallId, finalCallId].sort(compareStrings));
    const finalEvents = readRunEvents(project, runId);
    assertContiguousSequences(finalEvents);
    expect(finalEvents.filter((event) => event.event === "request.answered" && event.requestId === callerRequest.id)).toHaveLength(1);
    expect(finalEvents.filter((event) => event.event === "request.answered" && event.requestId === rootRequest.id)).toHaveLength(1);
    assertContentFreeAnswerEvent(finalEvents, callerRequest.id, "caller_inputs", null, callerGoal);
    assertContentFreeAnswerEvent(finalEvents, rootRequest.id, "node", "root", nodeAnswerText);
    expect(finalEvents.slice(0, eventsBeforeFinal.length)).toEqual(eventsBeforeFinal);
    expect(finalEvents.some((event) => event.event === "provider.call.started" && event.callId === rootCallId)).toBe(true);
    expect(finalEvents.some((event) => event.event === "provider.call.started" && event.callId === finalCallId)).toBe(true);
    assertAcceptedEvidence(project, runId, finalCheckpoint, finalCallId);
    expect(handles).toHaveLength(6);
    expect(new Set(handles.map((handle) => handle.nonce)).size).toBe(6);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    cleanupErrors = await settleDriversAndCleanup(project, projectIdentity, label, handles, hasPrimaryError);
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "PAR-037 mixed caller/node history and cleanup failed.");
  if (!hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-037 mixed caller/node history cleanup failed.");
  if (hasPrimaryError) throw primaryError;
}

function configureProject(project: string, fixtureDirectory: string, stateDirectory: string, eventsPath: string): { executable: string } {
  mkdirSync(fixtureDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  writeFileSync(path.join(fixtureDirectory, "par-037-caller-node-history-provider.mjs"), readFileSync(fixtureSource, "utf8"), "utf8");
  writeJsonFile(path.join(fixtureDirectory, "par-037-history-control.json"), {
    eventsPath: path.relative(project, eventsPath),
    fixtureLifetimeMs,
    callerGoal,
    nodeAnswer,
    resultText,
  });

  const wrapper = path.join(fixtureDirectory, process.platform === "win32" ? "par-037-history-provider.cmd" : "par-037-history-provider.sh");
  const scriptRelative = ".nodulus/fixtures/par-037-caller-node-history-provider.mjs";
  if (process.platform === "win32") {
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${path.win32.join(".nodulus", "fixtures", "par-037-caller-node-history-provider.mjs")}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '${scriptRelative}' "$@"\n`, "utf8");
    chmodSync(wrapper, 0o755);
  }

  const settings = readProjectJson(project, ".nodulus/settings.json") as RecordValue;
  settings.providerProfiles = {
    fixture: {
      enabled: true,
      executable: wrapper,
      kind: "codex",
      model: "p4d-caller-history-captured",
      timeoutMs: profileTimeoutMs,
      capabilities: [],
      sandbox: "read-only",
      reasoningEffort: "medium",
    },
  };
  writeJson(project, ".nodulus/settings.json", settings);
  writeJson(project, ".nodulus/contracts/goal.v1.schema.json", { type: "string", minLength: 5 });
  writeJson(project, ".nodulus/contracts/report.v1.schema.json", {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1 } },
    additionalProperties: false,
  });
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 2,
    id: "example",
    nodes: ["root"],
    inputs: { goal: { contract: "goal.v1" } },
    execution: { kind: "dag", maxConcurrency: 1, dependsOn: { root: [] }, resources: { root: [] } },
    outputs: [{ name: "finalReport", from: "root.report", contract: "report.v1" }],
  });
  const template = readProjectJson(project, ".nodulus/nodes/example.json");
  writeJson(project, ".nodulus/nodes/root.json", {
    ...template,
    id: "root",
    providerProfile: "fixture",
    instructions: [".nodulus/instructions/goal.md"],
    inputs: { goal: { from: "caller.goal", contract: "goal.v1" } },
    expectedOutputs: [{ name: "report", contract: "report.v1" }],
  });
  writeFileSync(path.join(project, ".nodulus", "instructions", "goal.md"), "Use the independently supplied goal to prepare an approval report.\n", "utf8");
  return { executable: wrapper };
}

async function runDriver(
  handles: DriverHandle[], operation: DriverOperation, nonce: string, project: string, deadline: number,
  runId?: string, requestId?: string, answersPath?: string,
): Promise<DriverEnvelope> {
  const handle = startDriver(handles, operation, nonce, project, runId, requestId, answersPath);
  return readDriverEnvelope(handle, deadline);
}

function startDriver(
  handles: DriverHandle[], operation: DriverOperation, nonce: string, project: string,
  runId?: string, requestId?: string, answersPath?: string,
): DriverHandle {
  const args = [driverSource, operation, nonce, project];
  if (operation !== "initial") args.push(runId ?? "", requestId ?? "", answersPath ?? "");
  const child = spawn(process.execPath, args, { cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const handle: DriverHandle = {
    operation, nonce, child,
    closed: Promise.resolve({ code: null, signal: null }),
    stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, outputOverflow: false,
  };
  handle.closed = new Promise((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal, ...(spawnError === undefined ? {} : { error: spawnError }) }));
  });
  child.stdin.on("error", (error) => { handle.stdinError = new Error(`${error.name}: ${error.message.slice(0, 1000)}`, { cause: error }); });
  child.stdout.on("data", (chunk: Buffer | string) => appendBoundedOutput(handle, "stdout", chunk));
  child.stderr.on("data", (chunk: Buffer | string) => appendBoundedOutput(handle, "stderr", chunk));
  child.stdin.end();
  void handle.closed.catch(() => undefined);
  handles.push(handle);
  if (typeof child.pid !== "number" || !Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error(`PAR-037 ${operation} driver has no operating-system PID.`);
  return handle;
}

function appendBoundedOutput(handle: DriverHandle, stream: "stdout" | "stderr", chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
  const stored = stream === "stdout" ? handle.stdout : handle.stderr;
  const key = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
  const remaining = maxCapturedDriverOutputBytes - handle[key];
  if (remaining <= 0) { handle.outputOverflow = true; return; }
  stored.push(bytes.subarray(0, remaining));
  handle[key] += Math.min(bytes.length, remaining);
  if (bytes.length > remaining) handle.outputOverflow = true;
}

async function readDriverEnvelope(handle: DriverHandle, deadline: number): Promise<DriverEnvelope> {
  const closed = await withDeadline(handle.closed, deadline, `${handle.operation} driver close`);
  if (closed.error) throw new Error(`PAR-037 ${handle.operation} driver could not start: ${closed.error.message}`);
  if (closed.code !== 0 || closed.signal !== null) {
    throw new Error(`PAR-037 ${handle.operation} driver exited code=${String(closed.code)} signal=${String(closed.signal)}; stdout=${driverOutput(handle.stdout)}; stderr=${driverOutput(handle.stderr)}`);
  }
  if (handle.stdinError) throw new Error(`PAR-037 ${handle.operation} driver stdin failed: ${handle.stdinError.message}`, { cause: handle.stdinError });
  if (handle.outputOverflow) throw new Error(`PAR-037 ${handle.operation} driver exceeded its bounded stdio capture; stderr=${driverOutput(handle.stderr)}`);
  const stdout = Buffer.concat(handle.stdout).toString("utf8");
  const stderr = Buffer.concat(handle.stderr).toString("utf8");
  expect(stderr, `PAR-037 ${handle.operation} driver stderr`).toBe("");
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  expect(lines, `PAR-037 ${handle.operation} driver must emit one bounded envelope`).toHaveLength(1);
  const envelope = JSON.parse(lines[0]!) as DriverEnvelope;
  expect(envelope.protocol).toBe("par-033-fresh-resume-driver-v1");
  expect(envelope.operation).toBe(handle.operation);
  expect(envelope.nonce).toBe(handle.nonce);
  if ("driverError" in (envelope as unknown as RecordValue)) throw new Error(`PAR-037 driver setup failed: ${JSON.stringify((envelope as unknown as RecordValue).driverError)}`);
  expect(envelope.settled).toEqual({ public: true, delegated: true });
  expect(envelope.observations.observationLimitExceeded).toBe(false);
  return envelope;
}

function requireResult(envelope: DriverEnvelope, description: string): Extract<Outcome, { kind: "result" }>['result'] {
  if (envelope.outcome.kind === "error") throw new Error(`PAR-037 ${description} rejected (${envelope.outcome.error.code ?? envelope.outcome.error.name}): ${envelope.outcome.error.message}`);
  return envelope.outcome.result;
}

function publicErrorCode(envelope: DriverEnvelope): string {
  if (envelope.outcome.kind === "error") return envelope.outcome.error.code ?? "unknown";
  if (envelope.outcome.result.status !== "error") return "none";
  return errorCode(envelope.outcome.result.result);
}

function callerRequestFromResult(result: unknown): CallerRequest {
  if (!isRecord(result) || !isRecord(result.request) || !Array.isArray(result.requests)) throw new Error("PAR-037 initial pause has no request/requests projection.");
  const request = result.request;
  if (typeof request.id !== "string" || request.nodeId !== null || request.kind !== "caller_inputs" || request.attempt !== 0 || !isRecord(request.answerContract)) {
    throw new Error("PAR-037 caller-input request has invalid identity or answer contract.");
  }
  expect(result.requests).toEqual([request]);
  return request as unknown as CallerRequest;
}

function nodeRequestFromResult(result: unknown): NodeRequest {
  if (!isRecord(result) || !isRecord(result.request) || !Array.isArray(result.requests)) throw new Error("PAR-037 node pause has no request/requests projection.");
  const request = result.request;
  const matches = result.requests.filter((candidate): candidate is RecordValue => isRecord(candidate) && candidate.nodeId === "root");
  expect(matches).toHaveLength(1);
  expect(matches[0]).toEqual(request);
  if (typeof request.id !== "string" || request.nodeId !== "root" || !Number.isSafeInteger(request.attempt) || typeof request.callId !== "string" || !isRecord(request.answerContract)) {
    throw new Error("PAR-037 root question has invalid runtime identity.");
  }
  return request as unknown as NodeRequest;
}

function assertCallerPause(project: string, runId: string, request: CallerRequest, eventsPath: string): void {
  expect(request.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  expect(request.answerContract).toMatchObject({ type: "object", required: ["goal"], additionalProperties: false, properties: { goal: { $ref: "#/$defs/goal.v1" } } });
  const checkpoint = readCheckpoint(project, runId);
  expect(checkpoint).toMatchObject({ status: "needs_input", completedNodes: [], graph: { admissionClosed: true, callerInputs: {}, nodes: { root: { phase: "not_started", attempt: 0 } } } });
  const pending = readJson(runFile(project, runId, `pending/${request.id}.json`));
  const pendingBytes = readRunBytes(project, runId, `pending/${request.id}.json`);
  expect(pending).toEqual(request);
  expect(checkpoint.graph.pendingRequests).toMatchObject({ [request.id]: { nodeId: null, kind: "caller_inputs", attempt: 0, requestRef: `pending/${request.id}.json`, requestSha256: digest(pendingBytes) } });
  expect(existsSync(runFile(project, runId, "nodes/root"))).toBe(false);
  expect(existsSync(runFile(project, runId, "calls"))).toBe(false);
  const events = readRunEvents(project, runId);
  expect(events.filter((event) => event.event === "run.intake.completed")).toHaveLength(1);
  const introductions = events.filter((event) => event.event === "graph.admission.closed" && event.requestId === request.id);
  expect(introductions).toHaveLength(1);
  expect(introductions[0]).toMatchObject({ kind: "caller_inputs", nodeId: null, attempt: 0 });
  const pauses = events.filter((event) => event.event === "run.needs_input" && Array.isArray(event.requestIds) && event.requestIds.includes(request.id));
  expect(pauses).toHaveLength(1);
  expect(pauses[0]).toMatchObject({ requestIds: [request.id] });
  expect(events.some((event) => typeof event.event === "string" && /^(?:node\.|provider\.call\.)/.test(event.event))).toBe(false);
  expect(events.every((event) => Number.isSafeInteger(event.sequence))).toBe(true);
  assertContiguousSequences(events);
  expect(readFileSync(eventsPath, "utf8")).toBe("");
}

function assertCallerAnswerEvent(project: string, runId: string, request: CallerRequest): void {
  assertContentFreeAnswerEvent(readRunEvents(project, runId), request.id, "caller_inputs", null, callerGoal);
}

function assertContentFreeAnswerEvent(events: Array<RecordValue>, requestId: string, kind: string, nodeId: string | null, answerValue: string): void {
  const answerEvents = events.filter((event) => event.event === "request.answered" && event.requestId === requestId);
  expect(answerEvents).toHaveLength(1);
  expect(answerEvents[0]).toMatchObject({ event: "request.answered", requestId, kind, nodeId });
  expect(answerEvents[0]).not.toHaveProperty("answer");
  expect(answerEvents[0]).not.toHaveProperty("answers");
  expect(JSON.stringify(answerEvents[0])).not.toContain(answerValue);
}

function assertTransport(project: string, runId: string, callId: string, executable: string): void {
  const callRoot = path.join(runDirectory(project, runId), "calls", callId);
  const transport = readJson(path.join(callRoot, "transport.json"));
  expect(transport).toMatchObject({ callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
  const request = readJson(path.join(callRoot, "request.json"));
  expect(request).toMatchObject({ runId, nodeId: "root", callId, providerProfileId: "fixture", requestedModel: "p4d-caller-history-captured", executable });
}

function assertAcceptedEvidence(project: string, runId: string, checkpoint: GraphCheckpoint, callId: string): void {
  const accepted = checkpoint.graph.nodes.root?.accepted;
  if (!isRecord(accepted) || !Array.isArray(accepted.artifacts)) throw new Error("PAR-037 successful root has no accepted evidence manifest.");
  expect(accepted).toMatchObject({ attempt: 2, callId });
  const expected = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: resultText } }] };
  for (const [refField, hashField] of [["resultRef", "resultSha256"], ["validationRef", "validationSha256"], ["responseRef", "responseSha256"]] as const) {
    const relative = accepted[refField];
    const expectedHash = accepted[hashField];
    if (typeof relative !== "string" || typeof expectedHash !== "string") throw new Error(`PAR-037 accepted record has invalid ${refField} evidence.`);
    const bytes = readRunBytes(project, runId, relative);
    expect(digest(bytes)).toBe(expectedHash);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (refField === "validationRef") expect(parsed).toMatchObject({ valid: true, outcome: "success", errors: [] });
    else expect(parsed).toEqual(expected);
  }
  expect(accepted.artifacts).toHaveLength(1);
  const artifact = accepted.artifacts[0];
  if (!isRecord(artifact) || typeof artifact.ref !== "string" || typeof artifact.sha256 !== "string") throw new Error("PAR-037 accepted artifact reference is malformed.");
  expect(artifact).toMatchObject({ name: "report", contract: "report.v1" });
  const artifactBytes = readRunBytes(project, runId, artifact.ref);
  expect(digest(artifactBytes)).toBe(artifact.sha256);
  expect(JSON.parse(artifactBytes.toString("utf8"))).toEqual({ name: "report", contract: "report.v1", data: { text: resultText } });
  expect(JSON.parse(readFileSync(runFile(project, runId, "outputs.json"), "utf8"))).toEqual([{ name: "finalReport", contract: "report.v1", data: { text: resultText } }]);
}

async function settleDriversAndCleanup(project: string, identity: string, label: string, handles: DriverHandle[], retain: boolean): Promise<Error[]> {
  const errors: Error[] = [];
  const deadline = Date.now() + cleanupBudgetMs;
  try { await withDeadline(Promise.all(handles.map((handle) => handle.closed)), deadline, "all fresh driver close events"); }
  catch (error) { errors.push(asError(error)); }
  if (retain || errors.length > 0) {
    console.error(`PAR-037 retained caller/node history project for diagnosis: ${project}`);
    return errors;
  }
  try {
    assertOwnedProject(project, identity, label);
    rmSync(project, { recursive: true, force: true });
    if (existsSync(project)) throw new Error("PAR-037 owned project remained after cleanup.");
  } catch (error) { errors.push(asError(error)); }
  return errors;
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const temp = realpathSync.native(tmpdir());
  const current = realpathSync.native(project);
  const relative = path.relative(temp, current);
  if (current !== identity || path.dirname(current) !== temp || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(current).startsWith(`nodulus-${label}-`)) {
    throw new Error("PAR-037 refused cleanup outside its exact owned temporary project.");
  }
}

function snapshotRunTree(project: string, runId: string): Array<[string, Buffer]> {
  const root = runDirectory(project, runId);
  const files: Array<[string, Buffer]> = [];
  const visit = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const childRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) files.push([childRelative, readFileSync(child)]);
    }
  };
  visit(root, "");
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function changedRunFiles(before: Array<[string, Buffer]>, after: Array<[string, Buffer]>): string[] {
  const beforeFiles = new Map(before);
  const afterFiles = new Map(after);
  return [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
    .filter((relative) => {
      const prior = beforeFiles.get(relative);
      const current = afterFiles.get(relative);
      return prior === undefined || current === undefined || !prior.equals(current);
    })
    .sort(compareStrings);
}

function snapshotDirectory(root: string): Array<[string, Buffer]> {
  const files: Array<[string, Buffer]> = [];
  const visit = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const childRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) files.push([childRelative, readFileSync(child)]);
    }
  };
  visit(root, "");
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function readFixtureEvents(file: string): FixtureEvent[] { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent); }
function readRunEvents(project: string, runId: string): RecordValue[] { return readFileSync(runFile(project, runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RecordValue); }
function readMetrics(project: string, runId: string): unknown[] { const value: unknown = JSON.parse(readFileSync(runFile(project, runId, "metrics.json"), "utf8")); if (!Array.isArray(value)) throw new Error("PAR-037 metrics.json is not an array."); return value; }
function metricCallId(value: unknown): string { if (!isRecord(value) || typeof value.callId !== "string") throw new Error("PAR-037 metric has no call ID."); return value.callId; }
function readCheckpoint(project: string, runId: string): GraphCheckpoint { return readJson(runFile(project, runId, "run.json")) as unknown as GraphCheckpoint; }
function runDirectory(project: string, runId: string): string { return path.join(project, ".nodulus", "runs", runId); }
function runFile(project: string, runId: string, relative: string): string { return path.join(runDirectory(project, runId), relative); }
function readRunBytes(project: string, runId: string, relative: string): Buffer { return readFileSync(runFile(project, runId, relative)); }
function readJson(file: string): RecordValue { const value: unknown = JSON.parse(readFileSync(file, "utf8")); if (!isRecord(value)) throw new Error(`PAR-037 expected an object in ${path.basename(file)}.`); return value; }
function writeJsonFile(file: string, value: unknown): void { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function errorCode(value: unknown): string { if (!isRecord(value)) return "unknown"; if (typeof value.code === "string") return value.code; return isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : "unknown"; }
function isRecord(value: unknown): value is RecordValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function compareStrings(left: string, right: string): number { return left.localeCompare(right); }
function assertContiguousSequences(events: Array<RecordValue>): void {
  const sequences = events.map((event) => event.sequence);
  expect(sequences.every((value) => typeof value === "number" && Number.isSafeInteger(value))).toBe(true);
  const numeric = sequences as number[];
  expect(new Set(numeric).size).toBe(numeric.length);
  for (let index = 1; index < numeric.length; index += 1) expect(numeric[index]).toBe(numeric[index - 1]! + 1);
}
function driverOutput(chunks: Buffer[]): string { return Buffer.concat(chunks).toString("utf8").slice(-1800); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(typeof error === "string" ? error : "PAR-037 unknown cleanup failure."); }
function assertBeforeDeadline(deadline: number, operation: string): void { if (Date.now() >= deadline) throw new Error(`PAR-037 shared scenario deadline expired during ${operation}.`); }

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`PAR-037 shared scenario deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`PAR-037 shared scenario deadline expired during ${description}.`)), remaining); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

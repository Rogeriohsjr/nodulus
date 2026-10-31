import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import type { IntakeStorage } from "../../src/core/ports/intake-storage.js";
import { getRunStatus, inspectRun, resumeWorkflow, runWorkflow, type ApplicationRunResult, type ProviderPort } from "../../src/index.js";
import { observeOwnedNativeProcesses } from "../support/owned-native-processes.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { observeReadStorage, type ReadStorageObserver, type StorageMutationCounts } from "../support/read-only-storage-observer.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type RecordValue = Record<string, unknown>;
type Outcome = { kind: "result"; result: ApplicationRunResult } | { kind: "error"; error: unknown };
type Role = "seed" | "b" | "a";
type Marker = { role: Role; nodeId: Role; runId: string; callId: string; attempt: number; pid: number };
type Request = { id: string; nodeId: string; callId: string; attempt: number; questions: Array<{ id: string; message: string }>; answerContract: RecordValue };
type Activity = {
  availability: string[];
  invocations: Array<{ nodeId: string; callId?: string; attempt: number }>;
  repairs: number;
  telemetry: number;
  launches: number;
  legacyUsage: number;
  delegated: Promise<void>[];
};
type Observation = {
  activity: Omit<Activity, "delegated">;
  delegatedCount: number;
  storageMutations: StorageMutationCounts;
  nativeCount: number;
  nativeDiagnostics: string;
  nativeFailure: boolean;
  fixtureBytes: Buffer;
  validatorBytes: Buffer | null;
  fixtureTree: SnapshotEntry[];
  runTree: SnapshotEntry[];
};
type SnapshotEntry = { path: string; kind: "directory" } | { path: string; kind: "file"; bytes: Buffer };

const fixtureSource = fileURLToPath(new URL("../fixtures/par-031-graph-provider.mjs", import.meta.url));
const roles: Role[] = ["seed", "b", "a"];
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;
const testCeilingMs = 35_000;

test("PAR-040 isolates declaration-ordered pending graph questions and partial-answer evidence", async () => {
  await exerciseNodeQuestionInspection("pending");
}, testCeilingMs);

test("PAR-040 rejects artifact, result, validation, and raw-response acceptance evidence faults", async () => {
  await exerciseNodeQuestionInspection("artifacts-evidence");
}, testCeilingMs);

test("PAR-040 rejects invocation, completion, acceptance, ordering, and foreign-routing evidence faults", async () => {
  await exerciseNodeQuestionInspection("events-routing");
}, testCeilingMs);

test("PAR-040 exposes a caller-input pause before graph admission", async () => {
  await exerciseCallerQuestionInspection();
}, testCeilingMs);

async function exerciseNodeQuestionInspection(mode: "pending" | "artifacts-evidence" | "events-routing"): Promise<void> {
  const deadline = Date.now() + scenarioBudgetMs;
  const label = "par-040 graph-pause-café";
  const project = createInitializedProject(label);
  const identity = realpathSync.native(project);
  const configured = configureNodeQuestionProject(project);
  const activity = createActivity();
  const observer = observeOwnedNativeProcesses();
  const readStorage = observeReadStorage();
  const publicOperations: Promise<void>[] = [];
  let observedInitial: Outcome | undefined;
  let runId: string | undefined;
  let hasPrimaryError = false;
  let primaryError: unknown;

  try {
    assertOwnedProject(project, identity, label);
    const provider = observeProvider(project, activity);
    const initial = capturePublic(runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Resolve two independent branch questions while retaining the accepted seed." }],
    }, provider), publicOperations);
    void initial.then((outcome) => { observedInitial = outcome; });

    const [seedMarker, bMarker, aMarker] = await withDeadline(Promise.all([
      waitForMarker(project, "seed", 1, deadline, () => observedInitial),
      waitForMarker(project, "b", 1, deadline, () => observedInitial),
      waitForMarker(project, "a", 1, deadline, () => observedInitial),
    ]), deadline, "seed and branch provider markers");
    runId = seedMarker.runId;
    expect(aMarker.runId).toBe(runId);
    expect(bMarker.runId).toBe(runId);
    expect(isSafePid(seedMarker.pid) && isSafePid(aMarker.pid) && isSafePid(bMarker.pid)).toBe(true);
    await waitForAcceptedSeed(project, runId, seedMarker, configured.validatorLog, deadline, () => observedInitial);

    expect(observedInitial).toBeUndefined();
    const activeCheckpointBytes = readRunFile(project, runId, "run.json");
    const activeEventBytes = readRunFile(project, runId, "events.jsonl");
    const activeCheckpoint = readCheckpoint(project, runId);
    const activeEvents = readEvents(project, runId);
    const activeGraph = record(activeCheckpoint.graph);
    const activeNodes = record(activeGraph.nodes);
    expect(activeCheckpoint.status).toBe("running");
    expect(activeGraph).toMatchObject({ admissionClosed: false });
    expect(activeCheckpoint.completedNodes).toEqual(["seed"]);
    expect(activeNodes.seed).toMatchObject({ phase: "accepted", callId: seedMarker.callId, attempt: 1 });
    expect(activeNodes.b).toMatchObject({ phase: "active", callId: bMarker.callId, attempt: 1 });
    expect(activeNodes.a).toMatchObject({ phase: "active", callId: aMarker.callId, attempt: 1 });
    assertCallEvidence(project, runId, seedMarker);
    assertFixtureCallTrace(configured.eventsPath, seedMarker);
    const activeValidatorRecords = readValidatorLog(configured.validatorLog);
    expect(activeValidatorRecords).toHaveLength(1);
    const activeValidatorPid = activeValidatorRecords[0]?.pid;
    expect(isSafePid(activeValidatorPid) && isProcessRecord(observer, activeValidatorPid, "spawn") && isProcessRecord(observer, activeValidatorPid, "close")).toBe(true);
    assertActiveBranchCalls(project, runId, activeEvents, [aMarker, bMarker]);
    const seedArtifactsWhileBranchesActive = assertAcceptedNodeArtifacts(project, runId, activeCheckpoint, "seed");
    const activeReadBaseline = observeReadState(project, runId, configured, activity, observer, readStorage);
    const activeStatusRead = await attemptStatus(project, runId, readStorage.storage, publicOperations, deadline);
    if (activeStatusRead.kind !== "result") throw new Error(`PAR-040 active graph status read rejected (${errorDescription(activeStatusRead.error)}).`, { cause: activeStatusRead.error });
    expect(activeStatusRead.value).toMatchObject({ runId, status: "running", pendingRequests: [] });
    expect(activeStatusRead.value).not.toHaveProperty("pendingRequest");
    expect(activeStatusRead.value.checkpoint).toEqual(activeCheckpoint);
    expect(activeStatusRead.value.events).toEqual(activeEvents);
    const activeCallEvidence = Array.isArray(activeStatusRead.value.callEvidence) ? activeStatusRead.value.callEvidence.map(record) : [];
    for (const marker of [aMarker, bMarker]) {
      expect(activeCallEvidence.find((entry) => entry.callId === marker.callId && entry.nodeId === marker.nodeId)).toMatchObject({
        callId: marker.callId,
        nodeId: marker.nodeId,
        status: "incomplete",
        requestAvailable: true,
        transportAvailable: false,
      });
    }
    const activeInspection = await readInspection(project, runId, readStorage.storage, publicOperations, deadline);
    expect(activeInspection.status).toBe("running");
    expect(activeInspection.checkpoint).toEqual(activeCheckpoint);
    expect(activeInspection.timeline).toEqual(activeEvents);
    expect(activeInspection.artifacts).toEqual(seedArtifactsWhileBranchesActive);
    expect(activeInspection.pendingRequests).toEqual([]);
    expect(activeInspection).not.toHaveProperty("pendingRequest");
    expect(Array.isArray(activeInspection.nextActions) ? activeInspection.nextActions : []).not.toContain("provide_pending_input");
    expect(activeInspection.nextActions).toContain("do_not_replay_uncertain_call");
    assertReadStateUnchanged(project, runId, configured, activity, observer, readStorage, activeReadBaseline);
    expect(readRunFile(project, runId, "run.json").equals(activeCheckpointBytes)).toBe(true);
    expect(readRunFile(project, runId, "events.jsonl").equals(activeEventBytes)).toBe(true);

    writeFileSync(configured.releasePaths.a, "release\n", { encoding: "utf8", flag: "wx" });
    const aRequest = await waitForQuestion(project, runId, aMarker, deadline, () => observedInitial);
    writeFileSync(configured.releasePaths.b, "release\n", { encoding: "utf8", flag: "wx" });
    const initialOutcome = await awaitOutcome(initial, deadline, "two-question graph pause", () => observedInitial);
    const paused = requireResult(initialOutcome, "initial graph pause");
    expect(paused.runId).toBe(runId);
    expect(paused.status).toBe("needs_input");
    const bRequest = await waitForQuestion(project, runId, bMarker, deadline, () => observedInitial);
    expect(requestCompletionOrder(configured.eventsPath)).toEqual(["a", "b"]);
    expect([bRequest.nodeId, aRequest.nodeId]).toEqual(["b", "a"]);

    assertNodeRequest(project, runId, bRequest, "b");
    assertNodeRequest(project, runId, aRequest, "a");
    for (const marker of [seedMarker, aMarker, bMarker]) {
      assertCallEvidence(project, runId, marker);
      assertFixtureCallTrace(configured.eventsPath, marker);
    }
    const initialCheckpointBytes = readRunFile(project, runId, "run.json");
    const initialEventBytes = readRunFile(project, runId, "events.jsonl");
    const initialCheckpoint = readCheckpoint(project, runId);
    const initialEvents = readEvents(project, runId);
    expect(initialCheckpoint.schemaVersion).toBe(2);
    expect(initialCheckpoint.status).toBe("needs_input");
    assertNodeState(initialCheckpoint, "seed", seedMarker, "accepted");
    assertNodeState(initialCheckpoint, "b", bMarker, "pending");
    assertNodeState(initialCheckpoint, "a", aMarker, "pending");
    assertContiguousSequences(initialEvents);
    expect(activity.invocations.map(({ nodeId }) => nodeId).sort(compareText)).toEqual(["a", "b", "seed"]);
    expect(activity.invocations).toHaveLength(3);
    const validatorRecords = readValidatorLog(configured.validatorLog);
    expect(validatorRecords).toHaveLength(1);
    expect(validatorRecords[0]).toMatchObject({ nodeId: "seed", pid: expect.any(Number) });
    expect(readObject(runFile(project, runId, "nodes/seed/attempt-001/validation.json"))).toMatchObject({
      valid: true,
      outcome: "success",
      validators: [{ name: "report", valid: true, errors: [] }],
    });
    const validatorPid = validatorRecords[0]?.pid;
    expect(isSafePid(validatorPid) && isProcessRecord(observer, validatorPid, "spawn") && isProcessRecord(observer, validatorPid, "close")).toBe(true);
    const initialNativeChildren = observer.diagnostics;
    expect(observer.observationFailure).toBe(false);
    expect(initialNativeChildren.length).toBeGreaterThan(0);
    expect(initialNativeChildren.every((record) => record.stages.includes("spawn") && record.stages.includes("close"))).toBe(true);

    const initialReadBaseline = observeReadState(project, runId, configured, activity, observer, readStorage);
    const initialStatusRead = await attemptStatus(project, runId, readStorage.storage, publicOperations, deadline);
    const initialInspection = await readInspection(project, runId, readStorage.storage, publicOperations, deadline);
    expectStatusRead(initialStatusRead, runId, initialCheckpoint, initialEvents, [bRequest, aRequest]);
    expectInspection(initialInspection, runId, initialCheckpoint, initialEvents, [bRequest, aRequest], true);
    assertReadStateUnchanged(project, runId, configured, activity, observer, readStorage, initialReadBaseline);
    expect(readRunFile(project, runId, "run.json").equals(initialCheckpointBytes)).toBe(true);
    expect(readRunFile(project, runId, "events.jsonl").equals(initialEventBytes)).toBe(true);

    const incompleteMarker = aMarker;
    const incompleteTransportRelative = `calls/${incompleteMarker.callId}/transport.json`;
    const incompleteTransportPath = runFile(project, runId, incompleteTransportRelative);
    const savedTransportBytes = readRunFile(project, runId, incompleteTransportRelative);
    const completeTransportTree = snapshotTree(runDirectory(project, runId));
    rmSync(incompleteTransportPath);
    const incompleteTransportTree = snapshotTree(runDirectory(project, runId));
    expectOnlyRelativeFileChanged(completeTransportTree, incompleteTransportTree, incompleteTransportRelative);

    const incompleteReadBaseline = observeReadState(project, runId, configured, activity, observer, readStorage);
    const incompleteStatusRead = await attemptStatus(project, runId, readStorage.storage, publicOperations, deadline);
    const incompleteInspection = await readInspection(project, runId, readStorage.storage, publicOperations, deadline);
    expectStatusRead(incompleteStatusRead, runId, initialCheckpoint, initialEvents, [bRequest, aRequest]);
    expectInspection(incompleteInspection, runId, initialCheckpoint, initialEvents, [bRequest, aRequest], false);
    expect(incompleteInspection.nextActions).toEqual(["inspect_attempts", "do_not_replay_uncertain_call"]);
    assertReadStateUnchanged(project, runId, configured, activity, observer, readStorage, incompleteReadBaseline);
    expect(snapshotTree(runDirectory(project, runId))).toEqual(incompleteTransportTree);

    writeFileSync(incompleteTransportPath, savedTransportBytes, { flag: "wx" });
    expect(snapshotTree(runDirectory(project, runId))).toEqual(completeTransportTree);

    const inputBytes = readRunFile(project, runId, "inputs.json");
    const activityBeforePartial = activitySnapshot(activity);
    const delegatedBeforePartial = activity.delegated.length;
    const nativeBeforePartial = JSON.stringify(observer.diagnostics);
    const fixtureBeforePartial = snapshotTree(configured.stateDirectory);
    const validatorBeforePartial = existsSync(configured.validatorLog) ? readFileSync(configured.validatorLog) : null;
    const aAnswer = { aApproval: "A-approved" };
    const partial = capturePublic(resumeWorkflow({ projectRoot: project, runId, requestId: aRequest.id, answers: aAnswer }, observeProvider(project, activity)), publicOperations);
    const partialOutcome = await withDeadline(partial, deadline, "partial A answer");
    const partialResult = requireResult(partialOutcome, "partial A answer");
    expect(partialResult.status).toBe("needs_input");
    expect(activitySnapshot(activity)).toEqual(activityBeforePartial);
    expect(activity.delegated.length).toBe(delegatedBeforePartial);
    expect(JSON.stringify(observer.diagnostics)).toBe(nativeBeforePartial);
    expect(snapshotTree(configured.stateDirectory)).toEqual(fixtureBeforePartial);
    expect(existsSync(configured.validatorLog) ? readFileSync(configured.validatorLog) : null).toEqual(validatorBeforePartial);
    expect(readRunFile(project, runId, "inputs.json").equals(inputBytes)).toBe(true);
    assertAnswerCommit(project, runId, aRequest, aAnswer);
    const partiallyAnsweredCheckpoint = readCheckpoint(project, runId);
    const partialPending = record(record(partiallyAnsweredCheckpoint.graph).pendingRequests);
    expect(partialPending[aRequest.id]).toMatchObject({ kind: "node", nodeId: "a", answerRef: `answers/${aRequest.id}.json`, answerSha256: digest(readRunFile(project, runId, `answers/${aRequest.id}.json`)) });
    expect(partialPending[bRequest.id]).toMatchObject({ kind: "node", nodeId: "b" });
    const partialEvents = readEvents(project, runId);
    assertContiguousSequences(partialEvents);
    const partialBaseline = observeReadState(project, runId, configured, activity, observer, readStorage);
    const partialStatusRead = await attemptStatus(project, runId, readStorage.storage, publicOperations, deadline);
    const partialInspection = await readInspection(project, runId, readStorage.storage, publicOperations, deadline);
    expectStatusRead(partialStatusRead, runId, partiallyAnsweredCheckpoint, partialEvents, [bRequest]);
    expectInspection(partialInspection, runId, partiallyAnsweredCheckpoint, partialEvents, [bRequest], true);
    expect(partialStatusRead.kind).toBe("result");
    if (partialStatusRead.kind === "result") {
      const history = record(record(partialStatusRead.value.checkpoint).graph).pendingRequests;
      expect(Object.keys(record(history)).sort(compareText)).toEqual([aRequest.id, bRequest.id].sort(compareText));
      expect(record(history)[aRequest.id]).toMatchObject({ answerRef: `answers/${aRequest.id}.json`, answerSha256: digest(readRunFile(project, runId, `answers/${aRequest.id}.json`)) });
    }
    assertReadStateUnchanged(project, runId, configured, activity, observer, readStorage, partialBaseline);

    if (mode === "pending") {
      const cleanCheckpointBytes = readRunFile(project, runId, "run.json");
      const cleanBBytes = readRunFile(project, runId, `pending/${bRequest.id}.json`);
      const cleanRunSnapshot = snapshotTree(runDirectory(project, runId));
      const bPendingPath = path.join(runDirectory(project, runId), `pending/${bRequest.id}.json`);
      const changedBRequest = readObject(bPendingPath);
      const changedQuestions = Array.isArray(changedBRequest.questions) ? [...changedBRequest.questions] : [];
      const firstQuestion = record(changedQuestions[0]);
      if (typeof firstQuestion.message !== "string") throw new Error("PAR-040 B pending request has no first question message to corrupt.");
      changedQuestions[0] = { ...firstQuestion, message: `${firstQuestion.message} tampered` };
      writeFileSync(bPendingPath, `${JSON.stringify({ ...changedBRequest, questions: changedQuestions })}\n`, "utf8");
      const bFaultSnapshot = snapshotTree(runDirectory(project, runId));
      expectOnlyRelativeFileChanged(cleanRunSnapshot, bFaultSnapshot, `pending/${bRequest.id}.json`);
      await expectCorruptRead(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, "B pending request bytes without updating the checkpoint hash");
      writeFileSync(bPendingPath, cleanBBytes);
      expect(snapshotTree(runDirectory(project, runId))).toEqual(cleanRunSnapshot);
      expect(readRunFile(project, runId, "run.json").equals(cleanCheckpointBytes)).toBe(true);

      const answerMeta = record(partialPending[aRequest.id]);
      const answerHashCheckpoint = readObject(path.join(runDirectory(project, runId), "run.json"));
      const graph = record(answerHashCheckpoint.graph);
      const pending = record(graph.pendingRequests);
      const answerEntry = record(pending[aRequest.id]);
      if (typeof answerEntry.answerSha256 !== "string") throw new Error("PAR-040 partial A answer metadata has no hash to test.");
      delete answerEntry.answerSha256;
      writeFileSync(path.join(runDirectory(project, runId), "run.json"), `${JSON.stringify(answerHashCheckpoint)}\n`, "utf8");
      const hashFaultSnapshot = snapshotTree(runDirectory(project, runId));
      expectOnlyRelativeFileChanged(cleanRunSnapshot, hashFaultSnapshot, "run.json");
      await expectCorruptRead(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, "A answer hash removed while its answer reference remains");
      writeFileSync(path.join(runDirectory(project, runId), "run.json"), cleanCheckpointBytes);
      expect(snapshotTree(runDirectory(project, runId))).toEqual(cleanRunSnapshot);

      const answerRefCheckpointBytes = readRunFile(project, runId, "run.json");
      const answerRefCheckpoint = readObject(path.join(runDirectory(project, runId), "run.json"));
      const answerRefGraph = record(answerRefCheckpoint.graph);
      const answerRefPending = record(answerRefGraph.pendingRequests);
      const answerRefEntry = record(answerRefPending[aRequest.id]);
      if (typeof answerRefEntry.answerRef !== "string") throw new Error("PAR-040 partial A answer metadata has no reference to test.");
      delete answerRefEntry.answerRef;
      writeFileSync(path.join(runDirectory(project, runId), "run.json"), `${JSON.stringify(answerRefCheckpoint)}\n`, "utf8");
      const refFaultSnapshot = snapshotTree(runDirectory(project, runId));
      expectOnlyRelativeFileChanged(cleanRunSnapshot, refFaultSnapshot, "run.json");
      await expectCorruptRead(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, "A answer reference removed while its answer hash remains");
      writeFileSync(path.join(runDirectory(project, runId), "run.json"), answerRefCheckpointBytes);
      expect(snapshotTree(runDirectory(project, runId))).toEqual(cleanRunSnapshot);
      expect(hashFaultSnapshot).not.toEqual(cleanRunSnapshot);
      expect(refFaultSnapshot).not.toEqual(cleanRunSnapshot);
      expect(readRunFile(project, runId, `pending/${bRequest.id}.json`).equals(cleanBBytes)).toBe(true);
      expect(record(answerMeta).answerRef).toBe(`answers/${aRequest.id}.json`);
    }

    if (mode !== "pending") {
      const bAnswer = { bApproval: "B-approved" };
      const finalResume = capturePublic(resumeWorkflow({ projectRoot: project, runId, requestId: bRequest.id, answers: bAnswer }, observeProvider(project, activity)), publicOperations);
      const finalOutcome = await awaitOutcome(finalResume, deadline, "final B answer and graph completion", () => observedInitial);
      const finalResult = requireResult(finalOutcome, "final B answer");
      expect(finalResult.status).toBe("success");
      const finalCheckpoint = readCheckpoint(project, runId);
      expect(finalCheckpoint.status).toBe("success");
      expect(readRunFile(project, runId, "inputs.json").equals(inputBytes)).toBe(true);
      expect(finalCheckpoint.completedNodes).toEqual(roles);
      const finalGraphNodes = record(record(finalCheckpoint.graph).nodes);
      for (const nodeId of roles) expect(record(finalGraphNodes[nodeId])).toMatchObject({ phase: "accepted" });
      const capturedWorkflow = readParallelWorkflow(project);
      expect(capturedWorkflow.nodes).toEqual(roles);
      expect(capturedWorkflow.outputs.map(({ name, from }) => [name, from])).toEqual([ ["bFinal", "b.report"], ["aFinal", "a.report"] ]);
      const expectedFinalArtifacts = roles.flatMap((nodeId) => assertAcceptedNodeArtifacts(project, finalResult.runId, finalCheckpoint, nodeId));
      expect(expectedFinalArtifacts.map((artifact) => artifact.nodeId)).toEqual(["seed", "b", "a"]);
      const finalEvents = readEvents(project, runId);
      assertContiguousSequences(finalEvents);
      expect(activity.invocations.map(({ nodeId, attempt }) => `${nodeId}:${attempt}`).sort(compareText)).toEqual(["a:1", "a:2", "b:1", "b:2", "seed:1"]);
      expect(activity.invocations.filter(({ nodeId }) => nodeId === "seed")).toHaveLength(1);
      expect(readFixtureEvents(configured.eventsPath).filter((event) => event.stage === "inference-started")).toHaveLength(5);
      expect(readFixtureEvents(configured.eventsPath).filter((event) => event.stage === "inference-completed")).toHaveLength(5);
      expect(readValidatorLog(configured.validatorLog)).toHaveLength(1);
      expect(observer.observationFailure).toBe(false);
      expect(observer.diagnostics.length).toBeGreaterThan(0);
      expect(observer.diagnostics.every((entry) => entry.stages.includes("spawn") && entry.stages.includes("close"))).toBe(true);

      const finalReadBaseline = observeReadState(project, runId, configured, activity, observer, readStorage);
      const finalStatusRead = await attemptStatus(project, runId, readStorage.storage, publicOperations, deadline);
      if (finalStatusRead.kind !== "result") throw new Error(`PAR-040 successful graph status read rejected (${errorDescription(finalStatusRead.error)}).`, { cause: finalStatusRead.error });
      expect(finalStatusRead.value).toMatchObject({ runId, status: "success", pendingRequests: [] });
      expect(finalStatusRead.value).not.toHaveProperty("pendingRequest");
      expect(finalStatusRead.value.checkpoint).toEqual(finalCheckpoint);
      const finalInspection = await readInspection(project, runId, readStorage.storage, publicOperations, deadline);
      expect(finalInspection.status).toBe("success");
      expect(finalInspection.checkpoint).toEqual(finalCheckpoint);
      expect(finalInspection.timeline).toEqual(finalEvents);
      expect(finalInspection.artifacts).toEqual(expectedFinalArtifacts);
      expect(finalInspection.pendingRequests).toEqual([]);
      expect(finalInspection).not.toHaveProperty("pendingRequest");
      expect(finalInspection.nextActions).toEqual([]);
      assertReadStateUnchanged(project, runId, configured, activity, observer, readStorage, finalReadBaseline);

      const successfulRunTree = snapshotTree(runDirectory(project, runId));
      const successfulCheckpointBytes = readRunFile(project, runId, "run.json");
      const validArtifactsWithoutA = expectedFinalArtifacts.filter((artifact) => artifact.nodeId !== "a");
      const aNodeState = record(finalGraphNodes.a);
      const aAccepted = record(aNodeState.accepted);
      const aAttemptRoot = `nodes/a/attempt-${String(aAccepted.attempt).padStart(3, "0")}`;
      const aCallId = aAccepted.callId;
      if (typeof aCallId !== "string" || typeof aAccepted.resultRef !== "string" || typeof aAccepted.validationRef !== "string" || typeof aAccepted.responseRef !== "string") {
        throw new Error("PAR-040 final A acceptance manifest is missing canonical evidence references.");
      }
      const aArtifact = record(record(finalGraphNodes.a).accepted);
      const aArtifactManifest = Array.isArray(aArtifact.artifacts) ? aArtifact.artifacts.map(record).find((entry) => entry.name === "report") : undefined;
      if (!aArtifactManifest || typeof aArtifactManifest.ref !== "string") throw new Error("PAR-040 final A accepted artifact reference is missing.");

      if (mode === "artifacts-evidence") {
        const artifactRelative = aArtifactManifest.ref;
        const artifactOriginal = readRunFile(project, runId, artifactRelative);
        const artifactValue = record(JSON.parse(artifactOriginal.toString("utf8")) as unknown);
        const artifactData = record(artifactValue.data);
        if (typeof artifactData.text !== "string") throw new Error("PAR-040 accepted A artifact has no text value to corrupt.");
        writeRunJson(project, runId, artifactRelative, { ...artifactValue, data: { ...artifactData, text: `${artifactData.text} corrupted` } });
        await expectAcceptedArtifactFault(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, successfulRunTree, validArtifactsWithoutA, [artifactRelative], "A artifact bytes do not match the accepted hash");
        writeFileSync(runFile(project, runId, artifactRelative), artifactOriginal);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(successfulRunTree);

        const resultOriginal = readRunFile(project, runId, aAccepted.resultRef as string);
        const changedResult = { ...readObject(runFile(project, runId, aAccepted.resultRef as string)), status: "needs_input" };
        const changedResultBytes = writeRunJson(project, runId, aAccepted.resultRef as string, changedResult);
        const resultHashCheckpoint = readCheckpoint(project, runId);
        record(record(record(resultHashCheckpoint.graph).nodes).a).accepted = {
          ...record(record(record(resultHashCheckpoint.graph).nodes).a).accepted as RecordValue,
          resultSha256: digest(changedResultBytes),
        };
        writeRunJson(project, runId, "run.json", resultHashCheckpoint);
        await expectAcceptedArtifactFault(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, successfulRunTree, validArtifactsWithoutA, [aAccepted.resultRef as string, "run.json"], "A result contradicts its accepted response with its hash updated");
        writeFileSync(runFile(project, runId, aAccepted.resultRef as string), resultOriginal);
        writeFileSync(runFile(project, runId, "run.json"), successfulCheckpointBytes);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(successfulRunTree);

        const validationOriginal = readRunFile(project, runId, aAccepted.validationRef as string);
        const changedValidation = { ...readObject(runFile(project, runId, aAccepted.validationRef as string)), valid: false, outcome: "error", errors: ["controlled validation rejection"] };
        const changedValidationBytes = writeRunJson(project, runId, aAccepted.validationRef as string, changedValidation);
        const validationHashCheckpoint = readCheckpoint(project, runId);
        const validationNode = record(record(record(validationHashCheckpoint.graph).nodes).a);
        validationNode.accepted = { ...record(validationNode.accepted), validationSha256: digest(changedValidationBytes) };
        writeRunJson(project, runId, "run.json", validationHashCheckpoint);
        await expectAcceptedArtifactFault(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, successfulRunTree, validArtifactsWithoutA, [aAccepted.validationRef as string, "run.json"], "A validation rejects with its accepted hash updated");
        writeFileSync(runFile(project, runId, aAccepted.validationRef as string), validationOriginal);
        writeFileSync(runFile(project, runId, "run.json"), successfulCheckpointBytes);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(successfulRunTree);

        const responseOriginal = readRunFile(project, runId, aAccepted.responseRef as string);
        const changedResponse = record(JSON.parse(responseOriginal.toString("utf8")) as unknown);
        const responseArtifacts = Array.isArray(changedResponse.artifacts) ? changedResponse.artifacts.map(record) : [];
        if (responseArtifacts.length === 0) throw new Error("PAR-040 A raw provider response has no artifacts to contradict.");
        const firstResponseArtifact = record(responseArtifacts[0]);
        responseArtifacts[0] = { ...firstResponseArtifact, data: { ...record(firstResponseArtifact.data), text: "different raw response" } };
        const changedResponseBytes = writeRunJson(project, runId, aAccepted.responseRef as string, { ...changedResponse, artifacts: responseArtifacts });
        const responseHashCheckpoint = readCheckpoint(project, runId);
        const responseNode = record(record(record(responseHashCheckpoint.graph).nodes).a);
        responseNode.accepted = { ...record(responseNode.accepted), responseSha256: digest(changedResponseBytes) };
        writeRunJson(project, runId, "run.json", responseHashCheckpoint);
        await expectAcceptedArtifactFault(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, successfulRunTree, validArtifactsWithoutA, [aAccepted.responseRef as string, "run.json"], "A raw response differs from its result with its hash updated");
        writeFileSync(runFile(project, runId, aAccepted.responseRef as string), responseOriginal);
        writeFileSync(runFile(project, runId, "run.json"), successfulCheckpointBytes);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(successfulRunTree);
      }

      if (mode === "events-routing") {
        const invocationRelative = `${aAttemptRoot}/invocation.json`;
        const invocationOriginal = readRunFile(project, runId, invocationRelative);
        const changedInvocation = { ...readObject(runFile(project, runId, invocationRelative)), nodeId: "b" };
        writeRunJson(project, runId, invocationRelative, changedInvocation);
        await expectAcceptedArtifactFault(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, successfulRunTree, validArtifactsWithoutA, [invocationRelative], "A generic invocation identity differs from its accepted call");
        writeFileSync(runFile(project, runId, invocationRelative), invocationOriginal);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(successfulRunTree);

        const eventBytesBeforeCompletionFault = readRunFile(project, runId, "events.jsonl");
        const completionFaultEvents = readEvents(project, runId);
        const completionFaultIndices = completionFaultEvents.flatMap((event, index) => event.event === "provider.call.completed" && event.nodeId === "a" && event.callId === aCallId ? [index] : []);
        if (completionFaultIndices.length !== 1) throw new Error("PAR-040 A provider completion is missing or duplicated before its isolated fault.");
        const completionFaultEvent = completionFaultEvents[completionFaultIndices[0]!]!;
        completionFaultEvents[completionFaultIndices[0]!] = { ...completionFaultEvent, callId: "f0000000-0000-4000-8000-000000000001" };
        writeRunEvents(project, runId, completionFaultEvents);
        await expectAcceptedArtifactFault(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, successfulRunTree, validArtifactsWithoutA, ["events.jsonl"], "A accepted call has no matching completion event");
        writeFileSync(runFile(project, runId, "events.jsonl"), eventBytesBeforeCompletionFault);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(successfulRunTree);

        const eventBytesBeforeAcceptanceFault = readRunFile(project, runId, "events.jsonl");
        const acceptanceFaultEvents = readEvents(project, runId);
        const acceptanceFaultIndices = acceptanceFaultEvents.flatMap((event, index) => event.event === "node.accepted" && event.nodeId === "a" && event.callId === aCallId ? [index] : []);
        if (acceptanceFaultIndices.length !== 1) throw new Error("PAR-040 A node acceptance event is missing or duplicated before its isolated fault.");
        acceptanceFaultEvents[acceptanceFaultIndices[0]!] = { ...acceptanceFaultEvents[acceptanceFaultIndices[0]!]!, event: "node.accepted.unknown" };
        writeRunEvents(project, runId, acceptanceFaultEvents);
        await expectAcceptedArtifactFault(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, successfulRunTree, validArtifactsWithoutA, ["events.jsonl"], "A accepted manifest has no matching node.accepted event");
        writeFileSync(runFile(project, runId, "events.jsonl"), eventBytesBeforeAcceptanceFault);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(successfulRunTree);

        const eventBytesBeforeOrderingFault = readRunFile(project, runId, "events.jsonl");
        const orderingFaultEvents = readEvents(project, runId);
        const completionIndex = orderingFaultEvents.findIndex((event) => event.event === "provider.call.completed" && event.nodeId === "a" && event.callId === aCallId);
        const acceptedIndex = orderingFaultEvents.findIndex((event) => event.event === "node.accepted" && event.nodeId === "a" && event.callId === aCallId);
        if (completionIndex < 0 || acceptedIndex < 0 || completionIndex >= acceptedIndex) throw new Error("PAR-040 A completion and acceptance chronology is invalid before its isolated fault.");
        const completionEvent = { ...orderingFaultEvents[completionIndex]! };
        const acceptedEvent = { ...orderingFaultEvents[acceptedIndex]! };
        const completionSequence = completionEvent.sequence;
        const acceptedSequence = acceptedEvent.sequence;
        orderingFaultEvents[completionIndex] = { ...acceptedEvent, sequence: completionSequence };
        orderingFaultEvents[acceptedIndex] = { ...completionEvent, sequence: acceptedSequence };
        assertContiguousSequences(orderingFaultEvents);
        writeRunEvents(project, runId, orderingFaultEvents);
        await expectAcceptedArtifactFault(project, runId, configured, activity, observer, readStorage, publicOperations, deadline, successfulRunTree, validArtifactsWithoutA, ["events.jsonl"], "A acceptance is ordered before its call completion");
        writeFileSync(runFile(project, runId, "events.jsonl"), eventBytesBeforeOrderingFault);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(successfulRunTree);

        const routingFaultCheckpointBytes = readRunFile(project, runId, "run.json");
        const routingFaultEventBytes = readRunFile(project, runId, "events.jsonl");
        const routingFaultCheckpoint = readCheckpoint(project, runId);
        const routingFaultGraph = record(routingFaultCheckpoint.graph);
        const routingFaultSequence = routingFaultGraph.nextEventSequence;
        if (!Number.isSafeInteger(routingFaultSequence)) throw new Error("PAR-040 successful graph has no valid next event sequence for its isolated routing fault.");
        const routingFaultEvent = {
          event: "feedback.generation.created",
          runId,
          sequence: routingFaultSequence,
          timestamp: new Date().toISOString(),
        };
        const routingFaultEvents = [...readEvents(project, runId), routingFaultEvent];
        const changedRoutingCheckpoint = { ...routingFaultCheckpoint, graph: { ...routingFaultGraph, nextEventSequence: Number(routingFaultSequence) + 1 } };
        writeRunEvents(project, runId, routingFaultEvents);
        writeRunJson(project, runId, "run.json", changedRoutingCheckpoint);
        const routingFaultTree = snapshotTree(runDirectory(project, runId));
        expectOnlyRelativeFilesChanged(successfulRunTree, routingFaultTree, ["run.json", "events.jsonl"]);
        const routingReadBaseline = observeReadState(project, runId, configured, activity, observer, readStorage);
        const routingStatus = await attemptStatus(project, runId, readStorage.storage, publicOperations, deadline);
        if (routingStatus.kind !== "result") throw new Error(`PAR-040 contradictory routing event status read rejected (${errorDescription(routingStatus.error)}).`, { cause: routingStatus.error });
        expect(routingStatus.value).toMatchObject({ runId, status: "success", pendingRequests: [] });
        expect(routingStatus.value.checkpoint).toEqual(changedRoutingCheckpoint);
        expect(routingStatus.value.events).toEqual(routingFaultEvents);
        const routingInspection = await readInspection(project, runId, readStorage.storage, publicOperations, deadline);
        expect(routingInspection.status).toBe("success");
        expect(routingInspection.checkpoint).toEqual(changedRoutingCheckpoint);
        expect(routingInspection.timeline).toEqual(routingFaultEvents);
        expect(routingInspection.artifacts).toEqual([]);
        const routingDiagnostics = record(routingInspection.diagnostics).messages;
        expect(Array.isArray(routingDiagnostics) && routingDiagnostics.some((message) =>
          typeof message === "string" && message.includes("Captured feedback-routing definition is missing or invalid"))).toBe(true);
        assertReadStateUnchanged(project, runId, configured, activity, observer, readStorage, routingReadBaseline);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(routingFaultTree);
        writeFileSync(runFile(project, runId, "events.jsonl"), routingFaultEventBytes);
        writeFileSync(runFile(project, runId, "run.json"), routingFaultCheckpointBytes);
        expect(snapshotTree(runDirectory(project, runId))).toEqual(successfulRunTree);
      }
    }
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  const cleanupErrors = await cleanup(project, identity, label, configured, activity, observer, publicOperations, hasPrimaryError);
  if (cleanupErrors.length > 0) {
    primaryError = hasPrimaryError ? new AggregateError([primaryError, ...cleanupErrors], "PAR-040 primary assertion and cleanup both failed.")
      : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "PAR-040 cleanup failed.");
    hasPrimaryError = true;
  }
  if (hasPrimaryError) throw primaryError;
}

async function exerciseCallerQuestionInspection(): Promise<void> {
  const deadline = Date.now() + scenarioBudgetMs;
  const label = "par-040 caller-pause-café";
  const project = createInitializedProject(label);
  const identity = realpathSync.native(project);
  const configured = configureCallerProject(project);
  const activity = createActivity();
  const observer = observeOwnedNativeProcesses();
  const readStorage = observeReadStorage();
  const publicOperations: Promise<void>[] = [];
  let hasPrimaryError = false;
  let primaryError: unknown;
  let runId: string | undefined;

  try {
    assertOwnedProject(project, identity, label);
    const initial = capturePublic(runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Create the requested report." }],
    }, observeProvider(project, activity)), publicOperations);
    const outcome = await withDeadline(initial, deadline, "caller-input pause");
    const paused = requireResult(outcome, "missing required caller input");
    expect(paused.status).toBe("needs_input");
    runId = paused.runId;
    const result = record(paused.result);
    const request = record(result.request);
    expect(request).toMatchObject({ kind: "caller_inputs", nodeId: null, attempt: 0 });
    expect(typeof request.id).toBe("string");
    if (!isUuid(request.id)) throw new Error("PAR-040 caller input request ID is not a UUID.");
    expect(request).toMatchObject({
      questions: [{ id: expect.any(String), message: expect.any(String) }],
      answerContract: { type: "object", required: ["goal"], additionalProperties: false, properties: { goal: { $ref: "#/$defs/goal.v1" } } },
    });
    const checkpoint = readCheckpoint(project, runId);
    const pending = record(record(checkpoint.graph).pendingRequests);
    expect(Object.keys(pending)).toEqual([request.id]);
    expect(pending[request.id]).toMatchObject({ kind: "caller_inputs", nodeId: null, attempt: 0, requestRef: `pending/${request.id}.json` });
    const pendingBytes = readRunFile(project, runId, `pending/${request.id}.json`);
    expect(record(pending[request.id]).requestSha256).toBe(digest(pendingBytes));
    expect(JSON.parse(pendingBytes.toString("utf8")) as unknown).toEqual(request);
    expect(checkpoint.completedNodes).toEqual([]);
    expect(record(record(checkpoint.graph).nodes).root).toMatchObject({ phase: "not_started", attempt: 0 });
    const events = readEvents(project, runId);
    expect(events.filter((event) => event.event === "run.intake.completed")).toHaveLength(1);
    expect(events.filter((event) => event.event === "run.needs_input" && Array.isArray(event.requestIds) && event.requestIds.includes(request.id))).toHaveLength(1);
    expect(events.some((event) => typeof event.event === "string" && /^(?:node\.|provider\.call\.)/.test(event.event))).toBe(false);
    assertContiguousSequences(events);
    const baseline = observeReadState(project, runId, configured, activity, observer, readStorage);
    const statusRead = await attemptStatus(project, runId, readStorage.storage, publicOperations, deadline);
    const inspection = await readInspection(project, runId, readStorage.storage, publicOperations, deadline);
    expectStatusRead(statusRead, runId, checkpoint, events, [request]);
    expectInspection(inspection, runId, checkpoint, events, [request], true);
    expect(statusRead.kind).toBe("result");
    if (statusRead.kind === "result") expect(statusRead.value.pendingRequest).toEqual(request);
    expect(inspection.nextActions).toContain("provide_pending_input");
    expect(statusRead.kind).toBe("result");
    assertReadStateUnchanged(project, runId, configured, activity, observer, readStorage, baseline);
    expect(activitySnapshot(activity)).toEqual(activitySnapshot(createActivity()));
    expect(configured.providerSentinelExists()).toBe(false);
    expect(readValidatorLog(configured.validatorLog)).toEqual([]);
    expect(observer.diagnostics).toEqual([]);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  const cleanupErrors = await cleanup(project, identity, label, configured, activity, observer, publicOperations, hasPrimaryError);
  if (cleanupErrors.length > 0) {
    primaryError = hasPrimaryError ? new AggregateError([primaryError, ...cleanupErrors], "PAR-040 caller pause assertion and cleanup both failed.")
      : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "PAR-040 caller pause cleanup failed.");
    hasPrimaryError = true;
  }
  if (hasPrimaryError) throw primaryError;
}

function configureNodeQuestionProject(project: string): ConfiguredFixture {
  const sentinels = configureParallelProject(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const stateDirectory = path.join(fixtureDirectory, "par-040-state");
  const eventsPath = path.join(stateDirectory, "events.jsonl");
  const startedPaths = Object.fromEntries(roles.flatMap((role) =>
    [1, ...(role === "seed" ? [] : [2])].map((attempt) => [`${role}-${attempt}`, path.join(stateDirectory, `${role}-${attempt}.started.json`)]))) as Record<string, string>;
  const releasePaths = { a: path.join(stateDirectory, "release-a"), b: path.join(stateDirectory, "release-b") };
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  writeFileSync(path.join(fixtureDirectory, "par-031-graph-provider.mjs"), readFileSync(fixtureSource, "utf8"), "utf8");
  writeFileSync(path.join(fixtureDirectory, "par-031-control.json"), JSON.stringify({
    eventsPath: path.relative(project, eventsPath),
    fixtureLifetimeMs,
    startedPaths: Object.fromEntries(Object.entries(startedPaths).map(([key, value]) => [key, path.relative(project, value)])),
    releasePaths: Object.fromEntries(Object.entries(releasePaths).map(([key, value]) => [key, path.relative(project, value)])),
  }), "utf8");

  const validatorLog = sentinels.validatorSentinel;
  writeFileSync(path.join(project, ".nodulus", "validators", "prepare.mjs"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(validatorLog)}, JSON.stringify({ nodeId: "seed", pid: process.pid }) + "\\n", "utf8");\nprocess.stdout.write('{"valid":true,"errors":[]}');\n`, "utf8");
  const settings = readProjectJson(project, ".nodulus/settings.json") as RecordValue;
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  const baseProfile = profiles.fixture ?? {};
  for (const role of roles) {
    const wrapper = path.join(fixtureDirectory, process.platform === "win32" ? `par-040-${role}.cmd` : `par-040-${role}.sh`);
    if (process.platform === "win32") {
      writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-031-graph-provider.mjs" "${role}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    } else {
      writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-031-graph-provider.mjs' '${role}' "$@"\n`, "utf8");
      chmodSync(wrapper, 0o755);
    }
    profiles[role] = { ...baseProfile, enabled: true, executable: wrapper, kind: "codex", model: `p5a-${role}`, timeoutMs: profileTimeoutMs, capabilities: [], sandbox: "read-only" };
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
    writeFileSync(path.join(project, instruction), `P5A captured local fixture instructions for ${role}.\n`, "utf8");
    const inputs = role === "seed" ? { request: { from: "request", contract: "request.v1" } } : { report: { from: "seed.report", contract: "report.v1" } };
    writeJson(project, `.nodulus/nodes/${role}.json`, {
      ...template,
      id: role,
      providerProfile: role,
      instructions: [instruction],
      inputs,
      expectedOutputs: [{ name: "report", contract: "report.v1", ...(role === "seed" ? { validator: ".nodulus/validators/prepare.mjs" } : {}) }],
    });
  }
  return { eventsPath, stateDirectory: fixtureDirectory, startedPaths, releasePaths, validatorLog, providerSentinel: sentinels.providerSentinel, providerSentinelExists: () => existsSync(sentinels.providerSentinel) };
}

function configureCallerProject(project: string): ConfiguredFixture {
  const sentinels = configureParallelProject(project);
  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["root"];
  workflow.execution.maxConcurrency = 1;
  workflow.execution.dependsOn = { root: [] };
  workflow.execution.resources = { root: [] };
  const callerWorkflow = { ...workflow, inputs: { goal: { contract: "goal.v1" } }, outputs: [{ name: "finalReport", from: "root.report", contract: "report.v1" }] };
  writeJson(project, ".nodulus/workflows/example.json", callerWorkflow);
  writeJson(project, ".nodulus/contracts/goal.v1.schema.json", { type: "string", minLength: 5 });
  writeJson(project, ".nodulus/nodes/root.json", {
    schemaVersion: 1,
    id: "root",
    providerProfile: "fixture",
    instructions: [".nodulus/instructions/goal.md"],
    inputs: { goal: { from: "caller.goal", contract: "goal.v1" } },
    expectedOutputs: [{ name: "report", contract: "report.v1" }],
  });
  writeFileSync(path.join(project, ".nodulus", "instructions", "goal.md"), "Produce a report from the required caller goal.\n", "utf8");
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const eventsPath = path.join(fixtureDirectory, "par-040-caller-events.jsonl");
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  return {
    eventsPath,
    stateDirectory: fixtureDirectory,
    startedPaths: {},
    releasePaths: {},
    validatorLog: sentinels.validatorSentinel,
    providerSentinel: sentinels.providerSentinel,
    providerSentinelExists: () => existsSync(sentinels.providerSentinel),
  };
}

type ConfiguredFixture = {
  eventsPath: string;
  stateDirectory: string;
  startedPaths: Record<string, string>;
  releasePaths: Record<string, string>;
  validatorLog: string;
  providerSentinel: string;
  providerSentinelExists(): boolean;
};

function createActivity(): Activity { return { availability: [], invocations: [], repairs: 0, telemetry: 0, launches: 0, legacyUsage: 0, delegated: [] }; }

function observeProvider(project: string, activity: Activity): ProviderPort {
  const delegate = createDefaultProviderPort(project);
  return {
    ...delegate,
    invoke(invocation) {
      activity.invocations.push({ nodeId: invocation.nodeId, ...(invocation.call?.callId ? { callId: invocation.call.callId } : {}), attempt: invocation.attempt });
      return track(delegate.invoke(invocation), activity);
    },
    ...(delegate.isAvailable ? { isAvailable: (profile, options) => {
      activity.availability.push(typeof profile.model === "string" ? profile.model : "unknown");
      return track(delegate.isAvailable!(profile, options), activity);
    } } : {}),
    ...(delegate.repairResponse ? { repairResponse: (invocation, raw, errors) => {
      activity.repairs += 1;
      return track(delegate.repairResponse!(invocation, raw, errors), activity);
    } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall: (callId) => { activity.telemetry += 1; return delegate.telemetryForCall!(callId); } } : {}),
    ...(delegate.launchForCall ? { launchForCall: (callId) => { activity.launches += 1; return delegate.launchForCall!(callId); } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall: () => { activity.legacyUsage += 1; return delegate.usageForLastCall!(); } } : {}),
  };
}

function track<T>(operation: T, activity: Activity): T {
  if (typeof operation === "object" && operation !== null && "then" in operation && typeof operation.then === "function") {
    activity.delegated.push(Promise.resolve(operation).then(() => undefined, () => undefined));
  }
  return operation;
}

function capturePublic(promise: Promise<ApplicationRunResult>, operations: Promise<void>[]): Promise<Outcome> {
  const captured = promise.then<Outcome, Outcome>((result) => ({ kind: "result", result }), (error: unknown) => ({ kind: "error", error }));
  operations.push(captured.then(() => undefined));
  return captured;
}

function trackPublicOperation<T>(operation: Promise<T>, pending: Promise<void>[]): Promise<T> {
  pending.push(operation.then(() => undefined, () => undefined));
  return operation;
}

async function readInspection(project: string, runId: string, storage: IntakeStorage, pending: Promise<void>[], deadline: number): Promise<RecordValue> {
  const operation = trackPublicOperation(inspectRun(project, runId, storage), pending);
  return await withDeadline(operation, deadline, "inspectRun read");
}

async function attemptStatus(project: string, runId: string, storage: IntakeStorage, pending: Promise<void>[], deadline: number): Promise<{ kind: "result"; value: RecordValue } | { kind: "error"; error: unknown }> {
  const operation = trackPublicOperation(getRunStatus(project, runId, storage), pending);
  try { return { kind: "result", value: await withDeadline(operation, deadline, "getRunStatus read") as unknown as RecordValue }; }
  catch (error) { return { kind: "error", error }; }
}

function expectStatusRead(
  attempt: Awaited<ReturnType<typeof attemptStatus>>,
  runId: string,
  checkpoint: RecordValue,
  events: RecordValue[],
  requests: unknown[],
): void {
  if (attempt.kind === "error") {
    throw new Error(`getRunStatus rejected a valid saved graph pause (${errorCode(attempt.error)}).`, { cause: attempt.error });
  }
  const value = attempt.value;
  expect(value).toMatchObject({ runId, status: "needs_input" });
  expect(value.checkpoint).toEqual(checkpoint);
  expect(value.events).toEqual(events);
  expect(value.pendingRequests).toEqual(requests);
  if (requests.length > 0) expect(value.pendingRequest).toEqual(requests[0]);
  else expect(value).not.toHaveProperty("pendingRequest");
}

function expectInspection(value: RecordValue, runId: string, checkpoint: RecordValue, events: RecordValue[], requests: unknown[], actionable: boolean): void {
  expect(value.runId).toBe(runId);
  expect(value.status).toBe("needs_input");
  expect(value.checkpoint).toEqual(checkpoint);
  expect(value.timeline).toEqual(events);
  expect(value.pendingRequests).toEqual(requests);
  if (requests.length > 0) expect(value.pendingRequest).toEqual(requests[0]);
  else expect(value).not.toHaveProperty("pendingRequest");
  const actions = Array.isArray(value.nextActions) ? value.nextActions : [];
  expect(actions.includes("provide_pending_input")).toBe(actionable);
}

function assertNodeRequest(project: string, runId: string, request: Request, nodeId: "a" | "b"): void {
  expect(request).toMatchObject({ nodeId, attempt: 1, callId: expect.any(String), id: expect.any(String), questions: expect.any(Array), answerContract: expect.any(Object) });
  expect(request).not.toHaveProperty("kind");
  const bytes = readRunFile(project, runId, `pending/${request.id}.json`);
  expect(JSON.parse(bytes.toString("utf8")) as unknown).toEqual(request);
  const pending = record(record(readCheckpoint(project, runId).graph).pendingRequests)[request.id];
  expect(pending).toMatchObject({ kind: "node", nodeId, attempt: 1, requestRef: `pending/${request.id}.json`, requestSha256: digest(bytes) });
  const currentNode = record(record(record(readCheckpoint(project, runId).graph).nodes)[nodeId]);
  expect(currentNode).toMatchObject({ phase: "pending", attempt: 1, callId: request.callId });
}

function assertCallEvidence(project: string, runId: string, marker: Marker): void {
  const requestPath = runFile(project, runId, `calls/${marker.callId}/request.json`);
  const request = readObject(requestPath);
  expect(request).toMatchObject({
    runId,
    nodeId: marker.nodeId,
    attempt: marker.attempt,
    callId: marker.callId,
    operation: "invoke",
    providerProfileId: marker.role,
    requestedModel: `p5a-${marker.role}`,
  });
  const invocation = readObject(runFile(project, runId, `nodes/${marker.nodeId}/attempt-001/invocation.json`));
  expect(invocation).toMatchObject({ runId, nodeId: marker.nodeId, attempt: marker.attempt, callId: marker.callId, operation: "invoke" });
  const transport = readObject(runFile(project, runId, `calls/${marker.callId}/transport.json`));
  expect(transport).toMatchObject({ callId: marker.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
}

function assertActiveBranchCalls(project: string, runId: string, events: RecordValue[], markers: Marker[]): void {
  for (const marker of markers) {
    const starts = events.filter((event) => event.event === "provider.call.started" && event.nodeId === marker.nodeId && event.callId === marker.callId);
    const completions = events.filter((event) => event.event === "provider.call.completed" && event.nodeId === marker.nodeId && event.callId === marker.callId);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ runId, nodeId: marker.nodeId, callId: marker.callId, attempt: 1, operation: "invoke" });
    expect(completions).toHaveLength(0);
    const invocation = readObject(runFile(project, runId, `nodes/${marker.nodeId}/attempt-001/invocation.json`));
    expect(invocation).toMatchObject({ runId, nodeId: marker.nodeId, callId: marker.callId, attempt: 1, operation: "invoke" });
  }
}

function assertAcceptedNodeArtifacts(project: string, runId: string, checkpoint: RecordValue, nodeId: string): RecordValue[] {
  const graphNodes = record(record(checkpoint.graph).nodes);
  const nodeState = record(graphNodes[nodeId]);
  const accepted = record(nodeState.accepted);
  const attempt = accepted.attempt;
  const callId = accepted.callId;
  if (nodeState.phase !== "accepted" || !Number.isSafeInteger(attempt) || (attempt as number) < 1 || typeof callId !== "string") {
    throw new Error(`PAR-040 '${nodeId}' has no accepted graph manifest to verify.`);
  }
  const attemptRoot = `nodes/${nodeId}/attempt-${String(attempt).padStart(3, "0")}`;
  const resultRef = `${attemptRoot}/result.json`;
  const validationRef = `${attemptRoot}/validation.json`;
  const responseRef = `${attemptRoot}/response.raw.txt`;
  expect(accepted).toMatchObject({ callId, attempt, resultRef, validationRef, responseRef });
  const resultBytes = readRunFile(project, runId, resultRef);
  const validationBytes = readRunFile(project, runId, validationRef);
  const responseBytes = readRunFile(project, runId, responseRef);
  expect(digest(resultBytes)).toBe(accepted.resultSha256);
  expect(digest(validationBytes)).toBe(accepted.validationSha256);
  expect(digest(responseBytes)).toBe(accepted.responseSha256);
  const result = record(JSON.parse(resultBytes.toString("utf8")) as unknown);
  const validation = record(JSON.parse(validationBytes.toString("utf8")) as unknown);
  const response = record(JSON.parse(responseBytes.toString("utf8")) as unknown);
  expect(result.status).toBe("success");
  expect(response.status).toBe("success");
  expect(result.artifacts).toEqual(response.artifacts);
  expect(validation).toMatchObject({ valid: true, outcome: "success", errors: [] });

  const definitions = readObject(runFile(project, runId, "context/definitions.json"));
  const nodeDefinitions = Array.isArray(definitions.nodes) ? definitions.nodes.map(record) : [];
  const nodeDefinition = nodeDefinitions.find((candidate) => candidate.id === nodeId);
  if (!nodeDefinition || !Array.isArray(nodeDefinition.expectedOutputs) || !Array.isArray(result.artifacts) || !Array.isArray(accepted.artifacts)) {
    throw new Error(`PAR-040 '${nodeId}' captured output declaration or accepted artifacts are malformed.`);
  }
  const outputs = result.artifacts.map(record);
  const manifests = accepted.artifacts.map(record);
  expect(outputs).toHaveLength(nodeDefinition.expectedOutputs.length);
  expect(manifests).toHaveLength(nodeDefinition.expectedOutputs.length);
  return nodeDefinition.expectedOutputs.map((rawDeclaration) => {
    const declaration = record(rawDeclaration);
    const name = declaration.name;
    const contract = declaration.contract;
    if (typeof name !== "string" || typeof contract !== "string") throw new Error(`PAR-040 '${nodeId}' has an invalid captured output declaration.`);
    const output = outputs.find((candidate) => candidate.name === name && candidate.contract === contract);
    const manifest = manifests.find((candidate) => candidate.name === name && candidate.contract === contract);
    if (!output || !manifest) throw new Error(`PAR-040 '${nodeId}' accepted output '${name}' is absent from its result or manifest.`);
    const reference = `nodes/${nodeId}/artifacts/${name}.json`;
    expect(manifest).toMatchObject({ name, contract, ref: reference });
    const artifactBytes = readRunFile(project, runId, reference);
    expect(digest(artifactBytes)).toBe(manifest.sha256);
    expect(JSON.parse(artifactBytes.toString("utf8"))).toEqual(output);
    return { nodeId, name, reference, accepted: true };
  });
}

function assertFixtureCallTrace(eventsPath: string, marker: Marker): void {
  const events = readFixtureEvents(eventsPath).filter((event) => event.role === marker.role && event.callId === marker.callId);
  const started = events.filter((event) => event.stage === "inference-started");
  const completed = events.filter((event) => event.stage === "inference-completed");
  expect(started).toHaveLength(1);
  expect(completed).toHaveLength(1);
  expect(started[0]).toMatchObject({ nodeId: marker.nodeId, runId: marker.runId, callId: marker.callId, attempt: marker.attempt, pid: marker.pid });
  expect(completed[0]).toMatchObject({ nodeId: marker.nodeId, runId: marker.runId, callId: marker.callId, attempt: marker.attempt, pid: marker.pid });
}

function assertNodeState(checkpoint: RecordValue, nodeId: Role, marker: Marker, phase: string): void {
  const nodes = record(record(checkpoint.graph).nodes);
  expect(nodes[nodeId]).toMatchObject({ phase, attempt: 1, callId: marker.callId, launch: true });
}

async function waitForMarker(project: string, role: Role, attempt: number, deadline: number, getOutcome: () => Outcome | undefined): Promise<Marker> {
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "par-040-state");
  const markerPath = path.join(stateDirectory, `${role}-${attempt}.started.json`);
  await waitForCondition(() => existsSync(markerPath), deadline, `${role} provider marker`, getOutcome);
  const marker = readObject(markerPath) as unknown as Marker;
  if (marker.role !== role || marker.nodeId !== role || marker.attempt !== attempt || typeof marker.runId !== "string" || typeof marker.callId !== "string" || !isSafePid(marker.pid)) {
    throw new Error(`PAR-040 ${role} provider marker has invalid identity.`);
  }
  return marker;
}

async function waitForAcceptedSeed(project: string, runId: string, marker: Marker, validatorLog: string, deadline: number, getOutcome: () => Outcome | undefined): Promise<void> {
  await waitForCondition(() => {
    try { return record(record(readCheckpoint(project, runId).graph).nodes).seed !== undefined
      && record(record(record(readCheckpoint(project, runId).graph).nodes).seed).phase === "accepted"
      && readValidatorLog(validatorLog).some((entry) => entry.nodeId === "seed" && isSafePid(entry.pid)); }
    catch { return false; }
  }, deadline, "validated seed acceptance", getOutcome);
  expect(record(record(record(readCheckpoint(project, runId).graph).nodes).seed).accepted).toMatchObject({ callId: marker.callId, attempt: 1 });
  expect(readValidatorLog(validatorLog)).toMatchObject([{ nodeId: "seed", pid: expect.any(Number) }]);
}

async function waitForQuestion(project: string, runId: string, marker: Marker, deadline: number, getOutcome: () => Outcome | undefined): Promise<Request> {
  const resultPath = runFile(project, runId, `nodes/${marker.nodeId}/attempt-001/result.json`);
  let committed: { request: Request; bytes: Buffer } | undefined;
  await waitForCondition(() => {
    try {
      if (!existsSync(resultPath)) return false;
      const result = readObject(resultPath);
      const request = record(result.request);
      if (result.status !== "needs_input" || !isUuid(request.id)) return false;
      if (request.nodeId !== marker.nodeId || request.callId !== marker.callId || request.attempt !== 1) return false;
      const relative = `pending/${request.id}.json`;
      const pendingPath = runFile(project, runId, relative);
      if (!existsSync(pendingPath)) return false;
      const bytes = readFileSync(pendingPath);
      const savedRequest: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isDeepStrictEqual(savedRequest, request)) return false;
      const entry = record(record(readCheckpoint(project, runId).graph).pendingRequests)[request.id];
      if (!entry || typeof entry !== "object") return false;
      const pending = record(entry);
      const currentNode = record(record(record(readCheckpoint(project, runId).graph).nodes)[marker.nodeId]);
      if (pending.kind !== "node" || pending.nodeId !== marker.nodeId || pending.attempt !== 1 || pending.requestRef !== relative || pending.requestSha256 !== digest(bytes)) return false;
      if (currentNode.phase !== "pending" || currentNode.callId !== marker.callId || currentNode.attempt !== 1) return false;
      committed = { request: request as unknown as Request, bytes };
      return true;
    } catch { return false; }
  }, deadline, `${marker.nodeId} checkpoint-last pending request commit`, getOutcome);
  if (!committed) throw new Error(`PAR-040 ${marker.nodeId} pending request was not committed with its checkpoint reference.`);
  expect(JSON.parse(committed.bytes.toString("utf8")) as unknown).toEqual(committed.request);
  return committed.request;
}

function requestCompletionOrder(eventsPath: string): string[] {
  return readFixtureEvents(eventsPath).filter((event) => event.stage === "inference-completed" && (event.role === "a" || event.role === "b")).map((event) => event.role);
}

function assertAnswerCommit(project: string, runId: string, request: Request, answer: RecordValue): void {
  const relative = `answers/${request.id}.json`;
  const bytes = readRunFile(project, runId, relative);
  expect(JSON.parse(bytes.toString("utf8")) as unknown).toEqual(answer);
  const entry = record(record(readCheckpoint(project, runId).graph).pendingRequests)[request.id];
  expect(entry).toMatchObject({ answerRef: relative, answerSha256: digest(bytes) });
  const answered = readEvents(project, runId).filter((event) => event.event === "request.answered" && event.requestId === request.id);
  expect(answered).toHaveLength(1);
  expect(answered[0]).toMatchObject({ kind: "node", nodeId: request.nodeId, requestId: request.id });
  expect(answered[0]).not.toHaveProperty("answer");
  expect(answered[0]).not.toHaveProperty("answers");
  const serializedEvent = JSON.stringify(answered[0]);
  expect(serializedEvent).not.toContain(JSON.stringify(answer));
  for (const value of Object.values(answer)) expect(serializedEvent).not.toContain(String(value));
}

async function expectCorruptRead(
  project: string,
  runId: string,
  configured: ConfiguredFixture,
  activity: Activity,
  observer: ReturnType<typeof observeOwnedNativeProcesses>,
  readStorage: ReadStorageObserver,
  publicOperations: Promise<void>[],
  deadline: number,
  description: string,
): Promise<void> {
  const before = observeReadState(project, runId, configured, activity, observer, readStorage);
  const corruptedTree = snapshotTree(runDirectory(project, runId));
  const status = await attemptStatus(project, runId, readStorage.storage, publicOperations, deadline);
  const afterStatus = snapshotTree(runDirectory(project, runId));
  expect(afterStatus).toEqual(corruptedTree);
  const inspection = await readInspection(project, runId, readStorage.storage, publicOperations, deadline);
  expect(status.kind, `${description}: getRunStatus should reject`).toBe("error");
  if (status.kind === "error") expect(errorCode(status.error)).toBe("RUN_STATE_INVALID");
  expect(inspection.status, `${description}: inspectRun should fail closed`).toBe("unavailable");
  expect(inspection).not.toHaveProperty("pendingRequest");
  expect(Array.isArray(inspection.pendingRequests) ? inspection.pendingRequests : []).toEqual([]);
  expect(Array.isArray(inspection.nextActions) ? inspection.nextActions : []).not.toContain("provide_pending_input");
  const diagnostics = record(inspection.diagnostics);
  const messages = diagnostics.messages;
  expect(Array.isArray(messages) && messages.length > 0).toBe(true);
  expect(snapshotTree(runDirectory(project, runId))).toEqual(corruptedTree);
  assertReadStateUnchanged(project, runId, configured, activity, observer, readStorage, before);
}

async function expectAcceptedArtifactFault(
  project: string,
  runId: string,
  configured: ConfiguredFixture,
  activity: Activity,
  observer: ReturnType<typeof observeOwnedNativeProcesses>,
  readStorage: ReadStorageObserver,
  publicOperations: Promise<void>[],
  deadline: number,
  cleanRunTree: SnapshotEntry[],
  verifiedOtherArtifacts: RecordValue[],
  changedPaths: string[],
  description: string,
): Promise<void> {
  const faultRunTree = snapshotTree(runDirectory(project, runId));
  expectOnlyRelativeFilesChanged(cleanRunTree, faultRunTree, changedPaths);
  const beforeRead = observeReadState(project, runId, configured, activity, observer, readStorage);
  const status = await attemptStatus(project, runId, readStorage.storage, publicOperations, deadline);
  if (status.kind !== "result") throw new Error(`PAR-040 ${description}: getRunStatus rejected (${errorDescription(status.error)}).`, { cause: status.error });
  const checkpoint = readCheckpoint(project, runId);
  const events = readEvents(project, runId);
  expect(status.value).toMatchObject({ runId, status: "success" });
  expect(status.value.checkpoint).toEqual(checkpoint);
  expect(status.value.events).toEqual(events);
  const inspection = await readInspection(project, runId, readStorage.storage, publicOperations, deadline);
  expect(inspection.status, description).toBe("success");
  expect(inspection.checkpoint).toEqual(checkpoint);
  expect(inspection.timeline).toEqual(events);
  expect(inspection.artifacts).toEqual(verifiedOtherArtifacts);
  const messages = record(inspection.diagnostics).messages;
  expect(Array.isArray(messages) && messages.some((message) => typeof message === "string" && /node 'a'/i.test(message)), description).toBe(true);
  assertReadStateUnchanged(project, runId, configured, activity, observer, readStorage, beforeRead);
  expect(snapshotTree(runDirectory(project, runId))).toEqual(faultRunTree);
}

async function cleanup(
  project: string,
  identity: string,
  label: string,
  configured: ConfiguredFixture,
  activity: Activity,
  observer: ReturnType<typeof observeOwnedNativeProcesses>,
  publicOperations: Promise<void>[],
  retain: boolean,
): Promise<Error[]> {
  const errors: Error[] = [];
  const deadline = Date.now() + cleanupBudgetMs;
  for (const release of Object.values(configured.releasePaths)) {
    try {
      mkdirSync(path.dirname(release), { recursive: true });
      if (!existsSync(release)) writeFileSync(release, "cleanup release\n", { encoding: "utf8", flag: "wx" });
    } catch (error) { errors.push(asError(error)); }
  }
  try { await withDeadline(Promise.all(publicOperations), deadline, "public run/resume settlement"); }
  catch (error) { errors.push(asError(error)); }
  try { await withDeadline(Promise.all(activity.delegated), deadline, "provider and validator child settlement"); }
  catch (error) { errors.push(asError(error)); }
  let nativeDrained = false;
  try { await observer.drain(deadline); nativeDrained = true; }
  catch (error) { errors.push(asError(error)); }
  const clean = nativeDrained && !observer.observationFailure && errors.length === 0;
  if (retain || !clean) {
    console.error(`PAR-040 retained owned project for evidence: ${project}`);
    if (!clean) errors.push(new Error(`PAR-040 retaining project because owned child cleanup was not verified: ${project}`));
    return errors;
  }
  try {
    assertOwnedProject(project, identity, label);
    rmSync(project, { recursive: true, force: true });
    if (existsSync(project)) throw new Error("PAR-040 owned project remained after cleanup.");
  } catch (error) { errors.push(asError(error)); }
  return errors;
}

function observeReadState(project: string, runId: string, configured: ConfiguredFixture, activity: Activity, observer: ReturnType<typeof observeOwnedNativeProcesses>, readStorage: ReadStorageObserver): Observation {
  return {
    activity: activitySnapshot(activity),
    delegatedCount: activity.delegated.length,
    storageMutations: { ...readStorage.mutations },
    nativeCount: observer.diagnostics.length,
    nativeDiagnostics: JSON.stringify(observer.diagnostics),
    nativeFailure: observer.observationFailure,
    fixtureBytes: readFileSync(configured.eventsPath),
    validatorBytes: existsSync(configured.validatorLog) ? readFileSync(configured.validatorLog) : null,
    fixtureTree: snapshotTree(configured.stateDirectory),
    runTree: snapshotTree(runDirectory(project, runId)),
  };
}

function assertReadStateUnchanged(project: string, runId: string, configured: ConfiguredFixture, activity: Activity, observer: ReturnType<typeof observeOwnedNativeProcesses>, readStorage: ReadStorageObserver, before: Observation): void {
  expect(snapshotTree(runDirectory(project, runId))).toEqual(before.runTree);
  expect(activitySnapshot(activity)).toEqual(before.activity);
  expect(activity.delegated.length).toBe(before.delegatedCount);
  expect(readStorage.mutations).toEqual(before.storageMutations);
  expect(observer.diagnostics.length).toBe(before.nativeCount);
  expect(JSON.stringify(observer.diagnostics)).toBe(before.nativeDiagnostics);
  expect(observer.observationFailure).toBe(before.nativeFailure);
  expect(readFileSync(configured.eventsPath).equals(before.fixtureBytes)).toBe(true);
  const validatorBytes = existsSync(configured.validatorLog) ? readFileSync(configured.validatorLog) : null;
  expect(validatorBytes).toEqual(before.validatorBytes);
  expect(snapshotTree(configured.stateDirectory)).toEqual(before.fixtureTree);
}

function activitySnapshot(activity: Activity): Omit<Activity, "delegated"> {
  return { availability: [...activity.availability], invocations: structuredClone(activity.invocations), repairs: activity.repairs, telemetry: activity.telemetry, launches: activity.launches, legacyUsage: activity.legacyUsage };
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const canonicalTemp = realpathSync.native(tmpdir());
  const current = realpathSync.native(project);
  if (current !== identity || path.dirname(current) !== canonicalTemp || !path.basename(current).startsWith(`nodulus-${label}-`)) {
    throw new Error("PAR-040 refused to remove a project outside its exact owned temporary directory.");
  }
}

function snapshotTree(root: string): SnapshotEntry[] {
  const output: SnapshotEntry[] = [];
  let totalBytes = 0;
  const maximumEntries = 2048;
  const maximumBytes = 8 * 1024 * 1024;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (output.length >= maximumEntries) throw new Error("PAR-040 snapshot exceeded its 2048-entry bound.");
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`PAR-040 unsupported symbolic link in snapshot: '${relative}'.`);
      if (metadata.isDirectory()) {
        output.push({ path: relative, kind: "directory" });
        visit(absolute);
      } else if (metadata.isFile() && entry.isFile()) {
        if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maximumBytes - totalBytes) {
          throw new Error("PAR-040 snapshot exceeded its 8 MiB byte bound.");
        }
        const bytes = readFileSync(absolute);
        if (bytes.length !== metadata.size) throw new Error(`PAR-040 file changed while snapshotting '${relative}'.`);
        totalBytes += bytes.length;
        output.push({ path: relative, kind: "file", bytes });
      } else throw new Error(`PAR-040 unexpected non-file entry in snapshot: '${relative}'.`);
    }
  };
  visit(root);
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function expectOnlyRelativeFileChanged(before: SnapshotEntry[], after: SnapshotEntry[], changedPath: string): void {
  const omit = (entries: SnapshotEntry[]): SnapshotEntry[] => entries.filter((entry) => entry.path !== changedPath);
  expect(omit(after)).toEqual(omit(before));
  expect(after.find((entry) => entry.path === changedPath)).not.toEqual(before.find((entry) => entry.path === changedPath));
}

function expectOnlyRelativeFilesChanged(before: SnapshotEntry[], after: SnapshotEntry[], changedPaths: string[]): void {
  const changed = new Set(changedPaths);
  const omitChanged = (entries: SnapshotEntry[]): SnapshotEntry[] => entries.filter((entry) => !changed.has(entry.path));
  expect(omitChanged(after)).toEqual(omitChanged(before));
  for (const changedPath of changed) {
    expect(after.find((entry) => entry.path === changedPath)).not.toEqual(before.find((entry) => entry.path === changedPath));
  }
}

async function waitForCondition(predicate: () => boolean, deadline: number, description: string, getOutcome: () => Outcome | undefined): Promise<void> {
  while (!predicate()) {
    const outcome = getOutcome();
    if (outcome) {
      if (outcome.kind === "error") throw outcome.error;
      throw new Error(`PAR-040 public run completed before ${description}.`);
    }
    assertBeforeDeadline(deadline, description);
    await delay(10);
  }
}

async function awaitOutcome(promise: Promise<Outcome>, deadline: number, description: string, getOutcome: () => Outcome | undefined): Promise<Outcome> {
  const outcome = await withDeadline(promise, deadline, description);
  const observed = getOutcome();
  if (observed?.kind === "error") throw observed.error;
  return outcome;
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`PAR-040 shared scenario deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`PAR-040 shared scenario deadline expired during ${description}.`)), remaining); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function requireResult(outcome: Outcome, description: string): ApplicationRunResult {
  if (outcome.kind === "error") throw new Error(`PAR-040 ${description} failed.`, { cause: outcome.error });
  return outcome.result;
}

function readCheckpoint(project: string, runId: string): RecordValue { return readObject(runFile(project, runId, "run.json")); }
function readEvents(project: string, runId: string): RecordValue[] { return readFileSync(runFile(project, runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RecordValue); }
function writeRunEvents(project: string, runId: string, events: RecordValue[]): void { writeFileSync(runFile(project, runId, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8"); }
function writeRunJson(project: string, runId: string, relative: string, value: unknown): Buffer { const bytes = Buffer.from(`${JSON.stringify(value)}\n`); writeFileSync(runFile(project, runId, relative), bytes); return bytes; }
function readFixtureEvents(file: string): Array<RecordValue & { role: string; stage: string }> { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RecordValue & { role: string; stage: string }); }
function readObject(file: string): RecordValue { return JSON.parse(readFileSync(file, "utf8")) as RecordValue; }
function readRunFile(project: string, runId: string, relative: string): Buffer { return readFileSync(runFile(project, runId, relative)); }
function runDirectory(project: string, runId: string): string { return path.join(project, ".nodulus", "runs", runId); }
function runFile(project: string, runId: string, relative: string): string { return path.join(runDirectory(project, runId), relative); }
function readValidatorLog(file: string): RecordValue[] { return existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RecordValue) : []; }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function record(value: unknown): RecordValue { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {}; }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value); }
function isSafePid(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function isProcessRecord(observer: ReturnType<typeof observeOwnedNativeProcesses>, pid: number, stage: "spawn" | "close"): boolean { return observer.diagnostics.some((record) => record.pid === pid && record.stages.includes(stage)); }
function assertContiguousSequences(events: RecordValue[]): void {
  const sequences = events.map((event) => event.sequence);
  expect(sequences.every((sequence) => typeof sequence === "number" && Number.isSafeInteger(sequence))).toBe(true);
  const numeric = sequences as number[];
  expect(new Set(numeric).size).toBe(numeric.length);
  for (let index = 1; index < numeric.length; index += 1) expect(numeric[index]).toBe(numeric[index - 1]! + 1);
}
function errorCode(error: unknown): string { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "none"; }
function errorDescription(error: unknown, depth = 0): string {
  if (depth >= 3) return "cause chain truncated";
  if (!(error instanceof Error)) return `${errorCode(error)}: non-Error failure`;
  const code = errorCode(error);
  const message = error.message.slice(0, 500);
  const cause = error.cause;
  return cause === undefined ? `${code}: ${message}` : `${code}: ${message}; cause=${errorDescription(cause, depth + 1)}`.slice(0, 1200);
}
function assertBeforeDeadline(deadline: number, label: string): void { if (Date.now() >= deadline) throw new Error(`PAR-040 scenario deadline expired during ${label}.`); }
function compareText(left: string, right: string): number { return left.localeCompare(right); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === "string" ? value : "PAR-040 operation failed with a non-Error value."); }

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type Role = "seed" | "a" | "b";
type ChildOperation = "availability" | "invoke" | "repair_response" | "unlabelled";
type ChildObservation = {
  identity: number;
  nodeId: string;
  operation: ChildOperation;
  callId: string | null;
  attempt: number | null;
  ordinal: number | null;
  pid: number | null;
  spawned: boolean;
  exited: boolean;
  closed: boolean;
  exitCode: number | null;
  signal: string | null;
  errorName?: string;
};
type ProviderIdentity = { nodeId: string; runId: string; callId: string; attempt: number; pid: number; role: Role };
type AInferenceProcessProof = {
  protocol: string;
  nonce: string;
  role: "a";
  nodeId: "a";
  runId: string;
  callId: string;
  attempt: 1;
  pid: number;
  ppid: number;
};
type ActiveDriver = {
  protocol: string;
  nonce: string;
  driverPid: number;
  nodeId: string;
  runId: string;
  callId: string;
  attempt: number;
  fixturePid: number;
  observations: {
    availability: Array<{ nodeId: string; model: string }>;
    invocations: Array<{ nodeId: string; runId: string; callId: string | null; attempt: number | null }>;
    repairs: Array<{ nodeId: string; runId: string; callId: string | null; attempt: number | null }>;
    overflow: boolean;
  };
  childProcesses: ChildObservation[];
  delegatedOperations: Array<{ identity: number; nodeId: string; operation: ChildOperation; callId: string | null; attempt: number | null; settled: boolean }>;
  childObservationFailure: boolean;
};
type RunCheckpoint = {
  runId: string;
  status: string;
  completedNodes: string[];
  graph: { nodes: Record<string, GraphNode>; pendingRequests?: Record<string, unknown> };
};
type GraphNode = { phase?: string; attempt?: number; callId?: string; accepted?: AcceptedRecord };
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
type DriverOutcome =
  | { kind: "result"; result: { runId: string; status: string; result: unknown } }
  | { kind: "error"; error: { name: string; code?: string; message: string } };
type ResumeEnvelope = {
  protocol: string;
  operation: string;
  nonce: string;
  outcome: DriverOutcome;
  observations: {
    availability: string[];
    invocations: Array<{ nodeId: string; callId: string | null; attempt: number; parentCallId: string | null; answers: Record<string, unknown> | null }>;
    repairs: Array<{ nodeId: string; callId: string | null; attempt: number; parentCallId: string | null }>;
    telemetry: string[];
    launches: string[];
    legacyUsage: number;
    observationLimitExceeded: boolean;
  };
  settled: { public: boolean; delegated: boolean };
};
type InitialDriverEnvelope = {
  protocol?: string;
  operation?: string;
  nonce?: string;
  publicStarted?: boolean;
  childObservationFailure?: boolean;
  observations?: { availability?: unknown[]; invocations?: unknown[]; repairs?: unknown[]; overflow?: boolean };
  childProcesses?: ChildObservation[];
  delegatedOperations?: Array<{ nodeId?: string; operation?: string }>;
  settled?: { public?: boolean; delegated?: boolean; childrenClosed?: boolean };
};
type ChildClose = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
type TrackedChild = {
  role: "crash-driver" | "resume-driver" | "pin-helper";
  child: ChildProcessWithoutNullStreams;
  close: Promise<ChildClose>;
  closeObserved: boolean;
  spawnError?: Error;
  stdinError?: Error;
  outputOverflow: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdout: Buffer[];
  stderr: Buffer[];
};
type NativePin = {
  controlDirectory: string;
  nonce: string;
  targetPid?: number;
  child: TrackedChild;
  requestSent: boolean;
  pinReady: boolean;
  normalDrainVerified: boolean;
};
type StageRecorder = (stage: string, details?: Record<string, unknown>) => void;
type ProcessTreeSnapshot = Map<string, string>;

const fixtureSource = fileURLToPath(new URL("../fixtures/par-031-graph-provider.mjs", import.meta.url));
const driverSource = fileURLToPath(new URL("../fixtures/par-036-crash-driver.mjs", import.meta.url));
const resumeDriverSource = fileURLToPath(new URL("../fixtures/par-033-fresh-resume-driver.mjs", import.meta.url));
const pinFixture = fileURLToPath(new URL("../fixtures/par-015-process-handle-pin.ps1", import.meta.url));
const roles: Role[] = ["seed", "a", "b"];
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;
const caseTimeoutMs = 35_000;
const maxCapturedOutputBytes = 256_000;
const maxControlBytes = 256_000;
const maxSnapshotBytes = 8_000_000;
const maxSnapshotEntries = 2048;
const maxProcessTreeAttempts = 800;

test("PAR-036 preserves accepted graph evidence when the real initial-run owner dies with A active", async () => {
  await exerciseRunningCrash();
}, caseTimeoutMs);

async function exerciseRunningCrash(): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const diagnosticStartedAt = performance.now();
  const stageDiagnostics: Array<{ stage: string; elapsedMs: number; details: Record<string, unknown> }> = [];
  let stageDiagnosticsTruncated = false;
  const recordStage: StageRecorder = (stage, details = {}) => {
    if (stageDiagnostics.length >= 64) {
      stageDiagnosticsTruncated = true;
      return;
    }
    stageDiagnostics.push({ stage, elapsedMs: Math.max(0, Math.round(performance.now() - diagnosticStartedAt)), details });
  };
  const label = "par-036-runner-crash-café";
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const stateDirectory = path.join(fixtureDirectory, "par-036-state");
  const controlDirectory = path.join(fixtureDirectory, "par-036-driver-control");
  const eventsPath = path.join(stateDirectory, "events.jsonl");
  const startedPaths = Object.fromEntries(roles.map((role) => [`${role}-1`, path.join(stateDirectory, `${role}-1.started.json`)])) as Record<string, string>;
  const releasePaths = { a: path.join(stateDirectory, "release-a"), b: path.join(stateDirectory, "release-b") };
  const handles: TrackedChild[] = [];
  const pins: NativePin[] = [];
  const cleanupErrors: Error[] = [];
  let primaryError: unknown;
  let hasPrimaryError = false;
  let runner: TrackedChild | undefined;
  let resumeDriver: TrackedChild | undefined;
  let activeAObserved = false;
  let nativeTargetsDrained = false;
  let failureOnlyHelperAbortUsed = false;
  let posixProcessGroupId: number | undefined;
  let intentionalRunnerTermination = false;
  const fixtureNonce = randomUUID();

  try {
    assertOwnedProject(project, projectIdentity, label);
    configureProject(project, fixtureDirectory, stateDirectory, controlDirectory, eventsPath, startedPaths, releasePaths, fixtureNonce);
    assertBeforeDeadline(scenarioDeadline, "project and real fixture setup");

    if (process.platform === "win32") {
      spawnNativePinHelper(handles, pins, "a-inference-cmd", stateDirectory, scenarioDeadline, recordStage);
      spawnNativePinHelper(handles, pins, "a-fixture-node", stateDirectory, scenarioDeadline, recordStage);
    }

    const runnerNonce = fixtureNonce;
    runner = startTrackedChild(handles, "crash-driver", process.execPath, [driverSource, "initial", runnerNonce, project, controlDirectory, startedPaths["a-1"]!, String(scenarioDeadline)], project);
    const ready = await waitForJson<Record<string, unknown>>(path.join(controlDirectory, "driver-ready.json"), "initial crash driver ready marker", scenarioDeadline, runner);
    expect(ready).toMatchObject({ protocol: "par-036-crash-driver-v1", nonce: runnerNonce, pid: runner.child.pid });
    recordStage("initial-driver-ready", { nonce: runnerNonce, childPid: runner.child.pid });
    const seed = await waitForProviderMarker(startedPaths["seed-1"]!, "seed provider entry", scenarioDeadline, runner);
    const runId = seed.runId;
    expect(seed).toMatchObject({ role: "seed", nodeId: "seed", attempt: 1 });
    recordStage("seed-marker", { pid: seed.pid, callId: seed.callId, nodeId: seed.nodeId, attempt: seed.attempt });
    await waitForAcceptedSeed(project, runId, seed.callId, scenarioDeadline, runner);
    const a = await waitForProviderMarker(startedPaths["a-1"]!, "A held provider entry", scenarioDeadline, runner);
    activeAObserved = true;
    expect(a).toMatchObject({ role: "a", nodeId: "a", runId, attempt: 1 });
    recordStage("a-marker", { pid: a.pid, callId: a.callId, nodeId: a.nodeId, attempt: a.attempt });
    expect(existsSync(startedPaths["b-1"]!)).toBe(false);
    expect(readFixtureEvents(eventsPath).some((event) => event.role === "b")).toBe(false);

    const activePath = path.join(controlDirectory, "driver-active.json");
    const active = await waitForJson<ActiveDriver>(activePath, "active A process census", scenarioDeadline, runner);
    assertActiveDriverCensus(active, runner, a, seed);
    expect(active.nonce).toBe(runnerNonce);
    recordStage("a-process-census", { runnerPid: runner.child.pid, fixturePid: active.fixturePid, callId: active.callId, openChildren: active.childProcesses.filter(({ closed }) => !closed).length });
    const aProcessProofPath = path.join(controlDirectory, "a-inference-process.json");
    const aProcessProof = await waitForJson<AInferenceProcessProof>(aProcessProofPath, "same-process A inference identity", scenarioDeadline, runner);
    expect(aProcessProof).toMatchObject({
      protocol: "par-036-a-process-v1", nonce: runnerNonce, role: "a", nodeId: "a",
      runId, callId: a.callId, attempt: 1, pid: a.pid,
    });
    expect(isSafePid(aProcessProof.pid)).toBe(true);
    expect(isSafePid(aProcessProof.ppid)).toBe(true);
    assertCheckpointBeforeCrash(project, runId, seed, a);
    const runRoot = runDirectory(project, runId);
    expect(existsSync(path.join(runRoot, ".resume.lock")), "An initial run must not own a resume lock.").toBe(false);
    expect(existsSync(path.join(controlDirectory, "public-settled.json")), "The initial public operation must still be held at A entry.").toBe(false);

    const inferenceRoots = active.childProcesses.filter((record) => record.nodeId === "a" && record.operation === "invoke" && record.callId === a.callId && !record.closed);
    expect(inferenceRoots).toHaveLength(1);
    const inferenceRoot = inferenceRoots[0];
    if (!inferenceRoot || !Number.isSafeInteger(inferenceRoot.pid) || inferenceRoot.pid === null) {
      throw new Error("PAR-036 could not retain the actual open A inference ChildProcess identity.");
    }
    recordStage("a-inference-targets", { nonce: runnerNonce, runnerPid: runner.child.pid, fixtureNodePid: aProcessProof.pid, inferenceChildPid: inferenceRoot.pid, parentPid: aProcessProof.ppid, callId: a.callId });

    if (process.platform === "win32") {
      expect(aProcessProof.ppid).toBe(inferenceRoot.pid);
      const pinResults = await Promise.allSettled([
        requestNativePin(pins[0]!, inferenceRoot.pid, scenarioDeadline, recordStage),
        requestNativePin(pins[1]!, aProcessProof.pid, scenarioDeadline, recordStage),
      ]);
      const pinFailure = pinResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (pinFailure) throw pinFailure.reason;
      const cmdPin = pins[0]!;
      const nodePin = pins[1]!;
      expect(cmdPin.targetPid).not.toBe(nodePin.targetPid);
      expect(cmdPin.targetPid).toBe(inferenceRoot.pid);
      expect(nodePin.targetPid).toBe(a.pid);
    } else {
      expect(inferenceRoot.pid).toBe(a.pid);
      expect(isProcessGroupPresent(inferenceRoot.pid), "The captured A direct child must own a live detached POSIX process group.").toBe(true);
      posixProcessGroupId = inferenceRoot.pid;
    }
    const durableBeforeTermination = captureDurableRunBytes(runRoot);

    // Re-read durable and live controls immediately before terminating the retained runner handle.
    assertCheckpointBeforeCrash(project, runId, seed, a);
    expect(existsSync(path.join(controlDirectory, "public-settled.json"))).toBe(false);
    expect(runner.closeObserved).toBe(false);
    expect(runner.child.exitCode).toBeNull();
    expect(runner.child.signalCode).toBeNull();
    expect(readJson<AInferenceProcessProof>(aProcessProofPath)).toEqual(aProcessProof);
    if (process.platform === "win32") {
      expect(aProcessProof.ppid).toBe(inferenceRoot.pid);
      for (const pin of pins) {
        const ready = readJson(joinControl(pin.controlDirectory, "pin-ready.json"));
        expect(ready).toMatchObject({ nonce: pin.nonce, helperPid: pin.child.child.pid, rootPid: pin.targetPid, handlePid: pin.targetPid, exitCode: 259 });
        expect(existsSync(joinControl(pin.controlDirectory, "root-exited.json"))).toBe(false);
      }
    } else if (posixProcessGroupId === undefined || !isProcessGroupPresent(posixProcessGroupId)) {
      throw new Error("PAR-036 lost the actual A process-group lifetime before killing the run owner.");
    }

    intentionalRunnerTermination = true;
    if (!runner.child.kill("SIGKILL")) throw new Error("PAR-036 could not terminate the retained initial-run ChildProcess handle.");
    const runnerClose = await waitForChildClose(runner, scenarioDeadline, "initial run driver close after forced termination");
    expect(runnerClose.error).toBeUndefined();
    expect(runner.closeObserved).toBe(true);
    expect(runnerClose.signal).toBe("SIGKILL");
    recordStage("initial-driver-closed", { childPid: runner.child.pid, signal: runnerClose.signal, error: runnerClose.error?.message.slice(0, 300) });

    writeReleaseMarker(releasePaths.a, runnerNonce);
    writeReleaseMarker(releasePaths.b, runnerNonce);
    if (process.platform === "win32") {
      for (const pin of pins) {
        const exited = await waitForJson<Record<string, unknown>>(joinControl(pin.controlDirectory, "root-exited.json"), `${path.basename(pin.controlDirectory)} native process exit`, scenarioDeadline, pin.child);
        expect(exited).toMatchObject({ nonce: pin.nonce, rootPid: pin.targetPid, handlePid: pin.targetPid });
        expect(Number.isSafeInteger(exited.exitCode)).toBe(true);
        expect(exited.exitCode).not.toBe(259);
        recordStage("native-target-exited", { label: path.basename(pin.controlDirectory), nonce: pin.nonce, targetPid: pin.targetPid ?? null, exitCode: exited.exitCode });
      }
    } else {
      if (posixProcessGroupId === undefined) throw new Error("PAR-036 POSIX process-group identity is missing after runner termination.");
      await waitForProcessGroupGone(posixProcessGroupId, scenarioDeadline);
      nativeTargetsDrained = true;
    }

    expect(runner.outputOverflow).toBe(false);
    const beforeRecovery = assertCheckpointAfterCrash(project, runId, seed, a);
    expect(beforeRecovery.runBytes.equals(durableBeforeTermination.runBytes)).toBe(true);
    expect(beforeRecovery.eventBytes.equals(durableBeforeTermination.eventBytes)).toBe(true);
    expect(beforeRecovery.metricsBytes.equals(durableBeforeTermination.metricsBytes)).toBe(true);
    expect(readFileSync(path.join(runRoot, "inputs.json")).equals(durableBeforeTermination.inputBytes)).toBe(true);
    const stableRunTree = snapshotTree(runRoot);
    const fixtureEvents = readFixtureEvents(eventsPath);
    expect(fixtureEvents.some((event) => event.role === "a" && event.stage === "inference-completed" && event.callId === a.callId)).toBe(true);
    expect(fixtureEvents.some((event) => event.role === "b")).toBe(false);

    const answersPath = path.join(stateDirectory, "recovery-answers.json");
    writeFileSync(answersPath, `${JSON.stringify({ aApproval: "A-approved" })}\n`, { encoding: "utf8", flag: "wx" });
    const stableFixtureTree = snapshotTree(stateDirectory);
    const stableDriverControlTree = snapshotTree(controlDirectory);
    const recoveryNonce = randomUUID();
    resumeDriver = startTrackedChild(handles, "resume-driver", process.execPath, [
      resumeDriverSource, "partial", recoveryNonce, project, runId, randomUUID(), answersPath,
    ], project);
    const recoveryClose = await waitForChildClose(resumeDriver, scenarioDeadline, "fresh public recovery rejection driver close");
    expect(recoveryClose.error).toBeUndefined();
    expect(recoveryClose.code).toBe(0);
    expect(recoveryClose.signal).toBeNull();
    const recovery = readResumeEnvelope(resumeDriver, recoveryNonce);
    expect(recovery).toMatchObject({ protocol: "par-033-fresh-resume-driver-v1", operation: "partial", nonce: recoveryNonce });
    expect(recovery.outcome.kind).toBe("error");
    if (recovery.outcome.kind !== "error") throw new Error("PAR-036 fresh resume unexpectedly returned a successful result.");
    expect(recovery.outcome.error.code).toBe("RUN_RECOVERY_REQUIRED");
    expect(recovery.settled).toEqual({ public: true, delegated: true });
    recordStage("fresh-recovery-closed", { childPid: resumeDriver.child.pid, resultCode: recovery.outcome.error.code, publicSettled: recovery.settled.public, delegatedSettled: recovery.settled.delegated });
    expect(recovery.observations).toEqual({
      availability: [], invocations: [], repairs: [], telemetry: [], launches: [], legacyUsage: 0, observationLimitExceeded: false,
    });
    expect(snapshotTree(runRoot)).toEqual(stableRunTree);
    expect(snapshotTree(stateDirectory)).toEqual(stableFixtureTree);
    expect(snapshotTree(controlDirectory)).toEqual(stableDriverControlTree);
    expect(existsSync(path.join(runRoot, ".resume.lock"))).toBe(false);
    assertCheckpointAfterCrash(project, runId, seed, a);
    if (process.platform === "win32") {
      for (const pin of pins) await releaseAndVerifyPin(pin, scenarioDeadline, recordStage);
      nativeTargetsDrained = true;
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    recordStage("scenario-failed", { error: boundedDiagnosticError(error) });
  } finally {
    const cleanupDeadline = Date.now() + cleanupBudgetMs;
    const nativeDrainDeadline = Math.max(Date.now() + 1, cleanupDeadline - 2000);
    if (!activeAObserved) {
      const aEntryPath = startedPaths["a-1"]!;
      const activePath = path.join(controlDirectory, "driver-active.json");
      if (existsSync(aEntryPath) || existsSync(activePath)) activeAObserved = true;
    }
    if (!activeAObserved && runner?.closeObserved && hasObservedAInference(runner)) activeAObserved = true;
    if (runner) {
      try { writeReleaseMarker(releasePaths.a, fixtureNonce); }
      catch (error) { cleanupErrors.push(asError(error)); }
      try { writeReleaseMarker(releasePaths.b, fixtureNonce); }
      catch (error) { cleanupErrors.push(asError(error)); }
    }

    if (process.platform === "win32") {
      const pinsNeedingAbort: NativePin[] = [];
      await Promise.all(pins.map(async (pin) => {
        try {
          if (pin.requestSent) {
            const pinReadyPath = joinControl(pin.controlDirectory, "pin-ready.json");
            if (!pin.pinReady) {
              if (!existsSync(pinReadyPath) && !pin.child.closeObserved) {
                await waitForJson(pinReadyPath, `${path.basename(pin.controlDirectory)} cleanup pin readiness`, nativeDrainDeadline, pin.child);
              }
              if (!existsSync(pinReadyPath)) throw new Error(`PAR-036 ${path.basename(pin.controlDirectory)} helper closed without proving the requested native pin.`);
              const pinned = readJson<Record<string, unknown>>(pinReadyPath);
              expect(pinned).toMatchObject({ helperPid: pin.child.child.pid, rootPid: pin.targetPid, handlePid: pin.targetPid, exitCode: 259, nonce: pin.nonce });
              pin.pinReady = true;
              recordStage("pin-ready-observed-during-cleanup", { nonce: pin.nonce, helperPid: pin.child.child.pid ?? null, targetPid: pin.targetPid ?? null, exitCode: pinned.exitCode });
            }
            const exitedPath = joinControl(pin.controlDirectory, "root-exited.json");
            if (!existsSync(exitedPath) && !pin.child.closeObserved) {
              await waitForJson(exitedPath, `${path.basename(pin.controlDirectory)} cleanup process exit`, nativeDrainDeadline, pin.child);
            }
            await releaseAndVerifyPin(pin, nativeDrainDeadline, recordStage);
          } else {
            if (!pin.child.closeObserved) {
              writeReleaseMarker(joinControl(pin.controlDirectory, "stop-helper"), pin.nonce);
            }
            if (!pin.child.closeObserved && nativeDrainDeadline > Date.now()) {
              const close = await waitForChildClose(pin.child, nativeDrainDeadline, `${path.basename(pin.controlDirectory)} stopped pin helper close`);
              recordStage("pin-helper-closed-after-stop", { nonce: pin.nonce, helperPid: pin.child.child.pid ?? null, exitCode: close.code, signal: close.signal });
            }
            if (!pin.child.closeObserved) throw new Error(`PAR-036 ${path.basename(pin.controlDirectory)} helper close was not observed inside the shared cleanup drain window.`);
            expect(readJson(joinControl(pin.controlDirectory, "helper-stopped.json"))).toMatchObject({ pid: pin.child.child.pid, nonce: pin.nonce });
            expect(readJson(joinControl(pin.controlDirectory, "helper-closed.json"))).toMatchObject({ pid: pin.child.child.pid, nonce: pin.nonce, handleClosed: true, stoppedWithoutPin: true });
          }
        } catch (error) {
          cleanupErrors.push(asError(error));
          recordStage("pin-cleanup-failed", { helperPid: pin.child.child.pid, targetPid: pin.targetPid ?? null, nonce: pin.nonce, error: boundedDiagnosticError(error) });
          pinsNeedingAbort.push(pin);
        }
      }));
      const abortResults = await Promise.all(pinsNeedingAbort.map((pin) => abortOwnedPinHelper(pin, cleanupDeadline, cleanupErrors, recordStage)));
      failureOnlyHelperAbortUsed = abortResults.some(Boolean);
      if (!failureOnlyHelperAbortUsed && pins.length === 2 && pins.every((pin) => pin.pinReady
        && pin.normalDrainVerified
        && pin.child.closeObserved)) nativeTargetsDrained = true;
    } else if (posixProcessGroupId !== undefined && !nativeTargetsDrained) {
      try { await waitForProcessGroupGone(posixProcessGroupId, cleanupDeadline); nativeTargetsDrained = true; }
      catch (error) { cleanupErrors.push(asError(error)); }
    }

    try { await waitForAllChildren(handles, nativeDrainDeadline); }
    catch (error) { cleanupErrors.push(asError(error)); }

    if (runner && !runner.closeObserved) {
      // This is the test-owned runner handle. If normal gate release did not close it, terminate only that retained handle.
      try {
        if (runner.child.pid && runner.child.exitCode === null && runner.child.signalCode === null) runner.child.kill("SIGKILL");
        if (cleanupDeadline > Date.now()) await waitForChildClose(runner, cleanupDeadline, "retained initial driver cleanup close");
      } catch (error) { cleanupErrors.push(asError(error)); }
      if (!intentionalRunnerTermination && !nativeTargetsDrained) {
        cleanupErrors.push(new Error("PAR-036 initial owner was terminated during cleanup before provider descendant closure was proved."));
      }
    }

    if (runner && !activeAObserved && !intentionalRunnerTermination && runner.closeObserved && hasNaturalInitialDriverDrain(runner, fixtureNonce)) nativeTargetsDrained = true;
    if (!runner && !activeAObserved) nativeTargetsDrained = true;
    if (!nativeTargetsDrained) cleanupErrors.push(new Error("PAR-036 could not prove all initial provider descendants closed; retained the project and control evidence."));

    const allOwnedChildrenClosed = handles.every((handle) => handle.closeObserved);
    recordStage("cleanup-state", { allOwnedChildrenClosed, nativeTargetsDrained, openChildren: handles.filter((handle) => !handle.closeObserved).length, cleanupErrorCount: cleanupErrors.length });
    if (hasPrimaryError && cleanupErrors.length === 0 && allOwnedChildrenClosed && nativeTargetsDrained) {
      // Preserve the failed project as primary evidence without inventing a cleanup failure.
    } else if (!hasPrimaryError && cleanupErrors.length === 0 && allOwnedChildrenClosed && nativeTargetsDrained) {
      try {
        assertOwnedProject(project, projectIdentity, label);
        rmSync(project, { recursive: true, force: true });
      } catch (error) { cleanupErrors.push(asError(error)); }
    }
  }

  if (hasPrimaryError || cleanupErrors.length > 0) {
    const diagnostic = {
      stages: stageDiagnostics,
      stagesTruncated: stageDiagnosticsTruncated,
      children: handles.map((handle) => ({
        role: handle.role,
        pid: handle.child.pid ?? null,
        closeObserved: handle.closeObserved,
        exitCode: handle.child.exitCode,
        signal: handle.child.signalCode,
        error: handle.spawnError ? boundedDiagnosticError(handle.spawnError) : null,
        stdinError: handle.stdinError ? boundedDiagnosticError(handle.stdinError) : null,
        stdoutTail: captureText(handle.stdout).slice(-400),
        stderrTail: captureText(handle.stderr).slice(-400),
      })),
      pins: pins.map((pin) => ({ nonce: pin.nonce, helperPid: pin.child.child.pid ?? null, targetPid: pin.targetPid ?? null, requestSent: pin.requestSent, pinReady: pin.pinReady })),
      cleanupErrors: cleanupErrors.slice(0, 16).map(boundedDiagnosticError),
    };
    try { process.stderr.write(`[PAR-036 stage diagnostics] ${JSON.stringify(diagnostic)}\n`); }
    catch { /* Diagnostics must not replace the original test or cleanup failure. */ }
  }

  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], `PAR-036 failed; retained evidence at ${project}.`);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `PAR-036 cleanup failed; retained evidence at ${project}.`);
}

function configureProject(
  project: string,
  fixtureDirectory: string,
  stateDirectory: string,
  controlDirectory: string,
  eventsPath: string,
  startedPaths: Record<string, string>,
  releasePaths: { a: string; b: string },
  fixtureNonce: string,
): void {
  configureParallelProject(project);
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(controlDirectory, { recursive: true });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  const fixtureBytes = readFileSync(fixtureSource);
  const projectFixture = path.join(fixtureDirectory, "par-031-graph-provider.mjs");
  writeFileSync(projectFixture, fixtureBytes);
  expect(readFileSync(projectFixture).equals(fixtureBytes)).toBe(true);
  const aObserverLauncher = path.join(fixtureDirectory, "par-036-a-observer.mjs");
  const aProcessProofPath = path.join(controlDirectory, "a-inference-process.json");
  writeFileSync(aObserverLauncher, buildAObserverLauncher(projectFixture, aProcessProofPath, fixtureNonce), "utf8");
  writeFileSync(path.join(fixtureDirectory, "par-031-control.json"), JSON.stringify({
    eventsPath: path.relative(project, eventsPath),
    fixtureLifetimeMs,
    startedPaths: Object.fromEntries(Object.entries(startedPaths).map(([key, value]) => [key, path.relative(project, value)])),
    releasePaths: Object.fromEntries(Object.entries(releasePaths).map(([key, value]) => [key, path.relative(project, value)])),
  }), "utf8");

  const settings = readProjectJson(project, ".nodulus/settings.json") as { providerProfiles: Record<string, Record<string, unknown>> };
  const profiles = settings.providerProfiles;
  const baseProfile = profiles.fixture ?? {};
  for (const role of roles) {
    const wrapper = path.join(fixtureDirectory, process.platform === "win32" ? `par-036-${role}.cmd` : `par-036-${role}.sh`);
    const providerScript = role === "a" ? ".nodulus/fixtures/par-036-a-observer.mjs" : ".nodulus/fixtures/par-031-graph-provider.mjs";
    const wrapperProviderScript = process.platform === "win32" ? providerScript.replaceAll("/", "\\") : providerScript;
    if (process.platform === "win32") {
      writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${wrapperProviderScript}" "${role}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    } else {
      writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '${wrapperProviderScript}' '${role}' "$@"\n`, "utf8");
      chmodSync(wrapper, 0o755);
    }
    profiles[role] = {
      ...baseProfile,
      enabled: true,
      executable: wrapper,
      kind: "codex",
      model: `par-036-${role}`,
      timeoutMs: profileTimeoutMs,
      capabilities: [],
      sandbox: "read-only",
    };
  }
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = [...roles];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { seed: [], a: ["seed"], b: ["seed"] };
  workflow.execution.resources = { seed: [], a: ["par-036-shared"], b: ["par-036-shared"] };
  workflow.outputs = [
    { name: "aFinal", from: "a.report", contract: "report.v1" },
    { name: "bFinal", from: "b.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  const template = readProjectJson(project, ".nodulus/nodes/prepare.json") as Record<string, unknown>;
  for (const role of roles) {
    const instruction = `.nodulus/instructions/${role}.md`;
    writeFileSync(path.join(project, instruction), `PAR-036 running-crash instructions for ${role}.\n`, "utf8");
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
}

function buildAObserverLauncher(providerPath: string, proofPath: string, nonce: string): string {
  return `import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const providerPath = ${JSON.stringify(providerPath)};
const proofPath = ${JSON.stringify(proofPath)};
const nonce = ${JSON.stringify(nonce)};
const role = process.argv[2];
const args = process.argv.slice(3);

if (role === "a" && args[0] === "exec") {
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex < 0 || typeof args[outputIndex + 1] !== "string") throw new Error("PAR-036 A observer could not identify the actual inference output path.");
  const outputPath = path.resolve(process.cwd(), args[outputIndex + 1]);
  const callId = path.basename(path.dirname(outputPath));
  const runsDirectory = path.join(process.cwd(), ".nodulus", "runs");
  const matches = [];
  for (const entry of readdirSync(runsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const requestPath = path.join(runsDirectory, entry.name, "calls", callId, "request.json");
    if (!existsSync(requestPath)) continue;
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    if (request.callId === callId) matches.push(request);
  }
  if (matches.length !== 1 || matches[0].nodeId !== "a" || matches[0].attempt !== 1
    || typeof matches[0].runId !== "string" || matches[0].callId !== callId) {
    throw new Error("PAR-036 A observer could not bind the invocation to one captured A attempt-one request.");
  }
  if (existsSync(proofPath)) throw new Error("PAR-036 A observer process identity was already recorded.");
  mkdirSync(path.dirname(proofPath), { recursive: true });
  const temporaryPath = proofPath + '.' + process.pid + '.tmp';
  const proof = {
    protocol: "par-036-a-process-v1", nonce, role: "a", nodeId: "a",
    runId: matches[0].runId, callId, attempt: 1, pid: process.pid, ppid: process.ppid,
  };
  writeFileSync(temporaryPath, JSON.stringify(proof), { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, proofPath);
}

process.argv[1] = providerPath;
await import(pathToFileURL(providerPath).href);
`;
}

function startTrackedChild(
  handles: TrackedChild[],
  role: TrackedChild["role"],
  executable: string,
  args: string[],
  cwd: string,
): TrackedChild {
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const handle: TrackedChild = {
    role, child, closeObserved: false, outputOverflow: false, stdoutBytes: 0, stderrBytes: 0, stdout: [], stderr: [],
    close: Promise.resolve({ code: null, signal: null }),
  };
  handle.close = new Promise((resolve) => {
    child.once("error", (error) => { handle.spawnError = error; });
    child.once("close", (code, signal) => {
      handle.closeObserved = true;
      resolve({ code, signal, ...(handle.spawnError === undefined ? {} : { error: handle.spawnError }) });
    });
  });
  child.stdin?.on("error", (error) => { handle.stdinError = boundedError(error); });
  child.stdout?.on("data", (chunk: Buffer | string) => appendBoundedOutput(handle, "stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => appendBoundedOutput(handle, "stderr", chunk));
  handles.push(handle);
  if (typeof child.pid !== "number" || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    child.stdin?.end();
    throw new Error(`PAR-036 owned ${role} process has no safe PID after its error and close handlers were attached.`);
  }
  child.stdin?.end();
  void handle.close.catch(() => undefined);
  return handle;
}

function appendBoundedOutput(handle: TrackedChild, stream: "stdout" | "stderr", chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
  const stored = stream === "stdout" ? handle.stdout : handle.stderr;
  const byteCountKey = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
  const remaining = maxCapturedOutputBytes - handle[byteCountKey];
  if (remaining > 0) stored.push(bytes.subarray(0, remaining));
  handle[byteCountKey] += bytes.byteLength;
  if (bytes.byteLength > remaining) handle.outputOverflow = true;
}

async function waitForJson<T = Record<string, unknown>>(
  file: string,
  description: string,
  deadline: number,
  child?: TrackedChild,
): Promise<T> {
  while (!existsSync(file)) {
    if (child?.closeObserved) throw new Error(`PAR-036 ${child.role} closed before ${description}: ${captureText(child.stderr)}`);
    assertBeforeDeadline(deadline, description);
    await wait(10);
  }
  const bytes = readFileSync(file);
  if (bytes.byteLength > maxControlBytes) throw new Error(`PAR-036 ${description} exceeded its bounded control size.`);
  return JSON.parse(bytes.toString("utf8")) as T;
}

async function waitForProviderMarker(file: string, description: string, deadline: number, driver: TrackedChild): Promise<ProviderIdentity> {
  const marker = await waitForJson<ProviderIdentity>(file, description, deadline, driver);
  if (!isSafePid(marker.pid) || typeof marker.callId !== "string" || marker.callId.length === 0
    || typeof marker.runId !== "string" || marker.runId.length === 0
    || !Number.isSafeInteger(marker.attempt) || typeof marker.nodeId !== "string" || typeof marker.role !== "string") {
    throw new Error(`PAR-036 ${description} did not contain a bounded real provider identity.`);
  }
  return marker;
}

async function waitForAcceptedSeed(project: string, runId: string, acceptedCallId: string, deadline: number, driver: TrackedChild): Promise<void> {
  while (readCheckpoint(project, runId).graph.nodes.seed?.phase !== "accepted") {
    if (driver.closeObserved) throw new Error("PAR-036 initial driver closed before seed acceptance.");
    assertBeforeDeadline(deadline, "seed acceptance");
    await wait(10);
  }
  const checkpoint = readCheckpoint(project, runId);
  assertAcceptedNode(project, runId, "seed", checkpoint.graph.nodes.seed, checkpoint.completedNodes, acceptedCallId);
}

function assertActiveDriverCensus(active: ActiveDriver, driver: TrackedChild, a: ProviderIdentity, seed: ProviderIdentity): void {
  expect(active).toMatchObject({
    protocol: "par-036-crash-driver-v1", nodeId: "a", runId: a.runId, callId: a.callId, attempt: 1, fixturePid: a.pid,
  });
  expect(active.driverPid).toBe(driver.child.pid);
  expect(active.childObservationFailure).toBe(false);
  expect(active.observations.overflow).toBe(false);
  expect([...new Set(active.observations.availability.map(({ nodeId }) => nodeId))].sort(compareStrings)).toEqual(["a", "seed"]);
  expect(active.observations.invocations.map(({ nodeId }) => nodeId).sort(compareStrings)).toEqual(["a", "seed"]);
  expect(active.observations.repairs).toHaveLength(0);
  expect(active.observations.invocations.find(({ nodeId }) => nodeId === "a")).toMatchObject({ nodeId: "a", runId: a.runId, callId: a.callId, attempt: 1 });
  expect(active.observations.invocations.find(({ nodeId }) => nodeId === "seed")).toMatchObject({ nodeId: "seed", runId: seed.runId, callId: seed.callId, attempt: 1 });
  expect(active.childProcesses.every(({ nodeId }) => nodeId === "seed" || nodeId === "a")).toBe(true);
  expect(active.childProcesses.some(({ nodeId }) => nodeId === "b")).toBe(false);
  const pendingDelegated = active.delegatedOperations.filter(({ settled }) => !settled);
  expect(pendingDelegated).toHaveLength(1);
  expect(pendingDelegated[0]).toMatchObject({ nodeId: "a", operation: "invoke", callId: a.callId, attempt: 1, settled: false });
  const open = active.childProcesses.filter(({ closed }) => !closed);
  expect(open).toHaveLength(1);
  expect(open[0]).toMatchObject({
    nodeId: "a", operation: "invoke", callId: a.callId, attempt: 1, pid: expect.any(Number), spawned: true, exited: false, closed: false,
  });
  for (const child of active.childProcesses.filter(({ nodeId }) => nodeId === "seed")) {
    expect(child.closed).toBe(true);
    expect(child.exited).toBe(true);
  }
  for (const child of active.childProcesses.filter(({ nodeId, operation }) => nodeId === "a" && operation === "availability")) {
    expect(child.closed).toBe(true);
    expect(child.exited).toBe(true);
  }
}

function assertCheckpointBeforeCrash(project: string, runId: string, seed: ProviderIdentity, a: ProviderIdentity): void {
  const checkpoint = readCheckpoint(project, runId);
  expect(checkpoint).toMatchObject({ runId, status: "running" });
  assertAcceptedNode(project, runId, "seed", checkpoint.graph.nodes.seed, checkpoint.completedNodes, seed.callId);
  expect([...checkpoint.completedNodes].sort(compareStrings)).toEqual(["seed"]);
  expect(checkpoint.graph.nodes.a).toMatchObject({ phase: "active", attempt: 1, callId: a.callId });
  expect(checkpoint.graph.nodes.a?.accepted).toBeUndefined();
  expect(checkpoint.graph.nodes.b).toMatchObject({ phase: "not_started" });
  expect(checkpoint.graph.nodes.b?.callId).toBeUndefined();
  expect(checkpoint.graph.nodes.b?.attempt).toBe(0);
  expect(Object.keys(checkpoint.graph.pendingRequests ?? {})).toHaveLength(0);
  const events = readRunEvents(project, runId);
  expect(events.some((event) => event.event === "provider.call.started" && event.nodeId === "a" && event.callId === a.callId)).toBe(true);
  expect(events.some((event) => event.event === "provider.call.completed" && event.nodeId === "a" && event.callId === a.callId)).toBe(false);
  expect(events.some((event) => event.nodeId === "b" && (event.event === "provider.call.started" || event.event === "provider.call.completed"))).toBe(false);
  expect(seed.runId).toBe(runId);
}

function assertCheckpointAfterCrash(
  project: string,
  runId: string,
  seed: ProviderIdentity,
  a: ProviderIdentity,
): { runBytes: Buffer; eventBytes: Buffer; metricsBytes: Buffer } {
  assertCheckpointBeforeCrash(project, runId, seed, a);
  const runRoot = runDirectory(project, runId);
  const runBytes = readFileSync(path.join(runRoot, "run.json"));
  const eventBytes = readFileSync(path.join(runRoot, "events.jsonl"));
  const metricsBytes = readFileSync(path.join(runRoot, "metrics.json"));
  return { runBytes, eventBytes, metricsBytes };
}

function assertAcceptedNode(
  project: string,
  runId: string,
  nodeId: string,
  node: GraphNode | undefined,
  completedNodes: string[],
  acceptedCallId: string,
): void {
  const accepted = node?.accepted;
  if (!accepted) throw new Error(`PAR-036 accepted ${nodeId} evidence is missing.`);
  expect(node).toMatchObject({ phase: "accepted", callId: acceptedCallId, attempt: 1 });
  expect(accepted).toMatchObject({ callId: acceptedCallId, attempt: 1 });
  expect(completedNodes.filter((completed) => completed === nodeId)).toHaveLength(1);
  expect(accepted.artifacts).toHaveLength(1);
  const references = [accepted.resultRef, accepted.validationRef, accepted.responseRef, ...accepted.artifacts.map(({ ref }) => ref)];
  const hashes = [accepted.resultSha256, accepted.validationSha256, accepted.responseSha256, ...accepted.artifacts.map(({ sha256 }) => sha256)];
  expect(references).toHaveLength(hashes.length);
  const runRoot = runDirectory(project, runId);
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const hash = hashes[index];
    if (typeof reference !== "string" || typeof hash !== "string") throw new Error(`PAR-036 ${nodeId} accepted evidence contains an invalid file reference.`);
    assertSafeRunReference(reference);
    const file = path.resolve(runRoot, reference);
    if (path.relative(runRoot, file).startsWith("..")) throw new Error(`PAR-036 ${nodeId} evidence reference escapes its owned run directory.`);
    const bytes = readFileSync(file);
    if (bytes.byteLength > maxControlBytes) throw new Error(`PAR-036 ${nodeId} accepted evidence file exceeded its bounded size.`);
    expect(digest(bytes)).toBe(hash);
  }
}

function captureDurableRunBytes(runRoot: string): { runBytes: Buffer; eventBytes: Buffer; metricsBytes: Buffer; inputBytes: Buffer } {
  return {
    runBytes: readFileSync(path.join(runRoot, "run.json")),
    eventBytes: readFileSync(path.join(runRoot, "events.jsonl")),
    metricsBytes: readFileSync(path.join(runRoot, "metrics.json")),
    inputBytes: readFileSync(path.join(runRoot, "inputs.json")),
  };
}

function hasNaturalInitialDriverDrain(handle: TrackedChild, nonce: string): boolean {
  if (handle.outputOverflow || handle.stdinError) return false;
  try {
    const envelope = parseSingleJsonLine<InitialDriverEnvelope>(captureText(handle.stdout), "initial public driver completion evidence");
    if (envelope.protocol !== "par-036-crash-driver-v1" || envelope.operation !== "initial" || envelope.nonce !== nonce) return false;
    if (envelope.publicStarted !== false || envelope.childObservationFailure !== false) return false;
    const observations = envelope.observations;
    if (!observations || observations.overflow !== false
      || !Array.isArray(observations.availability) || observations.availability.length !== 0
      || !Array.isArray(observations.invocations) || observations.invocations.length !== 0
      || !Array.isArray(observations.repairs) || observations.repairs.length !== 0) return false;
    return Array.isArray(envelope.childProcesses) && envelope.childProcesses.length === 0
      && Array.isArray(envelope.delegatedOperations) && envelope.delegatedOperations.length === 0;
  } catch { return false; }
}

function hasObservedAInference(handle: TrackedChild): boolean {
  if (handle.outputOverflow) return false;
  try {
    const envelope = parseSingleJsonLine<InitialDriverEnvelope>(captureText(handle.stdout), "initial A invocation evidence");
    return envelope.childProcesses?.some((child) => child.nodeId === "a" && child.operation === "invoke") === true
      || envelope.delegatedOperations?.some((operation) => operation.nodeId === "a" && operation.operation === "invoke") === true;
  } catch { return false; }
}

function spawnNativePinHelper(
  handles: TrackedChild[],
  pins: NativePin[],
  label: string,
  stateDirectory: string,
  deadline: number,
  recordStage: StageRecorder,
): NativePin {
  if (process.platform !== "win32") throw new Error("PAR-036 native handle pins are Windows-only.");
  const controlDirectory = path.join(stateDirectory, `pin-${label}`);
  const nonce = randomUUID();
  mkdirSync(controlDirectory, { recursive: false });
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof systemRoot !== "string" || systemRoot.length === 0) throw new Error("PAR-036 could not resolve the Windows system directory for its native pin helper.");
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  assertBeforeDeadline(deadline, `${label} native pin helper launch`);
  const child = startTrackedChild(handles, "pin-helper", powershell, [
    "-NoProfile", "-NonInteractive", "-File", pinFixture,
    "-ControlDirectory", controlDirectory, "-Nonce", nonce, "-WatchdogMilliseconds", String(fixtureLifetimeMs),
  ], controlDirectory);
  const pin: NativePin = { controlDirectory, nonce, child, requestSent: false, pinReady: false, normalDrainVerified: false };
  pins.push(pin);
  recordStage("pin-helper-spawned", { label, nonce, helperPid: child.child.pid ?? null });
  return pin;
}

async function requestNativePin(pin: NativePin, targetPid: number, deadline: number, recordStage: StageRecorder): Promise<void> {
  const label = path.basename(pin.controlDirectory);
  if (!isSafePid(targetPid)) throw new Error(`PAR-036 ${label} has no positive safe target identity.`);
  if (pin.requestSent || pin.targetPid !== undefined) throw new Error(`PAR-036 ${label} already has a target request.`);
  assertBeforeDeadline(deadline, `${label} native pin helper startup`);
  const ready = await waitForJson<Record<string, unknown>>(joinControl(pin.controlDirectory, "helper-ready.json"), `${label} native pin helper startup`, deadline, pin.child);
  expect(ready).toMatchObject({ pid: pin.child.child.pid, nonce: pin.nonce });
  recordStage("pin-helper-ready", { label, nonce: pin.nonce, helperPid: pin.child.child.pid ?? null });
  writeJsonExclusive(joinControl(pin.controlDirectory, "pin-request.json"), { rootPid: targetPid, nonce: pin.nonce });
  pin.targetPid = targetPid;
  pin.requestSent = true;
  recordStage("pin-request", { label, nonce: pin.nonce, helperPid: pin.child.child.pid ?? null, targetPid });
  const pinned = await waitForJson<Record<string, unknown>>(joinControl(pin.controlDirectory, "pin-ready.json"), `${label} native handle pin readiness`, deadline, pin.child);
  expect(pinned).toMatchObject({ helperPid: pin.child.child.pid, rootPid: targetPid, handlePid: targetPid, exitCode: 259, nonce: pin.nonce });
  pin.pinReady = true;
  recordStage("pin-ready", { label, nonce: pin.nonce, helperPid: pin.child.child.pid ?? null, targetPid, exitCode: pinned.exitCode });
}

async function abortOwnedPinHelper(pin: NativePin, deadline: number, cleanupErrors: Error[], recordStage: StageRecorder): Promise<boolean> {
  if (pin.child.closeObserved) return false;
  let abortIssued = false;
  try {
    if (!isSafePid(pin.child.child.pid)) throw new Error(`PAR-036 ${path.basename(pin.controlDirectory)} helper has no safe owned ChildProcess PID for cleanup abort.`);
    if (deadline <= Date.now()) throw new Error(`PAR-036 shared cleanup deadline expired before ${path.basename(pin.controlDirectory)} helper abort could be safely observed.`);
    let killRequested = false;
    if (pin.child.child.exitCode === null && pin.child.child.signalCode === null) {
      abortIssued = true;
      killRequested = pin.child.child.kill("SIGKILL");
      recordStage("pin-helper-abort", { nonce: pin.nonce, helperPid: pin.child.child.pid, killRequested });
    }
    const close = await waitForChildClose(pin.child, deadline, `${path.basename(pin.controlDirectory)} failure-only helper abort close`);
    if (close.error) throw close.error;
    recordStage("pin-helper-abort-closed", { nonce: pin.nonce, helperPid: pin.child.child.pid, exitCode: close.code, signal: close.signal });
  } catch (error) {
    cleanupErrors.push(asError(error));
    recordStage("pin-helper-abort-unverified", { nonce: pin.nonce, helperPid: pin.child.child.pid ?? null, error: boundedDiagnosticError(error) });
  }
  return abortIssued;
}

async function releaseAndVerifyPin(pin: NativePin, deadline: number, recordStage?: StageRecorder): Promise<void> {
  const targetPid = pin.targetPid;
  if (!isSafePid(targetPid)) throw new Error(`PAR-036 ${path.basename(pin.controlDirectory)} pin has no verified target identity.`);
  const exitedPath = joinControl(pin.controlDirectory, "root-exited.json");
  if (!existsSync(exitedPath)) throw new Error(`PAR-036 ${path.basename(pin.controlDirectory)} pin cannot be released before native target exit is observed.`);
  const rootExited = readJson<Record<string, unknown>>(exitedPath);
  expect(rootExited).toMatchObject({ nonce: pin.nonce, rootPid: targetPid, handlePid: targetPid });
  expect(Number.isSafeInteger(rootExited.exitCode)).toBe(true);
  expect(rootExited.exitCode).not.toBe(259);
  const releasePath = joinControl(pin.controlDirectory, "release-pin");
  if (!existsSync(releasePath)) writeReleaseMarker(releasePath, pin.nonce);
  const helperClosed = await waitForJson<Record<string, unknown>>(joinControl(pin.controlDirectory, "helper-closed.json"), `${path.basename(pin.controlDirectory)} native handle close evidence`, deadline, pin.child);
  expect(helperClosed).toMatchObject({ pid: pin.child.child.pid, rootPid: targetPid, handleClosed: true, nonce: pin.nonce });
  const close = await waitForChildClose(pin.child, deadline, `${path.basename(pin.controlDirectory)} helper process close`);
  expect(close.error).toBeUndefined();
  expect(close.code).toBe(0);
  expect(close.signal).toBeNull();
  expect(pin.child.outputOverflow).toBe(false);
  expect(pin.child.stdinError).toBeUndefined();
  pin.normalDrainVerified = true;
  recordStage?.("pin-helper-closed", { nonce: pin.nonce, helperPid: pin.child.child.pid ?? null, targetPid, exitCode: close.code, signal: close.signal });
}

async function waitForProcessGroupGone(processGroupId: number, deadline: number): Promise<void> {
  if (!isSafePid(processGroupId)) throw new Error("PAR-036 refused to query an invalid process-group identity.");
  let attempts = 0;
  while (isProcessGroupPresent(processGroupId)) {
    if (attempts++ >= maxProcessTreeAttempts) throw new Error("PAR-036 POSIX process group did not disappear within the bounded poll count.");
    assertBeforeDeadline(deadline, "actual detached provider process-group drain");
    await wait(10);
  }
}

function isProcessGroupPresent(processGroupId: number): boolean {
  try { process.kill(-processGroupId, 0); return true; }
  catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

async function waitForChildClose(child: TrackedChild, deadline: number, description: string): Promise<ChildClose> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`PAR-036 shared deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.close,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`PAR-036 shared deadline expired during ${description}.`)), remaining); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function waitForAllChildren(handles: TrackedChild[], deadline: number): Promise<void> {
  while (true) {
    const observed = handles.length;
    const open = handles.filter((handle) => !handle.closeObserved);
    if (open.length === 0 && handles.length === observed) return;
    await Promise.all(open.map((handle) => waitForChildClose(handle, deadline, `${handle.role} close`)));
    if (handles.length === observed && handles.every((handle) => handle.closeObserved)) return;
  }
}

function readResumeEnvelope(handle: TrackedChild, nonce: string): ResumeEnvelope {
  if (handle.outputOverflow) throw new Error("PAR-036 fresh resume driver output exceeded the complete-envelope limit.");
  if (handle.stdinError) throw new Error(`PAR-036 fresh resume driver stdin close failed: ${handle.stdinError.message}`);
  const stdout = captureText(handle.stdout);
  const envelope = parseSingleJsonLine<ResumeEnvelope>(stdout, "fresh public resume driver result");
  expect(envelope.nonce).toBe(nonce);
  expect(envelope.protocol).toBe("par-033-fresh-resume-driver-v1");
  expect(envelope.operation).toBe("partial");
  return envelope;
}

function snapshotTree(root: string): ProcessTreeSnapshot {
  const snapshot = new Map<string, string>();
  let totalBytes = 0;
  let totalEntries = 0;
  const visit = (directory: string, relative: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      if (++totalEntries > maxSnapshotEntries) throw new Error("PAR-036 evidence snapshot exceeded its entry bound.");
      const child = path.join(directory, entry.name);
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        snapshot.set(`${childRelative}/`, "directory");
        visit(child, childRelative);
      } else if (entry.isFile()) {
        const bytes = readFileSync(child);
        totalBytes += bytes.byteLength;
        if (totalBytes > maxSnapshotBytes) throw new Error("PAR-036 evidence snapshot exceeded its byte bound.");
        snapshot.set(childRelative, `file:${digest(bytes)}:${bytes.byteLength}`);
      } else {
        throw new Error(`PAR-036 refuses to snapshot non-file evidence entry '${childRelative}'.`);
      }
    }
  };
  visit(root, "");
  return snapshot;
}

function assertSafeRunReference(reference: string): void {
  if (path.isAbsolute(reference) || reference.includes("\0")) throw new Error("PAR-036 accepted evidence contains an absolute or invalid run reference.");
  const segments = reference.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === ".." || segment.length === 0)) throw new Error("PAR-036 accepted evidence reference escapes its run root.");
}

function readCheckpoint(project: string, runId: string): RunCheckpoint {
  return readJson(path.join(runDirectory(project, runId), "run.json")) as RunCheckpoint;
}

function readRunEvents(project: string, runId: string): Array<Record<string, unknown>> {
  const bytes = readFileSync(path.join(runDirectory(project, runId), "events.jsonl"));
  if (bytes.byteLength > maxControlBytes) throw new Error("PAR-036 run event stream exceeded its bounded read size.");
  return bytes.toString("utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readFixtureEvents(file: string): Array<Record<string, unknown> & { role?: string; stage?: string; callId?: string }> {
  const bytes = readFileSync(file);
  if (bytes.byteLength > maxControlBytes) throw new Error("PAR-036 fixture event stream exceeded its bounded read size.");
  return bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown> & { role?: string; stage?: string; callId?: string });
}

function readJson<T = Record<string, unknown>>(file: string): T {
  const bytes = readFileSync(file);
  if (bytes.byteLength > maxControlBytes) throw new Error(`PAR-036 control file '${path.basename(file)}' exceeded its safe read limit.`);
  return JSON.parse(bytes.toString("utf8")) as T;
}

function writeJsonExclusive(file: string, value: unknown): void {
  const bytes = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > maxControlBytes) throw new Error("PAR-036 control marker exceeded its write bound.");
  writeFileSync(file, bytes, { encoding: "utf8", flag: "wx" });
}

function writeReleaseMarker(file: string, nonce: string): void {
  if (existsSync(file)) {
    expect(readJson(file)).toMatchObject({ nonce });
    return;
  }
  writeJsonExclusive(file, { nonce });
}

function joinControl(directory: string, name: string): string {
  return path.join(directory, name);
}

function runDirectory(project: string, runId: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(runId)) throw new Error("PAR-036 run ID is not a UUID-shaped runtime identity.");
  return path.join(project, ".nodulus", "runs", runId);
}

function parseSingleJsonLine<T>(text: string, description: string): T {
  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.length !== 2 || lines[1] !== "" || lines[0] === "") throw new Error(`PAR-036 ${description} did not contain exactly one complete JSON line.`);
  return JSON.parse(lines[0]!) as T;
}

function captureText(handle: Buffer[]): string {
  return Buffer.concat(handle).toString("utf8");
}

function boundedError(error: Error): Error {
  return new Error(`${error.name.slice(0, 80)}: ${error.message.slice(0, 700)}`);
}

function boundedDiagnosticError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name.slice(0, 80), message: error.message.slice(0, 500) };
  if (typeof error === "string") return { name: "ThrownString", message: error.slice(0, 500) };
  return { name: typeof error, message: "Non-Error diagnostic value." };
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const nativeTemp = realpathSync.native(tmpdir());
  const current = realpathSync.native(project);
  if (current !== identity || path.dirname(identity) !== nativeTemp || !path.basename(identity).startsWith(`nodulus-${label}-`)) {
    throw new Error("PAR-036 refused cleanup outside its exact native temporary project.");
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isSafePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function assertBeforeDeadline(deadline: number, operation: string): void {
  if (Date.now() >= deadline) throw new Error(`PAR-036 shared 20s scenario deadline expired during ${operation}.`);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("PAR-036 cleanup failed with a non-Error value.");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

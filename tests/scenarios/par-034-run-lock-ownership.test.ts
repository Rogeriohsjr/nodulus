import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { runWorkflow, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type RunResult = Awaited<ReturnType<typeof runWorkflow>>;
type PublicOutcome = { kind: "result"; result: RunResult } | { kind: "error"; error: unknown };
type DriverOutput = {
  kind: "result" | "error";
  nonce: string;
  result?: { status?: string; result?: unknown };
  error?: { name: string; code: string | null; message: string };
  activity: Record<string, number>;
  settled: { public: boolean; delegated: boolean };
};
type ChildClose = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
type TrackedChild = {
  role: "owner" | "resume" | "pin";
  child: ChildProcess;
  pid?: number;
  closed: Promise<ChildClose>;
  closeResult?: ChildClose;
  stdout: string;
  stderr: string;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  overflow: boolean;
};
type ProviderMarker = { nodeId: string; runId: string; callId: string; attempt: number; pid: number };
type LockOwnerReady = { pid: number; runId: string; nonce: string; lockPid: number; token: string };
type PinMarker = { helperPid: number; rootPid: number; handlePid: number; exitCode: number; nonce: string };
type RunFile = { relative: string; bytes: Buffer };
type GraphCheckpoint = {
  runId: string;
  status: string;
  graph: {
    nodes: Record<string, { phase?: string; callId?: string; attempt?: number; accepted?: {
      resultRef: string; resultSha256: string; responseRef: string; responseSha256: string;
      validationRef: string; validationSha256: string; artifacts: Array<{ ref: string; sha256: string }>;
    } }>;
    pendingRequests: Record<string, { nodeId?: string; kind?: string; attempt?: number; requestRef?: string; requestSha256?: string; answerRef?: string; answerSha256?: string }>;
  };
};
type CapturedQuestion = { id: string; nodeId: string; attempt: number; callId: string; answerContract: unknown };

const fixtureSource = fileURLToPath(new URL("../fixtures/par-031-compatible-provider.mjs", import.meta.url));
const driverPath = fileURLToPath(new URL("../fixtures/par-034-run-lock-driver.mjs", import.meta.url));
const pinFixture = fileURLToPath(new URL("../fixtures/par-015-process-handle-pin.ps1", import.meta.url));
const roles = ["seed", "a", "b"] as const;
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const caseCeilingMs = 35_000;
const fixtureLifetimeMs = 60_000;
const profileTimeoutMs = 20_000;
const answerA = { aApproval: "A-approved" };
const emptyActivity = { availability: 0, invoke: 0, repairResponse: 0, telemetry: 0, launch: 0, legacyUsage: 0 };

test("PAR-034 distinguishes a live resume lock from an unreleased stale owner", async () => runScenario(), caseCeilingMs);

async function runScenario(): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = "par-034 run-lock café " + randomUUID();
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const controlDirectory = path.join(fixtureDirectory, "par-034-run-lock");
  const fixtureState = path.join(fixtureDirectory, "par-034-provider-state");
  const eventsPath = path.join(fixtureState, "events.jsonl");
  const startedPaths = Object.fromEntries(roles.map((role) => [role + "-1", path.join(fixtureState, role + "-1.started.json")]));
  const releasePaths = { a: path.join(fixtureState, "release-a"), b: path.join(fixtureState, "release-b") };
  const nonce = randomUUID();
  const children: TrackedChild[] = [];
  const cleanupErrors: Error[] = [];
  const observations = { delegated: [] as Promise<unknown>[] };
  let providerActivity: typeof emptyActivity = { ...emptyActivity };
  let owner: TrackedChild | undefined;
  let helper: TrackedChild | undefined;
  let ownerReady: LockOwnerReady | undefined;
  let pinReady: PinMarker | undefined;
  let initialRun: Promise<PublicOutcome> | undefined;
  let initialOutcome: PublicOutcome | undefined;
  let initialRunId: string | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;

  try {
    assertOwnedProject(project, projectIdentity, label);
    const configured = configureFixtureProject(project, eventsPath, fixtureState, startedPaths, releasePaths);
    const sentinels = configured.sentinels;
    const provider = observeDefaultProvider(project, observations, (activity) => { providerActivity = activity; });
    initialRun = capturePublic(runWorkflow(request(project), provider));
    void initialRun.then((outcome) => { initialOutcome = outcome; });

    const seedPromise = waitForMarker(startedPaths["seed-1"]!, "seed entry", scenarioDeadline, () => initialOutcome);
    const aPromise = waitForMarker(startedPaths["a-1"]!, "A entry", scenarioDeadline, () => initialOutcome);
    const bPromise = waitForMarker(startedPaths["b-1"]!, "B entry", scenarioDeadline, () => initialOutcome);
    const [seedMarker, aMarker, bMarker] = await withDeadline(Promise.all([seedPromise, aPromise, bPromise]), scenarioDeadline, "all initial provider entries");
    initialRunId = seedMarker.runId;
    expect(aMarker).toMatchObject({ nodeId: "a", runId: initialRunId, attempt: 1 });
    expect(bMarker).toMatchObject({ nodeId: "b", runId: initialRunId, attempt: 1 });
    expect(isProcessAlive(aMarker.pid), "A must still be executing at the real provider entry barrier.").toBe(true);
    expect(isProcessAlive(bMarker.pid), "B must still be executing at the real provider entry barrier.").toBe(true);
    expect(readCheckpoint(project, initialRunId).graph.nodes.seed?.accepted).toBeDefined();
    writeFileSync(releasePaths.a, "release\n", { encoding: "utf8", flag: "wx" });
    writeFileSync(releasePaths.b, "release\n", { encoding: "utf8", flag: "wx" });
    const initial = await withDeadline(initialRun, scenarioDeadline, "initial graph pause");
    expect(initial.kind).toBe("result");
    if (initial.kind !== "result") throw initial.error;
    expect(initial.result.status).toBe("needs_input");
    await withDeadline(Promise.all(observations.delegated), scenarioDeadline, "initial provider delegate settlement");

    const runRoot = runDirectory(project, initialRunId);
    const checkpoint = readCheckpoint(project, initialRunId);
    const acceptedSeed = checkpoint.graph.nodes.seed?.accepted;
    if (!acceptedSeed) throw new Error("PAR-034 initial graph omitted accepted seed evidence.");
    expect(checkpoint.status).toBe("needs_input");
    const pendingA = findPendingRequest(project, initialRunId, checkpoint, "a");
    const pendingB = findPendingRequest(project, initialRunId, checkpoint, "b");
    expect(pendingA.id).not.toBe(pendingB.id);
    expect(pendingA.answerContract).toEqual({
      type: "object",
      required: ["aApproval"],
      properties: { aApproval: { const: "A-approved", type: "string" } },
      additionalProperties: false,
    });
    expect(checkpoint.graph.nodes.a?.phase).toBe("pending");
    expect(checkpoint.graph.nodes.b?.phase).toBe("pending");
    expect(aMarker).toMatchObject({ callId: pendingA.callId, attempt: pendingA.attempt });
    expect(bMarker).toMatchObject({ callId: pendingB.callId, attempt: pendingB.attempt });
    for (const relative of [acceptedSeed.resultRef, acceptedSeed.responseRef, acceptedSeed.validationRef]) {
      expect(sha256(readFileSync(path.join(runRoot, relative)))).toBe(
        relative === acceptedSeed.resultRef ? acceptedSeed.resultSha256
          : relative === acceptedSeed.responseRef ? acceptedSeed.responseSha256 : acceptedSeed.validationSha256,
      );
    }
    for (const artifact of acceptedSeed.artifacts) {
      expect(sha256(readFileSync(path.join(runRoot, artifact.ref)))).toBe(artifact.sha256);
    }
    for (const pending of [pendingA, pendingB]) {
      const saved = checkpoint.graph.pendingRequests[pending.id];
      if (!saved?.requestRef || !saved.requestSha256) throw new Error("PAR-034 pending question omitted its committed ref/hash.");
      expect(sha256(readFileSync(path.join(runRoot, saved.requestRef)))).toBe(saved.requestSha256);
    }
    const inputsBeforeLock = readFileSync(path.join(runRoot, "inputs.json"));
    const metricsBeforeLock = readFileSync(path.join(runRoot, "metrics.json"));
    const eventsBeforeLock = readFileSync(path.join(runRoot, "events.jsonl"));
    const initialFixtureBytes = readFileSync(eventsPath);
    expect(readFixtureEvents(eventsPath).filter((event) => event.stage === "inference-completed")).toHaveLength(3);
    const metrics = JSON.parse(metricsBeforeLock.toString("utf8")) as Array<Record<string, unknown>>;
    const completedCallIds = [seedMarker.callId, aMarker.callId, bMarker.callId].sort(compareStrings);
    const metricCallIds = metrics.map((metric) => {
      if (typeof metric.callId !== "string") throw new Error("PAR-034 provider metric has no call identity.");
      return metric.callId;
    }).sort(compareStrings);
    expect(metricCallIds).toEqual(completedCallIds);
    for (const marker of [seedMarker, aMarker, bMarker]) {
      const callRequest = readJson(path.join(runRoot, "calls", marker.callId, "request.json"));
      expect(callRequest).toMatchObject({ callId: marker.callId, nodeId: marker.nodeId, attempt: marker.attempt });
      const transport = readJson(path.join(runRoot, "calls", marker.callId, "transport.json"));
      expect(transport).toMatchObject({ started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
    }
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);
    expect(providerActivity).toMatchObject({ availability: 3, invoke: 3, repairResponse: 0 });

    owner = await startDriver("owner", ["owner", project, initialRunId, controlDirectory, nonce], project, children);
    const ownerPid = actualPid(owner, "lock owner");
    ownerReady = await waitForJson<LockOwnerReady>(path.join(controlDirectory, "owner-ready.json"), scenarioDeadline, () => childDiagnostics(owner!));
    const lockPath = path.join(runRoot, ".resume.lock");
    const liveLockBytes = readFileSync(lockPath);
    const lockRecord = JSON.parse(liveLockBytes.toString("utf8")) as { pid?: unknown; token?: unknown };
    expect(ownerReady).toMatchObject({ pid: ownerPid, runId: initialRunId, nonce, lockPid: ownerPid });
    expect(ownerReady.token.length).toBeGreaterThan(0);
    expect(lockRecord).toEqual({ pid: ownerPid, token: ownerReady.token });
    expect(owner.closeResult).toBeUndefined();

    const beforeLiveRun = snapshotRunTree(project, initialRunId);
    const fixtureBeforeLiveResume = readFileSync(eventsPath);
    const liveResume = await runResumeChild(project, initialRunId, pendingA.id, nonce, scenarioDeadline, children);
    expect(liveResume.driverPid).not.toBe(ownerPid);
    expect(liveResume.output).toMatchObject({ kind: "error", nonce, error: { code: "RUN_LOCKED" } });
    expect(liveResume.output.activity).toEqual(emptyActivity);
    expect(snapshotRunTree(project, initialRunId)).toEqual(beforeLiveRun);
    expect(readFileSync(lockPath).equals(liveLockBytes)).toBe(true);
    expect(readFileSync(path.join(runRoot, "inputs.json")).equals(inputsBeforeLock)).toBe(true);
    expect(readFileSync(path.join(runRoot, "metrics.json")).equals(metricsBeforeLock)).toBe(true);
    expect(readFileSync(path.join(runRoot, "events.jsonl")).equals(eventsBeforeLock)).toBe(true);
    expect(readFileSync(eventsPath).equals(fixtureBeforeLiveResume)).toBe(true);
    expect(owner.closeResult).toBeUndefined();
    expect(owner.child.exitCode).toBeNull();
    expect(owner.child.signalCode).toBeNull();
    expect(isProcessAlive(ownerPid)).toBe(true);

    if (process.platform === "win32") {
      helper = await startPinHelper(controlDirectory, nonce, children);
      const helperPid = actualPid(helper, "native pin helper");
      await waitForJson(path.join(controlDirectory, "helper-ready.json"), scenarioDeadline, () => childDiagnostics(helper!));
      expect(readJson(path.join(controlDirectory, "helper-ready.json"))).toEqual({ pid: helperPid, nonce });
      expect(helper.child.exitCode).toBeNull();
      expect(isProcessAlive(helperPid)).toBe(true);
      if (owner.closeResult !== undefined || owner.child.exitCode !== null) throw new Error("PAR-034 owner exited before native pin acquisition.");
      writeAtomicJson(path.join(controlDirectory, "pin-request.json"), { rootPid: ownerPid, nonce });
      pinReady = await waitForJson<PinMarker>(path.join(controlDirectory, "pin-ready.json"), scenarioDeadline, () => childDiagnostics(helper!) + childDiagnostics(owner!));
      expect(pinReady).toEqual({ helperPid, rootPid: ownerPid, handlePid: ownerPid, exitCode: 259, nonce });
      expect(helper.closeResult).toBeUndefined();
      expect(existsSync(path.join(controlDirectory, "helper-closed.json"))).toBe(false);
      expect(existsSync(path.join(controlDirectory, "release-pin"))).toBe(false);
    }

    const ownerToStop = owner;
    expect(ownerToStop.child.kill("SIGKILL")).toBe(true);
    const ownerClose = await withDeadline(ownerToStop.closed, scenarioDeadline, "actual owner ChildProcess close");
    expect(ownerClose.error).toBeUndefined();
    expect(ownerClose).toMatchObject({ code: null, signal: "SIGKILL" });
    if (process.platform === "win32") {
      const exited = await waitForJson<{ helperPid: number; rootPid: number; handlePid: number; exitCode: number; nonce: string }>(path.join(controlDirectory, "root-exited.json"), scenarioDeadline, () => childDiagnostics(helper!) + childDiagnostics(ownerToStop));
      expect(exited).toMatchObject({ helperPid: actualPid(helper!, "native pin helper"), rootPid: ownerPid, handlePid: ownerPid, nonce });
      expect(Number.isSafeInteger(exited.exitCode)).toBe(true);
      expect(exited.exitCode).not.toBe(259);
      expect(helper?.closeResult).toBeUndefined();
      expect(isProcessAlive(actualPid(helper!, "native pin helper"))).toBe(true);
      expect(existsSync(path.join(controlDirectory, "helper-closed.json"))).toBe(false);
      expect(existsSync(path.join(controlDirectory, "release-pin"))).toBe(false);
    }
    expect(readFileSync(lockPath).equals(liveLockBytes)).toBe(true);
    expect(snapshotRunTree(project, initialRunId)).toEqual(beforeLiveRun);
    expect(readFileSync(path.join(runRoot, "inputs.json")).equals(inputsBeforeLock)).toBe(true);
    expect(readFileSync(path.join(runRoot, "metrics.json")).equals(metricsBeforeLock)).toBe(true);
    expect(readFileSync(path.join(runRoot, "events.jsonl")).equals(eventsBeforeLock)).toBe(true);
    const beforeStaleResume = snapshotRunTree(project, initialRunId);
    const staleResume = await runResumeChild(project, initialRunId, pendingA.id, nonce, scenarioDeadline, children);
    expect(staleResume.child).not.toBe(liveResume.child);
    expect(staleResume.child.closeResult).toMatchObject({ code: 0, signal: null });
    expect(staleResume.output).toMatchObject({ kind: "error", nonce, error: { code: "RUN_RECOVERY_REQUIRED" } });
    expect(staleResume.output.activity).toEqual(emptyActivity);
    expect(snapshotRunTree(project, initialRunId)).toEqual(beforeStaleResume);
    expect(readFileSync(lockPath).equals(liveLockBytes)).toBe(true);
    expect(readFileSync(eventsPath).equals(fixtureBeforeLiveResume)).toBe(true);
    expect(readFileSync(eventsPath).equals(initialFixtureBytes)).toBe(true);
    const afterStale = readCheckpoint(project, initialRunId);
    expect(afterStale.status).toBe("needs_input");
    expect(afterStale.graph.pendingRequests[pendingA.id]?.answerRef).toBeUndefined();
    expect(afterStale.graph.pendingRequests[pendingB.id]?.answerRef).toBeUndefined();

    if (helper && pinReady) {
      writeAtomicJson(path.join(controlDirectory, "release-pin"), { nonce });
      const close = await withDeadline(helper.closed, scenarioDeadline, "native pin helper close after stale assertion");
      expect(close.code).toBe(0);
      expect(close.error).toBeUndefined();
      expect(readJson(path.join(controlDirectory, "helper-closed.json"))).toMatchObject({ pid: actualPid(helper, "native pin helper"), rootPid: ownerPid, handleClosed: true, nonce });
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
  if (owner && owner.closeResult === undefined) {
    try {
      if (ownerReady) writeAtomicJson(path.join(controlDirectory, "owner-release.json"), { pid: ownerReady.pid, nonce });
      if (!await settlesBefore(owner.closed, cleanupDeadline, 750)) owner.child.kill("SIGKILL");
      await withDeadline(owner.closed, cleanupDeadline, "owner close during cleanup");
    } catch (error) { cleanupErrors.push(asError(error)); }
  }
  if (helper && helper.closeResult === undefined) {
    try {
      if (pinReady) {
        const rootExitedPath = path.join(controlDirectory, "root-exited.json");
        if (!existsSync(rootExitedPath)) {
          if (!owner?.closeResult) throw new Error("PAR-034 will not release a native pin before owner close is confirmed.");
          await waitForJson(rootExitedPath, cleanupDeadline, () => childDiagnostics(helper!));
        }
        if (!existsSync(path.join(controlDirectory, "release-pin"))) writeAtomicJson(path.join(controlDirectory, "release-pin"), { nonce });
      } else {
        if (!existsSync(path.join(controlDirectory, "stop-helper"))) writeAtomicJson(path.join(controlDirectory, "stop-helper"), { nonce });
        if (!existsSync(path.join(controlDirectory, "release-pin"))) writeAtomicJson(path.join(controlDirectory, "release-pin"), { nonce });
      }
      const helperClose = await withDeadline(helper.closed, cleanupDeadline, "pin helper close during cleanup");
      if (helperClose.error) cleanupErrors.push(helperClose.error);
      if (helperClose.code !== 0) cleanupErrors.push(new Error("PAR-034 native pin helper did not exit successfully during cleanup."));
      expect(readJson(path.join(controlDirectory, "helper-closed.json"))).toMatchObject({ pid: actualPid(helper, "native pin helper"), handleClosed: true, nonce });
    } catch (error) { cleanupErrors.push(asError(error)); }
  }
  if (initialRun) {
    try { await withDeadline(initialRun, cleanupDeadline, "initial public workflow settlement"); }
    catch (error) { cleanupErrors.push(asError(error)); }
  }
  try { await withDeadline(Promise.all(observations.delegated), cleanupDeadline, "provider delegate settlement"); }
  catch (error) { cleanupErrors.push(asError(error)); }
  for (const process of children) {
    if (process.closeResult !== undefined) continue;
    try {
      if (process.role === "resume") process.child.kill("SIGKILL");
      if (process.role === "owner" && ownerReady) {
        const releasePath = path.join(controlDirectory, "owner-release.json");
        if (!existsSync(releasePath)) writeAtomicJson(releasePath, { pid: ownerReady.pid, nonce });
      }
      await withDeadline(process.closed, cleanupDeadline, process.role + " child close during cleanup");
    } catch (error) { cleanupErrors.push(asError(error)); }
  }
  const allOwnedClosed = children.every((child) => child.closeResult !== undefined);
  if (!allOwnedClosed) cleanupErrors.push(new Error("PAR-034 could not confirm every owned driver and pin-helper close."));
  if (children.some((child) => child.overflow)) cleanupErrors.push(new Error("PAR-034 owned process exceeded its bounded stdio capture."));

  const canRemove = !hasPrimaryError && cleanupErrors.length === 0 && allOwnedClosed;
  if (canRemove) {
    try {
      assertOwnedProject(project, projectIdentity, label);
      assertCurrentProject(project, projectIdentity);
      rmSync(project, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(asError(error)); }
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "PAR-034 scenario and cleanup failed; evidence retained.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-034 cleanup failed; evidence retained.");
  if (!canRemove) throw new Error("PAR-034 retained the owned project because process cleanup was not fully verified.");
}

function configureFixtureProject(
  project: string,
  eventsPath: string,
  stateDirectory: string,
  startedPaths: Record<string, string>,
  releasePaths: { a: string; b: string },
): { sentinels: { providerSentinel: string; validatorSentinel: string } } {
  const sentinels = configureParallelProject(project);
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  copyFileSync(fixtureSource, path.join(fixtureDirectory, "par-031-compatible-provider.mjs"));
  writeFileSync(path.join(fixtureDirectory, "par-031-compatible-control.json"), JSON.stringify({
    mode: "codex",
    eventsPath: path.relative(project, eventsPath),
    fixtureLifetimeMs,
    startedPaths: Object.fromEntries(Object.entries(startedPaths).map(([key, value]) => [key, path.relative(project, value)])),
    releasePaths: Object.fromEntries(Object.entries(releasePaths).map(([key, value]) => [key, path.relative(project, value)])),
  }), "utf8");

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  const baseProfile = profiles.fixture ?? {};
  for (const role of roles) {
    const executable = path.join(fixtureDirectory, process.platform === "win32" ? "par-034-" + role + ".cmd" : "par-034-" + role + ".sh");
    if (process.platform === "win32") {
      writeFileSync(executable, "@echo off\r\n\"" + process.execPath + "\" \".nodulus\\fixtures\\par-031-compatible-provider.mjs\" \"" + role + "\" %*\r\nexit /b %ERRORLEVEL%\r\n", "utf8");
    } else {
      writeFileSync(executable, "#!/bin/sh\nexec " + shellQuote(process.execPath) + " '.nodulus/fixtures/par-031-compatible-provider.mjs' '" + role + "' \"$@\"\n", "utf8");
      chmodSync(executable, 0o755);
    }
    profiles[role] = { ...baseProfile, enabled: true, executable, kind: "codex", model: "par-034-" + role, timeoutMs: profileTimeoutMs, capabilities: [], sandbox: "read-only" };
  }
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["seed", "a", "b"];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { seed: [], a: ["seed"], b: ["seed"] };
  workflow.execution.resources = { seed: [], a: [], b: [] };
  workflow.outputs = [
    { name: "bFinal", from: "b.report", contract: "report.v1" },
    { name: "aFinal", from: "a.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  const template = readProjectJson(project, ".nodulus/nodes/prepare.json");
  for (const nodeId of roles) {
    const instruction = ".nodulus/instructions/" + nodeId + ".md";
    writeFileSync(path.join(project, instruction), "P4C2A lock instructions for " + nodeId + ".\n", "utf8");
    const inputs = nodeId === "seed" ? { request: { from: "request", contract: "request.v1" } }
      : { report: { from: "seed." + (nodeId === "a" ? "alpha" : "beta"), contract: "report.v1" } };
    writeJson(project, ".nodulus/nodes/" + nodeId + ".json", {
      ...template,
      id: nodeId,
      providerProfile: nodeId,
      instructions: [instruction],
      inputs,
      expectedOutputs: nodeId === "seed"
        ? [{ name: "alpha", contract: "report.v1" }, { name: "beta", contract: "report.v1" }]
        : [{ name: "report", contract: "report.v1" }],
    });
  }
  return { sentinels };
}

function observeDefaultProvider(project: string, observations: { delegated: Promise<unknown>[] }, update: (activity: typeof emptyActivity) => void): ProviderPort {
  const delegate = createDefaultProviderPort(project);
  const activity = { ...emptyActivity };
  const track = <T>(operation: T): T => {
    if (isThenable(operation)) observations.delegated.push(Promise.resolve(operation).then(() => undefined, () => undefined));
    return operation;
  };
  return {
    ...(delegate.isAvailable ? { async isAvailable(profile, options) { activity.availability += 1; update({ ...activity }); return track(delegate.isAvailable!(profile, options)); } } : {}),
    async invoke(invocation) { activity.invoke += 1; update({ ...activity }); return track(delegate.invoke(invocation)); },
    ...(delegate.repairResponse ? { async repairResponse(invocation, raw, errors) { activity.repairResponse += 1; update({ ...activity }); return track(delegate.repairResponse!(invocation, raw, errors)); } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall(callId) { activity.telemetry += 1; update({ ...activity }); return delegate.telemetryForCall!(callId); } } : {}),
    ...(delegate.launchForCall ? { launchForCall(callId) { activity.launch += 1; update({ ...activity }); return delegate.launchForCall!(callId); } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall() { activity.legacyUsage += 1; update({ ...activity }); return delegate.usageForLastCall!(); } } : {}),
  };
}

function capturePublic(promise: Promise<RunResult>): Promise<PublicOutcome> {
  return promise.then((result): PublicOutcome => ({ kind: "result", result }), (error: unknown): PublicOutcome => ({ kind: "error", error }));
}

function request(project: string) {
  return { projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline" as const, text: "Pause a real graph before checking run lock ownership." }] };
}

function startDriver(role: "owner" | "resume", args: string[], cwd: string, registry: TrackedChild[]): Promise<TrackedChild> {
  return startTrackedChild(role, process.execPath, [driverPath, ...args], cwd, registry);
}

function startPinHelper(controlDirectory: string, nonce: string, registry: TrackedChild[]): Promise<TrackedChild> {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return startTrackedChild("pin", powershell, ["-NoProfile", "-NonInteractive", "-File", pinFixture, "-ControlDirectory", controlDirectory, "-Nonce", nonce, "-WatchdogMilliseconds", String(fixtureLifetimeMs)], process.cwd(), registry);
}

async function startTrackedChild(role: TrackedChild["role"], executable: string, args: string[], cwd: string, registry: TrackedChild[]): Promise<TrackedChild> {
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  const tracked: TrackedChild = {
    role,
    child,
    ...(typeof pid === "number" ? { pid } : {}),
    closed: Promise.resolve({ code: null, signal: null }),
    stdout: "",
    stderr: "",
    stdoutChunks: [],
    stderrChunks: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    overflow: false,
  };
  tracked.closed = new Promise((resolve) => {
    let childError: Error | undefined;
    child.once("error", (error) => { childError = error; });
    child.stdout?.on("data", (chunk: Buffer) => {
      tracked.stdoutBytes += chunk.byteLength;
      if (tracked.stdoutBytes > 8000) tracked.overflow = true;
      else tracked.stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      tracked.stderrBytes += chunk.byteLength;
      if (tracked.stderrBytes > 8000) tracked.overflow = true;
      else tracked.stderrChunks.push(Buffer.from(chunk));
    });
    child.once("close", (code, signal) => {
      tracked.stdout = Buffer.concat(tracked.stdoutChunks).toString("utf8");
      tracked.stderr = Buffer.concat(tracked.stderrChunks).toString("utf8");
      tracked.closeResult = { code, signal, ...(childError === undefined ? {} : { error: childError }) };
      resolve(tracked.closeResult);
    });
  });
  registry.push(tracked);
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    await withDeadline(tracked.closed, Date.now() + 1000, "spawn-error child close");
    throw new Error("PAR-034 spawn failed before an actual child PID was assigned.");
  }
  return tracked;
}

async function runResumeChild(project: string, runId: string, requestId: string, nonce: string, deadline: number, children: TrackedChild[]): Promise<{ driverPid: number; child: TrackedChild; output: DriverOutput }> {
  const child = await startDriver("resume", ["resume", project, runId, requestId, JSON.stringify(answerA), nonce], project, children);
  const closed = await withDeadline(child.closed, deadline, "fresh public resume driver close");
  expect(closed.error).toBeUndefined();
  expect(closed.code).toBe(0);
  expect(child.overflow).toBe(false);
  expect(child.stdoutBytes).toBeLessThanOrEqual(8000);
  expect(child.stderrBytes).toBeLessThanOrEqual(8000);
  const lines = child.stdout.trim().split(/\r?\n/u);
  if (lines.length !== 1 || !lines[0]) throw new Error("PAR-034 resume driver did not return one bounded JSON envelope.");
  const output = JSON.parse(lines[0]) as DriverOutput;
  expect(child.stderr).toBe("");
  expect(output.nonce).toBe(nonce);
  expect(output.settled).toEqual({ public: true, delegated: true });
  if (!isRecord(output.activity)) throw new Error("PAR-034 resume driver omitted provider activity counts.");
  return { driverPid: actualPid(child, "resume driver"), child, output };
}

async function waitForMarker(file: string, description: string, deadline: number, outcome: () => PublicOutcome | undefined): Promise<ProviderMarker> {
  while (!existsSync(file)) {
    const settled = outcome();
    if (settled) throw new Error("PAR-034 initial graph settled before " + description + ": " + describeOutcome(settled));
    if (Date.now() >= deadline) throw new Error("PAR-034 scenario deadline expired waiting for " + description + ".");
    await delay(10);
  }
  const marker = JSON.parse(readFileSync(file, "utf8")) as ProviderMarker;
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0) throw new Error("PAR-034 " + description + " marker omitted its PID.");
  return marker;
}

async function waitForJson<T>(file: string, deadline: number, diagnostics: () => string): Promise<T> {
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(file, "utf8")) as T; }
    catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("PAR-034 timed out waiting for " + path.basename(file) + ". " + diagnostics());
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("PAR-034 deadline expired before " + description + ".");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("PAR-034 deadline expired during " + description + ".")), remaining); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function settlesBefore<T>(promise: Promise<T>, deadline: number, milliseconds: number): Promise<boolean> {
  const remaining = Math.min(milliseconds, deadline - Date.now());
  if (remaining <= 0) return false;
  return Promise.race([promise.then(() => true), delay(remaining).then(() => false)]);
}

function readCheckpoint(project: string, runId: string): GraphCheckpoint {
  return readJson(path.join(runDirectory(project, runId), "run.json")) as unknown as GraphCheckpoint;
}

function findPendingRequest(project: string, runId: string, checkpoint: GraphCheckpoint, nodeId: string): CapturedQuestion {
  const entry = Object.entries(checkpoint.graph.pendingRequests).find(([, value]) => value.nodeId === nodeId && value.answerRef === undefined);
  if (!entry) throw new Error("PAR-034 no unanswered request exists for node " + nodeId + ".");
  const [id, metadata] = entry;
  const node = checkpoint.graph.nodes[nodeId];
  if (!node || node.phase !== "pending" || !node.callId || !Number.isSafeInteger(node.attempt) ||
      metadata.kind !== "node" || metadata.attempt !== node.attempt || metadata.requestRef !== "pending/" + id + ".json" ||
      typeof metadata.requestSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(metadata.requestSha256)) {
    throw new Error("PAR-034 pending metadata does not identify the current node attempt.");
  }
  const requestBytes = readFileSync(path.join(runDirectory(project, runId), metadata.requestRef));
  if (sha256(requestBytes) !== metadata.requestSha256) throw new Error("PAR-034 pending request bytes do not match their checkpoint hash.");
  const request = JSON.parse(requestBytes.toString("utf8")) as Partial<CapturedQuestion>;
  if (!isUuid(id) || request.id !== id || request.nodeId !== nodeId || request.attempt !== metadata.attempt ||
      request.callId !== node.callId || typeof request.callId !== "string" ||
      typeof request.answerContract !== "object" || request.answerContract === null || Array.isArray(request.answerContract)) {
    throw new Error("PAR-034 pending request file does not match its committed runtime identity.");
  }
  return request as CapturedQuestion;
}

function runDirectory(project: string, runId: string): string { return path.join(project, ".nodulus", "runs", runId); }

function snapshotRunTree(project: string, runId: string): RunFile[] {
  const root = runDirectory(project, runId);
  const files: RunFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ relative: path.relative(root, absolute).replaceAll("\\", "/"), bytes: readFileSync(absolute) });
    }
  };
  visit(root);
  return files.sort((left, right) => compareStrings(left.relative, right.relative));
}

function readFixtureEvents(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readJson(file: string): Record<string, unknown> { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; }

function writeAtomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, file);
}

function childDiagnostics(child: TrackedChild): string {
  return JSON.stringify({ pid: child.pid, closed: child.closeResult !== undefined, stdoutBytes: child.stdoutBytes, stderrBytes: child.stderrBytes, overflow: child.overflow });
}

function describeOutcome(outcome: PublicOutcome): string {
  if (outcome.kind === "error") return outcome.error instanceof Error ? outcome.error.name + ": " + outcome.error.message.slice(0, 300) : "non-Error rejection";
  return "status=" + outcome.result.status;
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function assertOwnedProject(project: string, identity: string, label: string): void {
  const nativeTemp = realpathSync.native(os.tmpdir());
  const actualPrefix = "nodulus-" + label + "-";
  if (realpathSync.native(project) !== identity || path.dirname(identity) !== nativeTemp || !path.basename(identity).startsWith(actualPrefix)) {
    throw new Error("PAR-034 refused cleanup outside its exact native temporary project.");
  }
}

function actualPid(child: TrackedChild, description: string): number {
  if (typeof child.pid !== "number" || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error("PAR-034 " + description + " has no actual ChildProcess PID.");
  }
  return child.pid;
}

function assertCurrentProject(project: string, identity: string): void {
  if (realpathSync.native(project) !== identity) throw new Error("PAR-034 project identity changed before cleanup.");
}

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function isThenable(value: unknown): value is PromiseLike<unknown> { return isRecord(value) && typeof value.then === "function"; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value); }
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isRecord(error) || error.code !== "ESRCH"; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isAlreadyExists(error: unknown): boolean { return isRecord(error) && error.code === "EEXIST"; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error("PAR-034 cleanup failed with a non-Error value."); }
function compareStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

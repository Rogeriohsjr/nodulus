import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { runWorkflow, type ApplicationRunResult, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type StopMode = "inference" | "readiness";
type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult; processSnapshot: ProcessSnapshotResult }
  | { kind: "rejection"; error: unknown; processSnapshot: ProcessSnapshotResult };
type CapturedSignal = {
  operation: "availability" | "invoke";
  profile: string;
  nodeId?: string;
  callId?: string;
  signal?: AbortSignal;
  abortObserved: boolean;
  reason?: unknown;
};
type CheckpointNode = { phase?: string; callId?: string; launch?: boolean | null; attempt?: number; failure?: { code?: string; message?: string } };
type GraphCheckpoint = { graph: { nodes: Record<string, CheckpointNode> } };
type PidMarkers = { prepare: string; parent: string; descendant: string; readiness: string };
type ProcessSnapshot = { role: string; pid: number; alive: boolean };
type ProcessSnapshotResult = { processes: ProcessSnapshot[]; readError?: string };

const fixtureSource = fileURLToPath(new URL("../fixtures/par-015-default-codex.mjs", import.meta.url));
const testWatchdogMs = 30_000;
const markerWatchdogMs = 10_000;
const scenarioBudgetMs = 12_000;
const cleanupWatchdogMs = 15_000;
const prepareErrorCode = "P15_CONTROL_FAILURE";

function configureStopProject(project: string, mode: StopMode): void {
  configureParallelProject(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const stateDirectory = path.join(fixtureDirectory, "par-015-state");
  mkdirSync(stateDirectory, { recursive: true });
  const fixturePath = path.join(fixtureDirectory, "par-015-default-codex.mjs");
  writeFileSync(fixturePath, readFileSync(fixtureSource, "utf8"), "utf8");

  const roles = ["prepare", "left", "right"] as const;
  for (const role of roles) {
    const controlPath = path.join(fixtureDirectory, `par-015-${role}.json`);
    const eventPath = path.join(stateDirectory, `${role}.jsonl`);
    const control = {
      role,
      mode: role === "prepare" ? "held-error" : role === "left" ? (mode === "inference" ? "inference-tree" : "held-readiness") : "idle",
      stateDirectory,
      eventPath,
      prepareStartedPath: path.join(stateDirectory, "prepare-inference-started.json"),
      prepareReleasePath: path.join(stateDirectory, "release-prepare"),
      parentStartedPath: path.join(stateDirectory, "left-parent-started.json"),
      parentReleasePath: path.join(stateDirectory, "release-left-parent"),
      descendantStartedPath: path.join(stateDirectory, "left-descendant-started.json"),
      descendantReleasePath: path.join(stateDirectory, "release-left-descendant"),
      readinessStartedPath: path.join(stateDirectory, "left-readiness-started.json"),
      readinessReleasePath: path.join(stateDirectory, "release-left-readiness"),
      inferenceStartedPath: path.join(stateDirectory, "left-inference-started.json"),
      errorCode: prepareErrorCode,
    };
    writeFileSync(controlPath, JSON.stringify(control), "utf8");
    const wrapperPath = path.join(fixtureDirectory, process.platform === "win32" ? `par-015-${role}.cmd` : `par-015-${role}.sh`);
    if (process.platform === "win32") {
      writeFileSync(wrapperPath,
        `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-015-default-codex.mjs" ".nodulus\\fixtures\\par-015-${role}.json" ".nodulus\\fixtures\\par-015-state\\${role}.jsonl" %*\r\nexit /b %ERRORLEVEL%\r\n`,
        "utf8");
    } else {
      writeFileSync(wrapperPath,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-015-default-codex.mjs' '.nodulus/fixtures/par-015-${role}.json' '.nodulus/fixtures/par-015-state/${role}.jsonl' "$@"\n`,
        "utf8");
      // The actual provider adapter launches this local executable through runProcess.
      chmodSync(wrapperPath, 0o755);
    }

    const settings = readProjectJson(project, ".nodulus/settings.json");
    const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
    profiles[role] = {
      enabled: true,
      executable: wrapperPath,
      kind: "codex",
      model: role === "left" && mode === "readiness" ? "p15-left-readiness" : `p15-${role}`,
      timeoutMs: 5000,
      sandbox: "read-only",
    };
    writeJson(project, ".nodulus/settings.json", settings);
  }

  const workflow = readParallelWorkflow(project);
  workflow.nodes = [...roles];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { prepare: [], left: [], right: [] };
  workflow.execution.resources = { prepare: [], left: [], right: [] };
  workflow.outputs = roles.map((id) => ({ name: `${id}Result`, from: `${id}.report`, contract: "report.v1" }));
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  for (const id of roles) {
    const node = readProjectJson(project, `.nodulus/nodes/${id}.json`);
    node.providerProfile = id;
    node.inputs = { request: { from: "request", contract: "request.v1" } };
    node.expectedOutputs = [{ name: "report", contract: "report.v1" }];
    writeJson(project, `.nodulus/nodes/${id}.json`, node);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function observeDefaultProvider(project: string): { provider: ProviderPort; observations: CapturedSignal[]; drain(deadline: number): Promise<void> } {
  const delegate = createDefaultProviderPort(project);
  const observations: CapturedSignal[] = [];
  const pending = new Set<Promise<unknown>>();
  const record = (entry: Omit<CapturedSignal, "abortObserved">): CapturedSignal => {
    const observation: CapturedSignal = { ...entry, abortObserved: false };
    const signal = observation.signal;
    const onAbort = () => {
      observation.abortObserved = true;
      observation.reason = signal?.reason;
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    observations.push(observation);
    return observation;
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  const provider: ProviderPort = {
    isAvailable(profile, options) {
      record({ operation: "availability", profile: profileName(profile), signal: options?.signal });
      return track(Promise.resolve(delegate.isAvailable?.(profile, options) ?? false));
    },
    invoke(invocation: ProviderInvocation) {
      record({
        operation: "invoke",
        profile: profileName(invocation.providerProfile),
        nodeId: invocation.nodeId,
        callId: invocation.call?.callId,
        signal: invocation.signal,
      });
      return track(delegate.invoke(invocation));
    },
    telemetryForCall: (callId) => delegate.telemetryForCall?.(callId) ?? null,
    launchForCall: (callId) => delegate.launchForCall?.(callId) ?? null,
    usageForLastCall: () => delegate.usageForLastCall?.() ?? null,
  };
  return {
    provider,
    observations,
    async drain(deadline: number) {
      while (pending.size > 0) {
        if (Date.now() >= deadline) throw new Error(`P15 delegated provider operations did not drain: ${pending.size} pending.`);
        await withDeadline(Promise.allSettled([...pending]).then(() => undefined), deadline, "delegated provider operations");
      }
    },
  };
}

function profileName(profile: Record<string, unknown>): string {
  return typeof profile.model === "string" ? profile.model : "unknown";
}

function request(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Exercise a cooperative graph stop." }],
  };
}

function startRun(project: string, provider: ProviderPort, pidMarkers: PidMarkers): Promise<RunOutcome> {
  return runWorkflow(request(project), provider).then(
    (result) => ({ kind: "result", result, processSnapshot: captureProcessSnapshot(pidMarkers) }),
    (error: unknown) => ({ kind: "rejection", error, processSnapshot: captureProcessSnapshot(pidMarkers) }),
  );
}

async function exerciseCooperativeStop(mode: StopMode): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const project = createInitializedProject(`par-015-cooperative-${mode}`);
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "par-015-state");
  const rightEventPath = path.join(stateDirectory, "right.jsonl");
  const prepareStartedPath = path.join(stateDirectory, "prepare-inference-started.json");
  const prepareReleasePath = path.join(stateDirectory, "release-prepare");
  const parentStartedPath = path.join(stateDirectory, "left-parent-started.json");
  const parentReleasePath = path.join(stateDirectory, "release-left-parent");
  const descendantStartedPath = path.join(stateDirectory, "left-descendant-started.json");
  const descendantReleasePath = path.join(stateDirectory, "release-left-descendant");
  const readinessStartedPath = path.join(stateDirectory, "left-readiness-started.json");
  const readinessReleasePath = path.join(stateDirectory, "release-left-readiness");
  const leftInferenceStartedPath = path.join(stateDirectory, "left-inference-started.json");
  const pidMarkers: PidMarkers = {
    prepare: prepareStartedPath,
    parent: parentStartedPath,
    descendant: descendantStartedPath,
    readiness: readinessStartedPath,
  };
  let observed: ReturnType<typeof observeDefaultProvider> | undefined;
  let run: Promise<RunOutcome> | undefined;
  let outcome: RunOutcome | undefined;
  let primaryError: unknown;
  const cleanupErrors: Error[] = [];

  try {
    assertOwnedProject(project);
    configureStopProject(project, mode);
    assertScenarioTime(scenarioDeadline, "P15 project and fixture setup");
    observed = observeDefaultProvider(project);
    const currentRun = startRun(project, observed.provider, pidMarkers);
    run = currentRun;
    await waitForFile(prepareStartedPath, "prepare inference", scenarioDeadline);
    if (mode === "inference") {
      await waitForFile(parentStartedPath, "left inference parent", scenarioDeadline);
      await waitForFile(descendantStartedPath, "left inference descendant", scenarioDeadline);
      expectActiveProcesses(pidMarkers, ["prepare", "left-parent", "left-descendant"]);
      const leftInvocation = observed.observations.find((entry) => entry.operation === "invoke" && entry.nodeId === "left");
      expect(leftInvocation?.signal, "left must receive its graph-owned signal before prepare is released").toBeDefined();
    } else {
      await waitForFile(readinessStartedPath, "left login-status readiness probe", scenarioDeadline);
      expectActiveProcesses(pidMarkers, ["prepare", "left-readiness"]);
      expect(existsSync(leftInferenceStartedPath), "left must not enter inference while readiness is held").toBe(false);
      const leftReadiness = observed.observations.find((entry) => entry.operation === "availability" && entry.profile === "p15-left-readiness");
      expect(leftReadiness?.signal, "left readiness must receive its graph-owned signal before prepare is released").toBeDefined();
    }

    writeFileSync(prepareReleasePath, "release\n", "utf8");
    outcome = await withDeadline(currentRun, scenarioDeadline, "cooperative graph stop");
    assertReturnedProcesses(outcome.processSnapshot, mode === "inference"
      ? ["prepare", "left-parent", "left-descendant"]
      : ["prepare", "left-readiness"]);
    assertInitiatingFailure(outcome);
    const checkpoint = readCheckpoint(project, outcome.result.runId);
    const events = readEvents(project, outcome.result.runId);
    const prepareObservation = observed.observations.find((entry) => entry.operation === "invoke" && entry.nodeId === "prepare");
    const responseError = (outcome.result.result as { error?: { callId?: string; nodeId?: string; code?: string; launch?: boolean } }).error;
    expect(prepareObservation?.callId).toBeDefined();
    expect(responseError?.callId).toBe(prepareObservation?.callId);
    expect(checkpoint.graph.nodes.prepare.callId).toBe(prepareObservation?.callId);
    expect(checkpoint.graph.nodes.prepare).toMatchObject({ phase: "failed", failure: { code: prepareErrorCode } });
    expect(events.some((event) => event.event === "node.started" && event.nodeId === "right")).toBe(false);
    expect(observed.observations.some((entry) => entry.profile === "p15-right")).toBe(false);
    expect(existsSync(rightEventPath)).toBe(false);
    expect(events.some((event) => event.event === "node.accepted" && (event.nodeId === "left" || event.nodeId === "right"))).toBe(false);
    expect(events.filter((event) => event.event === "node.started" && (event.nodeId === "prepare" || event.nodeId === "left"))).toHaveLength(2);
    expect(events.some((event) => event.event === "node.failed" && event.nodeId === "left" && event.code === "GRAPH_CANCELLED")).toBe(true);
    expect(checkpoint.graph.nodes.right.phase).toBe("not_started");
    expect(checkpoint.graph.nodes.left).toMatchObject({ phase: "failed", failure: { code: "GRAPH_CANCELLED" } });
    expect(checkpoint.graph.nodes.left.attempt).toBe(1);
    const prepareNode = checkpoint.graph.nodes.prepare;
    expect(prepareNode.launch).toBe(true);
    expect(prepareNode.attempt).toBe(1);
    expect(readCallTransport(project, outcome.result.runId, prepareNode.callId ?? "")).toMatchObject({
      started: true,
      cancelled: false,
      timedOut: false,
      exitCode: 0,
    });
    const leftObservation = mode === "inference"
      ? observed.observations.find((entry) => entry.operation === "invoke" && entry.nodeId === "left")
      : observed.observations.find((entry) => entry.operation === "availability" && entry.profile === "p15-left-readiness");
    expect(leftObservation?.abortObserved).toBe(true);
    const reason = leftObservation?.reason;
    expect(reason).toMatchObject({
      source: "nodulus.graph",
      kind: "graph_stop",
      code: "GRAPH_CANCELLED",
      message: expect.any(String),
    });
    expect(typeof reason === "object" && reason !== null && "message" in reason && typeof reason.message === "string" && reason.message.length > 0).toBe(true);

    if (mode === "inference") {
      const leftNode = checkpoint.graph.nodes.left;
      const leftInvocation = observed.observations.find((entry) => entry.operation === "invoke" && entry.nodeId === "left");
      expect(leftInvocation?.callId).toBeDefined();
      expect(leftNode.callId).toBe(leftInvocation?.callId);
      expect(leftNode.launch).toBe(true);
      const transport = readCallTransport(project, outcome.result.runId, leftNode.callId ?? "");
      expect(transport).toMatchObject({ started: true, cancelled: true, timedOut: false });
    } else {
      const leftNode = checkpoint.graph.nodes.left;
      expect(leftNode.launch).toBe(false);
      expect(observed.observations.some((entry) => entry.operation === "invoke" && entry.nodeId === "left")).toBe(false);
      expect(existsSync(leftInferenceStartedPath)).toBe(false);
      expect(existsSync(callTransportPath(project, outcome.result.runId, leftNode.callId ?? ""))).toBe(false);
      expect(isProcessAlive(readPid(readinessStartedPath))).toBe(false);
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupDeadline = Date.now() + cleanupWatchdogMs;
  try { releaseAll([prepareReleasePath, parentReleasePath, descendantReleasePath, readinessReleasePath]); }
  catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  let runSettled = run === undefined || outcome !== undefined;
  if (run) {
    try {
      outcome ??= await withDeadline(run, cleanupDeadline, "owned run cleanup");
      runSettled = true;
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  let operationsDrained = observed === undefined;
  if (observed) {
    try {
      await observed.drain(cleanupDeadline);
      operationsDrained = true;
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  let processesExited = false;
  try {
    const pids = readOwnedProcesses(pidMarkers);
    processesExited = await waitForProcesses(pids.map(({ pid }) => pid), cleanupDeadline);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (runSettled && operationsDrained && processesExited) {
    try {
      assertOwnedProject(project);
      rmSync(path.resolve(project), { recursive: true, force: true });
    }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  } else {
    cleanupErrors.push(new Error(`P15 owned project retained because run/provider/process cleanup was uncertain: ${path.basename(project)}`));
  }

  if (primaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], "P15 scenario failed and cleanup reported additional diagnostics.");
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P15 scenario cleanup failed.");
}

function assertInitiatingFailure(outcome: RunOutcome): asserts outcome is Extract<RunOutcome, { kind: "result" }> {
  expect(outcome.kind).toBe("result");
  if (outcome.kind !== "result") throw outcome.error;
  expect(outcome.result).toMatchObject({
    status: "error",
    result: { error: { code: prepareErrorCode, nodeId: "prepare", callId: expect.any(String), launch: true } },
  });
}

function assertOwnedProject(project: string): void {
  const actualTemp = realpathSync(path.resolve(tmpdir()));
  const actualProject = realpathSync(path.resolve(project));
  const relative = path.relative(actualTemp, actualProject);
  if (path.dirname(actualProject) !== actualTemp || relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ||
      !path.basename(actualProject).startsWith("nodulus-par-015-cooperative-")) {
    throw new Error("P15 temporary project is outside its exact owned temp prefix.");
  }
}

function readCheckpoint(project: string, runId: string): GraphCheckpoint {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as GraphCheckpoint;
}

function readEvents(project: string, runId: string): Array<Record<string, unknown>> {
  const text = readFileSync(path.join(project, ".nodulus", "runs", runId, "events.jsonl"), "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function callTransportPath(project: string, runId: string, callId: string): string {
  return path.join(project, ".nodulus", "runs", runId, "calls", callId, "transport.json");
}

function readCallTransport(project: string, runId: string, callId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(callTransportPath(project, runId, callId), "utf8")) as Record<string, unknown>;
}

async function waitForFile(filePath: string, label: string, scenarioDeadline: number): Promise<void> {
  const deadline = Math.min(Date.now() + markerWatchdogMs, scenarioDeadline);
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`P15 timed out waiting for ${label} within the shared scenario budget.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function assertScenarioTime(deadline: number, label: string): void {
  if (Date.now() >= deadline) throw new Error(`P15 shared scenario budget expired during ${label}.`);
}

function readPid(filePath: string): number {
  const marker = JSON.parse(readFileSync(filePath, "utf8")) as { pid?: unknown };
  return checkedPid(marker.pid);
}

function checkedPid(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("P15 process marker contains an invalid process ID.");
  }
  return value;
}

function readOwnedProcesses(markers: PidMarkers): Array<{ role: string; pid: number }> {
  const owned: Array<{ role: string; pid: number }> = [];
  if (existsSync(markers.prepare)) owned.push({ role: "prepare", pid: readPid(markers.prepare) });
  let parentDescendantPid: number | undefined;
  if (existsSync(markers.parent)) {
    const parent = JSON.parse(readFileSync(markers.parent, "utf8")) as { pid?: unknown; descendantPid?: unknown };
    owned.push({ role: "left-parent", pid: checkedPid(parent.pid) });
    parentDescendantPid = checkedPid(parent.descendantPid);
    owned.push({ role: "left-descendant", pid: parentDescendantPid });
  }
  if (existsSync(markers.descendant)) {
    const descendantPid = readPid(markers.descendant);
    if (parentDescendantPid !== undefined && descendantPid !== parentDescendantPid) {
      throw new Error("P15 parent and descendant markers identify different processes.");
    }
    if (parentDescendantPid === undefined) owned.push({ role: "left-descendant", pid: descendantPid });
  }
  if (existsSync(markers.readiness)) owned.push({ role: "left-readiness", pid: readPid(markers.readiness) });
  return owned;
}

function captureProcessSnapshot(markers: PidMarkers): ProcessSnapshotResult {
  try {
    return { processes: readOwnedProcesses(markers).map(({ role, pid }) => ({ role, pid, alive: isProcessAlive(pid) })) };
  } catch (error) {
    return { processes: [], readError: error instanceof Error ? error.message : String(error) };
  }
}

function expectActiveProcesses(markers: PidMarkers, roles: string[]): void {
  const processes = readOwnedProcesses(markers);
  expect(processes.map(({ role }) => role).sort()).toEqual([...roles].sort());
  expect(processes.every(({ pid }) => isProcessAlive(pid))).toBe(true);
}

function assertReturnedProcesses(snapshot: ProcessSnapshotResult, roles: string[]): void {
  expect(snapshot.readError).toBeUndefined();
  expect(snapshot.processes.map(({ role }) => role).sort()).toEqual([...roles].sort());
  expect(snapshot.processes.every(({ alive }) => !alive)).toBe(true);
}

function isProcessAlive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd >= 0 && stat.slice(commandEnd + 1).trimStart()[0] === "Z") return false;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code))) return false;
    }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(typeof error === "object" && error !== null && "code" in error && String(error.code) === "ESRCH"); }
}

async function waitForProcesses(pids: number[], deadline: number): Promise<boolean> {
  while (pids.some(isProcessAlive)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

function releaseAll(paths: string[]): void {
  for (const releasePath of paths) {
    mkdirSync(path.dirname(releasePath), { recursive: true });
    writeFileSync(releasePath, "release\n", "utf8");
  }
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error(`P15 shared deadline expired before ${label} completed.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`P15 timed out waiting for ${label} after ${timeoutMs}ms.`)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("P15A in-flight default-provider sibling stops with its parent and descendant", async () => {
  await exerciseCooperativeStop("inference");
}, testWatchdogMs);

test("P15A default-provider readiness sibling stops before inference launch", async () => {
  await exerciseCooperativeStop("readiness");
}, testWatchdogMs);

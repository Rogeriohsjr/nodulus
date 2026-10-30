import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { runWorkflow, type ApplicationRunResult, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type FixtureEvent = { operation: string; stage: string; pid: number; at: number; ordinal?: number; agent?: string; session?: string };
type ObservedOperation = { operation: "availability" | "invoke" | "repair_response"; nodeId?: string; callId?: string; parentCallId?: string; signal?: AbortSignal };
type ProcessSnapshot = { operation: string; pid: number; alive: boolean; ordinal?: number; agent?: string };
type RunSnapshot = { operations: Array<{ operation: string; nodeId?: string; callId?: string; parentCallId?: string; aborted: boolean; reason?: unknown }>; processes: ProcessSnapshot[]; readError?: string };
type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult; snapshot: RunSnapshot }
  | { kind: "rejection"; error: unknown; snapshot: RunSnapshot };
type NativeRepairEvidence = {
  callId: string;
  error: unknown;
  errorCode?: string;
  errorMessage: string;
  signalAlreadyAbortedWhenNativeErrorArrived?: boolean;
  transport?: Record<string, unknown>;
  childPid?: number;
  childExitedBeforeProfileTimeout?: boolean;
  signalAbortedAfterChildExit?: boolean;
  receivedProfileTimeoutReason?: unknown;
  deliveredError?: unknown;
  evidenceError?: string;
};
type ObservedProvider = {
  provider: ProviderPort;
  operations: ObservedOperation[];
  nativeRepair?: NativeRepairEvidence;
  drain(deadline: number): Promise<void>;
};

const fixturePath = fileURLToPath(new URL("../fixtures/par-015-native-first-cause-cli.mjs", import.meta.url));
const fixtureLifetimeMs = 90_000;
const readinessProfileTimeoutMs = 60_000;
const repairProfileTimeoutMs = 20_000;
const scenarioBudgetMs = 40_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 55_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function configureProject(project: string, kind: "codex" | "opencode", timeoutMs: number): { eventsPath: string; releasePath: string; repairOutputReleasePath: string; heldMarkerPath: string; repairStartedPath: string } {
  configureParallelProject(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const eventsPath = path.join(fixtureDirectory, "par-015-native-events.jsonl");
  const releasePath = path.join(fixtureDirectory, "par-015-native-release.json");
  const repairOutputReleasePath = path.join(fixtureDirectory, "par-015-repair-output-release.json");
  const heldMarkerPath = path.join(fixtureDirectory, "auth-2-started.json");
  const repairStartedPath = path.join(fixtureDirectory, "repair-1-started.json");
  const configPath = path.join(fixtureDirectory, "par-015-native-control.json");
  copyFileSync(fixturePath, path.join(fixtureDirectory, "par-015-native-first-cause-cli.mjs"));
  const model = "p15b1b-native-fixture";
  writeFileSync(configPath, JSON.stringify({
    kind,
    model,
    eventsPath: path.relative(project, eventsPath),
    releasePath: path.relative(project, releasePath),
    repairOutputReleasePath: path.relative(project, repairOutputReleasePath),
    fixtureLifetimeMs,
    heldAuthOrdinal: 2,
  }), "utf8");

  const executable = process.platform === "win32"
    ? path.join(fixtureDirectory, "par-015-native-cli.cmd")
    : path.join(fixtureDirectory, "par-015-native-cli.sh");
  if (process.platform === "win32") {
    writeFileSync(executable,
      `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-015-native-first-cause-cli.mjs" ".nodulus\\fixtures\\par-015-native-control.json" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      "utf8");
  } else {
    writeFileSync(executable,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-015-native-first-cause-cli.mjs' '.nodulus/fixtures/par-015-native-control.json' "$@"\n`,
      "utf8");
    chmodSync(executable, 0o755);
  }

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  profiles.fixture = {
    enabled: true,
    executable,
    kind,
    model,
    timeoutMs,
    capabilities: kind === "opencode" ? ["responseRepair"] : [],
    sandbox: "read-only",
  };
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["prepare", "audit"];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { prepare: [], audit: ["prepare"] };
  workflow.execution.resources = { prepare: [], audit: [] };
  workflow.outputs = [
    { name: "prepared", from: "prepare.report", contract: "report.v1" },
    { name: "audited", from: "audit.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  const prepare = readProjectJson(project, ".nodulus/nodes/prepare.json");
  prepare.providerProfile = "fixture";
  prepare.inputs = { request: { from: "request", contract: "request.v1" } };
  prepare.expectedOutputs = [{ name: "report", contract: "report.v1" }];
  writeJson(project, ".nodulus/nodes/prepare.json", prepare);
  const audit = readProjectJson(project, ".nodulus/nodes/audit.json");
  audit.providerProfile = "fixture";
  audit.inputs = { report: { from: "prepare.report", contract: "report.v1" } };
  audit.expectedOutputs = [{ name: "report", contract: "report.v1" }];
  writeJson(project, ".nodulus/nodes/audit.json", audit);
  return { eventsPath, releasePath, repairOutputReleasePath, heldMarkerPath, repairStartedPath };
}

function request(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Exercise native first-cause preservation in a real graph provider operation." }],
  };
}

function fixtureEvents(eventsPath: string): FixtureEvent[] {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
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

function captureSnapshot(eventsPath: string, operations: ObservedOperation[]): RunSnapshot {
  const snapshot: RunSnapshot = {
    operations: operations.map(({ operation, nodeId, callId, parentCallId, signal }) => ({
      operation,
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(callId === undefined ? {} : { callId }),
      ...(parentCallId === undefined ? {} : { parentCallId }),
      aborted: signal?.aborted ?? false,
      ...(signal?.aborted ? { reason: signal.reason } : {}),
    })),
    processes: [],
  };
  try {
    const events = fixtureEvents(eventsPath);
    snapshot.processes = events.filter(({ stage }) => stage === "started").map(({ operation, pid, ordinal, agent }) => ({
      operation,
      pid,
      alive: isProcessAlive(pid),
      ...(ordinal === undefined ? {} : { ordinal }),
      ...(agent === undefined ? {} : { agent }),
    }));
  } catch (error) {
    snapshot.readError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
  return snapshot;
}

function startRun(project: string, eventsPath: string, observed: ObservedProvider): Promise<RunOutcome> {
  return runWorkflow(request(project), observed.provider).then(
    (result) => ({ kind: "result", result, snapshot: captureSnapshot(eventsPath, observed.operations) }),
    (error: unknown) => ({ kind: "rejection", error, snapshot: captureSnapshot(eventsPath, observed.operations) }),
  );
}

function observeProvider(project: string, eventsPath: string, releasePath: string, scenarioDeadline: number): ObservedProvider {
  const delegate = createDefaultProviderPort(project);
  const operations: ObservedOperation[] = [];
  const pending = new Set<Promise<unknown>>();
  const observed: ObservedProvider = {
    operations,
    provider: undefined as unknown as ProviderPort,
    async drain(deadline) {
      while (pending.size > 0) {
        if (Date.now() >= deadline) throw new Error(`P15B1b provider wrapper did not drain (${pending.size} active operations).`);
        await withDeadline(Promise.allSettled([...pending]).then(() => undefined), deadline, "provider wrapper drain");
      }
    },
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  observed.provider = {
    isAvailable(profile, options) {
      operations.push({ operation: "availability", signal: options?.signal });
      return track(Promise.resolve(delegate.isAvailable?.(profile, options) ?? false));
    },
    invoke(invocation: ProviderInvocation) {
      operations.push({
        operation: "invoke",
        nodeId: invocation.nodeId,
        callId: invocation.call?.callId,
        parentCallId: invocation.call?.parentCallId,
        signal: invocation.signal,
      });
      return track(delegate.invoke(invocation));
    },
    repairResponse(invocation, previousRawResponse, validationErrors) {
      operations.push({
        operation: "repair_response",
        nodeId: invocation.nodeId,
        callId: invocation.call?.callId,
        parentCallId: invocation.call?.parentCallId,
        signal: invocation.signal,
      });
      const operation = (async () => {
        try {
          if (!delegate.repairResponse) throw new Error("Default OpenCode adapter did not expose response repair.");
          return await delegate.repairResponse(invocation, previousRawResponse, validationErrors);
        } catch (error) {
          const callId = invocation.call?.callId ?? "missing-call-id";
          const evidence: NativeRepairEvidence = {
            callId,
            error,
            errorCode: typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined,
            errorMessage: error instanceof Error ? error.message : String(error),
            signalAlreadyAbortedWhenNativeErrorArrived: invocation.signal?.aborted ?? false,
          };
          try {
            const transportPath = path.join(project, ".nodulus", "runs", invocation.runId, "calls", callId, "transport.json");
            evidence.transport = JSON.parse(readFileSync(transportPath, "utf8")) as Record<string, unknown>;
            const events = fixtureEvents(eventsPath).filter(({ operation: eventOperation, stage }) => eventOperation === "repair" && stage === "started");
            const latestRepair = events.at(-1);
            if (latestRepair) {
              evidence.childPid = latestRepair.pid;
              await waitForPids([latestRepair.pid], scenarioDeadline);
              evidence.signalAbortedAfterChildExit = invocation.signal?.aborted ?? false;
              evidence.childExitedBeforeProfileTimeout = !isProcessAlive(latestRepair.pid) && !evidence.signalAbortedAfterChildExit;
            }
          } catch (evidenceError) {
            evidence.evidenceError = (evidenceError instanceof Error ? evidenceError.message : String(evidenceError)).slice(0, 500);
          }
          observed.nativeRepair = evidence;
          try {
    const reason = await waitForProfileTimeoutOrRelease(invocation.signal, releasePath, scenarioDeadline);
            evidence.receivedProfileTimeoutReason = reason;
          } catch (waitError) {
            evidence.evidenceError ??= (waitError instanceof Error ? waitError.message : String(waitError)).slice(0, 500);
          } finally {
            evidence.deliveredError = error;
          }
          throw error;
        }
      })();
      return track(operation);
    },
    telemetryForCall: (callId) => delegate.telemetryForCall?.(callId) ?? null,
    launchForCall: (callId) => delegate.launchForCall?.(callId) ?? null,
    usageForLastCall: () => delegate.usageForLastCall?.() ?? null,
  };
  return observed;
}

async function waitForProfileTimeoutOrRelease(signal: AbortSignal | undefined, releasePath: string, deadline: number): Promise<unknown> {
  if (signal?.aborted) return signal.reason;
  if (existsSync(releasePath)) return undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (poller !== undefined) clearInterval(poller);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = (): void => finish(signal?.reason);
    const poller = setInterval(() => { if (existsSync(releasePath)) finish(undefined); }, 20);
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("P15B1b wrapper reached its shared scenario deadline before profile timeout or cleanup release."));
    }, remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function waitForMarker(markerPath: string, outcome: () => RunOutcome | undefined, deadline: number): Promise<Record<string, unknown>> {
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    const settled = outcome();
    if (settled) throw new Error(`P15B1b run settled before fixture marker ${path.basename(markerPath)} (${describeOutcome(settled)}).`);
    await delay(20);
  }
  throw new Error(`P15B1b shared scenario budget expired waiting for ${path.basename(markerPath)}.`);
}

async function waitForPids(pids: number[], deadline: number): Promise<void> {
  while (pids.some(isProcessAlive)) {
    if (Date.now() >= deadline) throw new Error(`P15B1b fixture processes remain alive: ${pids.join(", ")}.`);
    await delay(20);
  }
}

async function waitForNativeRepairEvidence(observed: ObservedProvider, outcome: () => RunOutcome | undefined, deadline: number): Promise<NativeRepairEvidence> {
  while (Date.now() < deadline) {
    if (observed.nativeRepair) return observed.nativeRepair;
    const settled = outcome();
    if (settled) throw new Error(`P15B1b run settled before the repair error reached the observer (${describeOutcome(settled)}).`);
    await delay(20);
  }
  throw new Error("P15B1b shared scenario budget expired waiting for the native repair error.");
}

function describeOutcome(outcome: RunOutcome): string {
  if (outcome.kind === "rejection") return `rejected: ${String(outcome.error)}`;
  const result = outcome.result.result as { error?: { code?: string; message?: string } };
  return `${outcome.result.status}: ${result.error?.code ?? "no error code"} ${result.error?.message ?? ""}`;
}

function readCheckpoint(project: string, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, unknown>;
}

function readRunEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(project, ".nodulus", "runs", runId, "events.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertOwnedProject(project: string, label: string): void {
  const actualTemp = realpathSync.native(path.resolve(tmpdir()));
  const actualProject = realpathSync.native(path.resolve(project));
  const relative = path.relative(actualTemp, actualProject);
  if (path.dirname(actualProject) !== actualTemp || relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(actualProject).startsWith(`nodulus-${label}-`)) {
    throw new Error("P15B1b temporary project is outside its exact owned temp prefix.");
  }
}

function ownedPids(eventsPath: string): number[] {
  const events = fixtureEvents(eventsPath);
  const pids = events.filter(({ stage }) => stage === "started").map(({ pid }) => pid);
  if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("P15B1b event log contains an invalid process identity.");
  return [...new Set(pids)];
}

function stopPid(pid: number, deadline: number): void {
  if (!isProcessAlive(pid)) return;
  const timeout = Math.min(3000, deadline - Date.now());
  if (timeout <= 0) throw new Error("P15B1b shared cleanup deadline expired before stopping an owned process.");
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout });
    if (result.error) throw result.error;
  } else {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && String(error.code) === "ESRCH")) throw error;
    }
  }
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error(`P15B1b deadline expired before ${label}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`P15B1b timed out waiting for ${label}.`)), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function delay(ms: number): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, ms)); }

async function cleanupRun(project: string, label: string, paths: ReturnType<typeof configureProject>, run: Promise<RunOutcome> | undefined, observed: ObservedProvider, cleanupErrors: Error[]): Promise<void> {
  const deadline = Date.now() + cleanupBudgetMs;
  try {
    writeFileSync(paths.releasePath, JSON.stringify({ releasedAt: Date.now() }), "utf8");
    writeFileSync(paths.repairOutputReleasePath, JSON.stringify({ releasedAt: Date.now() }), "utf8");
  }
  catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  let pids: number[] = [];
  let identityKnown = true;
  try { pids = ownedPids(paths.eventsPath); }
  catch (error) { identityKnown = false; cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  for (const pid of pids) {
    try { stopPid(pid, deadline); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  let runSettled = run === undefined;
  if (run) {
    try { await withDeadline(run, deadline, "public graph run settlement"); runSettled = true; }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  let providerDrained = false;
  try { await observed.drain(deadline); providerDrained = true; }
  catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  let processesExited = false;
  try { if (identityKnown) { await waitForPids(pids, deadline); processesExited = true; } }
  catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  if (runSettled && providerDrained && processesExited && identityKnown && cleanupErrors.length === 0) {
    try { assertOwnedProject(project, label); rmSync(path.resolve(project), { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  } else {
    cleanupErrors.push(new Error(`P15B1b project retained because process/run cleanup was uncertain: ${path.basename(project)}`));
  }
}

test("P15B1b native Codex readiness timeout remains PROVIDER_AUTH_REQUIRED before the graph profile deadline", async () => {
  const label = "par-015-native-readiness";
  let project: string | undefined;
  let paths: ReturnType<typeof configureProject> | undefined;
  let observed: ObservedProvider | undefined;
  let run: Promise<RunOutcome> | undefined;
  let outcome: RunOutcome | undefined;
  let primaryError: unknown;
  let primaryErrorCaught = false;
  const cleanupErrors: Error[] = [];
  try {
    project = createInitializedProject(label);
    paths = configureProject(project, "codex", readinessProfileTimeoutMs);
    const scenarioDeadline = Date.now() + scenarioBudgetMs;
    observed = observeProvider(project, paths.eventsPath, paths.releasePath, scenarioDeadline);
    assertOwnedProject(project, label);
    run = startRun(project, paths.eventsPath, observed).then((value) => { outcome = value; return value; });
    const held = await waitForMarker(paths.heldMarkerPath, () => outcome, scenarioDeadline);
    const heldPid = held.pid;
    expect(Number.isSafeInteger(heldPid) && Number(heldPid) > 0).toBe(true);
    expect(isProcessAlive(Number(heldPid)), "the real second login-status probe must be alive before its adapter timeout").toBe(true);
    outcome = await withDeadline(run, scenarioDeadline, "native readiness outcome");
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("error");
    const result = outcome.result.result as { error: { code: string; nodeId: string; callId: string; launch: boolean; message: string } };
    expect(result.error).toMatchObject({ code: "PROVIDER_AUTH_REQUIRED", nodeId: "prepare", launch: false, callId: expect.any(String) });
    expect(result.error.message).toContain("authentication check failed");
    expect(outcome.snapshot.readError).toBeUndefined();
    expect(outcome.snapshot.processes).toContainEqual({ operation: "auth", pid: Number(heldPid), alive: false, ordinal: 2 });
    expect(outcome.snapshot.processes.some(({ operation }) => operation === "inference")).toBe(false);
    expect(outcome.snapshot.operations.some(({ nodeId }) => nodeId === "audit")).toBe(false);
    expect(outcome.snapshot.operations.filter(({ operation }) => operation === "invoke")).toHaveLength(1);
    expect(outcome.snapshot.operations.every(({ reason }) => !(typeof reason === "object" && reason !== null && "kind" in reason && reason.kind === "profile_timeout"))).toBe(true);
    const checkpoint = readCheckpoint(project, outcome.result.runId) as { graph: { nodes: Record<string, { phase: string; callId?: string; launch?: boolean | null; failure?: { code?: string } }> } };
    expect(checkpoint.graph.nodes.prepare).toMatchObject({ phase: "failed", callId: result.error.callId, launch: false, failure: { code: "PROVIDER_AUTH_REQUIRED" } });
    expect(checkpoint.graph.nodes.audit?.phase).toBe("not_started");
    const runEvents = readRunEvents(project, outcome.result.runId);
    expect(runEvents.some((event) => event.event === "node.accepted")).toBe(false);
    expect(runEvents.some((event) => event.nodeId === "audit" && event.event === "node.started")).toBe(false);
    expect(existsSync(path.join(project, ".nodulus", "runs", outcome.result.runId, "calls", result.error.callId, "transport.json"))).toBe(false);
  } catch (error) { primaryErrorCaught = true; primaryError = error; }
  if (project && paths && observed) await cleanupRun(project, label, paths, run, observed, cleanupErrors);
  else if (project) {
    try { assertOwnedProject(project, label); rmSync(path.resolve(project), { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  if (primaryErrorCaught && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], "P15B1b readiness scenario failed with cleanup diagnostics.");
  if (primaryErrorCaught) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P15B1b readiness cleanup failed.");
}, testCeilingMs);

test("P15B1b native OpenCode repair output-limit failure survives the later graph profile timeout", async () => {
  const label = "par-015-native-repair";
  let project: string | undefined;
  let paths: ReturnType<typeof configureProject> | undefined;
  let observed: ObservedProvider | undefined;
  let run: Promise<RunOutcome> | undefined;
  let outcome: RunOutcome | undefined;
  let primaryError: unknown;
  let primaryErrorCaught = false;
  const cleanupErrors: Error[] = [];
  try {
    project = createInitializedProject(label);
    paths = configureProject(project, "opencode", repairProfileTimeoutMs);
    const scenarioDeadline = Date.now() + scenarioBudgetMs;
    observed = observeProvider(project, paths.eventsPath, paths.releasePath, scenarioDeadline);
    assertOwnedProject(project, label);
    run = startRun(project, paths.eventsPath, observed).then((value) => { outcome = value; return value; });
    const repairStarted = await waitForMarker(paths.repairStartedPath, () => outcome, scenarioDeadline);
    expect(Number.isSafeInteger(repairStarted.pid) && Number(repairStarted.pid) > 0).toBe(true);
    expect(isProcessAlive(Number(repairStarted.pid)), "the real OpenCode repair process must be alive before native output-limit failure").toBe(true);
    writeFileSync(paths.repairOutputReleasePath, JSON.stringify({ releasedAt: Date.now() }), "utf8");
    const evidence = await waitForNativeRepairEvidence(observed, () => outcome, scenarioDeadline);
    expect(evidence.errorCode).toBe("RESPONSE_REPAIR_FAILED");
    expect(evidence.errorMessage).toContain("2 MiB transport output limit");
    expect(evidence.signalAlreadyAbortedWhenNativeErrorArrived).toBe(false);
    expect(evidence.evidenceError).toBeUndefined();
    expect(evidence.transport).toMatchObject({ started: true, outputLimitExceeded: true, timedOut: false, cancelled: false });
    expect(evidence.childExitedBeforeProfileTimeout).toBe(true);
    expect(evidence.signalAbortedAfterChildExit).toBe(false);
    outcome = await withDeadline(run, scenarioDeadline, "native repair graph outcome");
    expect(evidence.evidenceError).toBeUndefined();
    expect(evidence.receivedProfileTimeoutReason).toMatchObject({
      source: "nodulus.graph",
      kind: "profile_timeout",
      code: "PROVIDER_TIMEOUT",
      message: expect.any(String),
    });
    expect(evidence.deliveredError).toBe(evidence.error);
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("error");
    const result = outcome.result.result as { error: { code: string; nodeId: string; callId: string; launch: boolean | null; message: string } };
    expect(result.error).toMatchObject({ code: "RESPONSE_REPAIR_FAILED", nodeId: "prepare", callId: evidence.callId });
    expect(result.error.message).toContain("2 MiB transport output limit");
    expect(outcome.snapshot.readError).toBeUndefined();
    expect(outcome.snapshot.operations.filter(({ operation }) => operation === "invoke")).toHaveLength(1);
    const repairOperation = outcome.snapshot.operations.find(({ operation }) => operation === "repair_response");
    const initialOperation = outcome.snapshot.operations.find(({ operation }) => operation === "invoke");
    expect(repairOperation).toMatchObject({ callId: evidence.callId, parentCallId: initialOperation?.callId, aborted: true });
    expect(repairOperation?.reason).toMatchObject({ kind: "profile_timeout", code: "PROVIDER_TIMEOUT" });
    const checkpoint = readCheckpoint(project, outcome.result.runId) as { graph: { nodes: Record<string, { phase: string; callId?: string; failure?: { code?: string } }> } };
    expect(checkpoint.graph.nodes.prepare).toMatchObject({ phase: "failed", callId: evidence.callId, failure: { code: "RESPONSE_REPAIR_FAILED" } });
    expect(checkpoint.graph.nodes.audit?.phase).toBe("not_started");
    const runEvents = readRunEvents(project, outcome.result.runId);
    expect(runEvents.some((event) => event.event === "node.accepted" && event.nodeId === "prepare")).toBe(false);
    expect(runEvents.some((event) => event.event === "node.started" && event.nodeId === "audit")).toBe(false);
    expect(observed.operations.filter(({ operation }) => operation === "invoke")).toHaveLength(1);
    expect(observed.operations.some(({ nodeId }) => nodeId === "audit")).toBe(false);
    expect(fixtureEvents(paths.eventsPath).filter(({ operation, stage }) => operation === "build" && stage === "started")).toHaveLength(1);
    expect(fixtureEvents(paths.eventsPath).filter(({ operation, stage }) => operation === "repair" && stage === "started")).toHaveLength(1);
    const transport = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", outcome.result.runId, "calls", evidence.callId, "transport.json"), "utf8")) as Record<string, unknown>;
    expect(transport).toMatchObject({ started: true, outputLimitExceeded: true, timedOut: false, cancelled: false });
  } catch (error) { primaryErrorCaught = true; primaryError = error; }
  if (project && paths && observed) await cleanupRun(project, label, paths, run, observed, cleanupErrors);
  else if (project) {
    try { assertOwnedProject(project, label); rmSync(path.resolve(project), { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  if (primaryErrorCaught && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], "P15B1b repair scenario failed with cleanup diagnostics.");
  if (primaryErrorCaught) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P15B1b repair cleanup failed.");
}, testCeilingMs);

import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { runWorkflow, type ApplicationRunResult, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { createGraphProcessProvider, type GraphProcessProviderFixture } from "../support/graph-process-provider.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";
import { observeOwnedNativeProcesses } from "../support/owned-native-processes.js";

type DeadlineMode = "inference" | "readiness";
type FixtureEvent = { stage: string; pid: number; atMs: number };
type ObservedOperation = { operation: "availability" | "invoke"; nodeId?: string; callId?: string; signal?: AbortSignal };
type PublicProcessSnapshot = { stageProcesses: Array<{ stage: string; pid: number; alive: boolean }>; operations: Array<{ operation: string; nodeId?: string; callId?: string; aborted: boolean; reason?: unknown }> };
type ProfileRunOutcome =
  | { kind: "result"; result: ApplicationRunResult; snapshot: PublicProcessSnapshot }
  | { kind: "rejection"; error: unknown; snapshot: PublicProcessSnapshot };
type ValidatorSnapshot = { validatorPid?: number; validatorAliveAtReturn?: boolean; providerCallId?: string; providerTransport?: Record<string, unknown>; readError?: string };
type ValidatorRunOutcome =
  | { kind: "result"; result: ApplicationRunResult; snapshot: ValidatorSnapshot }
  | { kind: "rejection"; error: unknown; snapshot: ValidatorSnapshot };

const providerCliFixture = fileURLToPath(new URL("../fixtures/fb-080-deadline-provider-cli.mjs", import.meta.url));
const hangingValidatorFixture = fileURLToPath(new URL("../fixtures/par-015-hanging-validator.mjs", import.meta.url));
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;
const scenarioBudgetMs = 35_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 50_000;
const validatorTimeoutMs = 2_000;
const validatorRelative = ".nodulus/fixtures/par-015-hanging-validator.mjs";

function configureDefaultProfileProject(project: string, mode: DeadlineMode): { eventsPath: string } {
  configureParallelProject(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const controlPath = path.join(fixtureDirectory, "par-015-profile-control.json");
  const eventsPath = path.join(fixtureDirectory, "par-015-profile-events.jsonl");
  copyFileSync(providerCliFixture, path.join(fixtureDirectory, "fb-080-deadline-provider-cli.mjs"));
  writeFileSync(controlPath, JSON.stringify({
    authDelayMs: mode === "readiness" ? fixtureLifetimeMs : 0,
    inferenceDelayMs: fixtureLifetimeMs,
  }), "utf8");

  const wrapperPath = path.join(fixtureDirectory, process.platform === "win32" ? "par-015-profile-codex.cmd" : "par-015-profile-codex.sh");
  if (process.platform === "win32") {
    writeFileSync(wrapperPath,
      `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\fb-080-deadline-provider-cli.mjs" ".nodulus\\fixtures\\par-015-profile-control.json" ".nodulus\\fixtures\\par-015-profile-events.jsonl" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      "utf8");
  } else {
    writeFileSync(wrapperPath,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/fb-080-deadline-provider-cli.mjs' '.nodulus/fixtures/par-015-profile-control.json' '.nodulus/fixtures/par-015-profile-events.jsonl' "$@"\n`,
      "utf8");
    chmodSync(wrapperPath, 0o755);
  }

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  profiles.fixture = {
    enabled: true,
    executable: wrapperPath,
    kind: "codex",
    model: `p15b1-${mode}`,
    timeoutMs: profileTimeoutMs,
    sandbox: "read-only",
  };
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["prepare"];
  workflow.execution.maxConcurrency = 1;
  workflow.execution.dependsOn = { prepare: [] };
  workflow.execution.resources = { prepare: [] };
  workflow.outputs = [{ name: "preparedResult", from: "prepare.prepared", contract: "prepared.v1" }];
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  writeJson(project, ".nodulus/contracts/prepared.v1.schema.json", {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1 } },
    additionalProperties: false,
  });
  const node = readProjectJson(project, ".nodulus/nodes/prepare.json");
  node.providerProfile = "fixture";
  node.inputs = { request: { from: "request", contract: "request.v1" } };
  node.expectedOutputs = [{ name: "prepared", contract: "prepared.v1" }];
  writeJson(project, ".nodulus/nodes/prepare.json", node);
  return { eventsPath };
}

function configureValidatorProject(project: string): string {
  configureParallelProject(project);
  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["prepare"];
  workflow.execution.maxConcurrency = 1;
  workflow.execution.dependsOn = { prepare: [] };
  workflow.execution.resources = { prepare: [] };
  workflow.outputs = [{ name: "prepareOutput", from: "prepare.report", contract: "report.v1" }];
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  const node = readProjectJson(project, ".nodulus/nodes/prepare.json");
  node.expectedOutputs = [{ name: "report", contract: "report.v1", validator: validatorRelative, validatorTimeoutMs }];
  writeJson(project, ".nodulus/nodes/prepare.json", node);
  copyFileSync(hangingValidatorFixture, path.join(project, validatorRelative));
  return path.join(project, ".nodulus", "fixtures", "par-015-validator-started.json");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function observeDefaultProvider(project: string): { provider: ProviderPort; operations: ObservedOperation[]; drain(deadline: number): Promise<void> } {
  const delegate = createDefaultProviderPort(project);
  const operations: ObservedOperation[] = [];
  const pending = new Set<Promise<unknown>>();
  const record = (entry: Omit<ObservedOperation, "signal"> & { signal?: AbortSignal }): void => {
    const operation: ObservedOperation = { ...entry, signal: entry.signal };
    operations.push(operation);
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  return {
    operations,
    provider: {
      isAvailable(profile, options) {
        record({ operation: "availability", signal: options?.signal });
        return track(Promise.resolve(delegate.isAvailable?.(profile, options) ?? false));
      },
      invoke(invocation: ProviderInvocation) {
        record({ operation: "invoke", nodeId: invocation.nodeId, callId: invocation.call?.callId, signal: invocation.signal });
        return track(delegate.invoke(invocation));
      },
      telemetryForCall: (callId) => delegate.telemetryForCall?.(callId) ?? null,
      launchForCall: (callId) => delegate.launchForCall?.(callId) ?? null,
      usageForLastCall: () => delegate.usageForLastCall?.() ?? null,
    },
    async drain(deadline: number) {
      while (pending.size > 0) {
        if (Date.now() >= deadline) throw new Error(`P15B default-provider operations did not drain: ${pending.size} pending.`);
        await withDeadline(Promise.allSettled([...pending]).then(() => undefined), deadline, "default-provider drain");
      }
    },
  };
}

function request(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Exercise a bounded graph profile or validator timeout." }],
  };
}

function startDefaultRun(project: string, provider: ProviderPort, eventsPath: string, operations: ObservedOperation[]): Promise<ProfileRunOutcome> {
  return runWorkflow(request(project), provider).then(
    (result) => ({ kind: "result", result, snapshot: captureProfileSnapshot(eventsPath, operations) }),
    (error: unknown) => ({ kind: "rejection", error, snapshot: captureProfileSnapshot(eventsPath, operations) }),
  );
}

function captureProfileSnapshot(eventsPath: string, operations: ObservedOperation[]): PublicProcessSnapshot {
  const events = readFixtureEvents(eventsPath);
  return {
    stageProcesses: events.filter(({ stage }) => stage === "inference-started" || stage === "auth-started")
      .map(({ stage, pid }) => ({ stage, pid, alive: isProcessAlive(pid) })),
    operations: operations.map(({ operation, nodeId, callId, signal }) => ({
      operation,
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(callId === undefined ? {} : { callId }),
      aborted: signal?.aborted ?? false,
      ...(signal?.aborted ? { reason: signal.reason } : {}),
    })),
  };
}

function readFixtureEvents(eventsPath: string): FixtureEvent[] {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
}

async function waitForStageOrOutcome(
  eventsPath: string,
  stage: string,
  getOutcome: () => ProfileRunOutcome | undefined,
  deadline: number,
): Promise<FixtureEvent> {
  while (Date.now() < deadline) {
    const event = readFixtureEvents(eventsPath).filter((candidate) => candidate.stage === stage).at(-1);
    if (event) return event;
    const outcome = getOutcome();
    if (outcome) throw new Error(`P15B public run settled before the expected ${stage} fixture stage: ${describeProfileOutcome(outcome)}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`P15B shared scenario budget expired waiting for ${stage}.`);
}

function describeProfileOutcome(outcome: ProfileRunOutcome): string {
  if (outcome.kind === "rejection") return `rejection: ${String(outcome.error)}`;
  const result = outcome.result.result as { error?: { code?: string; message?: string } };
  return `${outcome.result.status}: ${result.error?.code ?? "no error code"} ${result.error?.message ?? ""}`;
}

function assertProfileTimeout(outcome: ProfileRunOutcome, launch: boolean): asserts outcome is Extract<ProfileRunOutcome, { kind: "result" }> {
  expect(outcome.kind).toBe("result");
  if (outcome.kind !== "result") throw outcome.error;
  expect(outcome.result.status).toBe("error");
  expect(outcome.result.result).toMatchObject({
    error: { code: "PROVIDER_TIMEOUT", nodeId: "prepare", launch, callId: expect.any(String) },
  });
}

function readCheckpoint(project: string, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, unknown>;
}

function readEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(project, ".nodulus", "runs", runId, "events.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readCallTransport(project: string, runId: string, callId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "calls", callId, "transport.json"), "utf8")) as Record<string, unknown>;
}

function readPid(filePath: string): number | undefined {
  if (!existsSync(filePath)) return undefined;
  const value = JSON.parse(readFileSync(filePath, "utf8")) as { pid?: unknown };
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error(`Invalid owned process ID in ${path.basename(filePath)}.`);
  return value.pid;
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

function assertOwnedProject(project: string, label: string): void {
  const actualTemp = realpathSync(path.resolve(tmpdir()));
  const actualProject = realpathSync(path.resolve(project));
  const relative = path.relative(actualTemp, actualProject);
  if (path.dirname(actualProject) !== actualTemp || relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(actualProject).startsWith(`nodulus-${label}-`)) {
    throw new Error("P15B temporary project is outside its exact owned temp prefix.");
  }
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error(`P15B shared deadline expired before ${label} completed.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`P15B timed out waiting for ${label} after ${timeoutMs}ms.`)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function exerciseDefaultProfileDeadline(mode: DeadlineMode): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = `par-015-profile-${mode}`;
  const project = createInitializedProject(label);
  const paths = configureDefaultProfileProject(project, mode);
  const observed = observeDefaultProvider(project);
  const nativeProcesses = observeOwnedNativeProcesses();
  let outcome: ProfileRunOutcome | undefined;
  let run: Promise<ProfileRunOutcome> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];
  try {
    assertOwnedProject(project, label);
    run = startDefaultRun(project, observed.provider, paths.eventsPath, observed.operations).then((value) => {
      outcome = value;
      return value;
    });
    const stage = mode === "inference" ? "inference-started" : "auth-started";
    const started = await waitForStageOrOutcome(paths.eventsPath, stage, () => outcome, scenarioDeadline);
    expect(nativeProcesses.diagnostics.some(({ stages }) => stages.includes("spawn")), "a real child process must be captured after the fixture entry marker").toBe(true);
    expect(isProcessAlive(started.pid), `${stage} PID must be alive before the profile timeout`).toBe(true);
    outcome = await withDeadline(run, scenarioDeadline, "profile timeout result");
    assertProfileTimeout(outcome, mode === "inference");

    const error = (outcome.result.result as { error: { callId: string } }).error;
    const checkpoint = readCheckpoint(project, outcome.result.runId) as { graph: { nodes: Record<string, { phase: string; callId?: string; launch?: boolean | null; failure?: { code?: string } }> } };
    expect(checkpoint.graph.nodes.prepare).toMatchObject({ phase: "failed", callId: error.callId, launch: mode === "inference", failure: { code: "PROVIDER_TIMEOUT" } });
    const stoppedObservation = outcome.snapshot.operations.find(({ operation }) => operation === (mode === "inference" ? "invoke" : "availability"));
    expect(stoppedObservation?.reason).toMatchObject({
      source: "nodulus.graph",
      kind: "profile_timeout",
      code: "PROVIDER_TIMEOUT",
      message: expect.any(String),
    });
    expect(typeof (stoppedObservation?.reason as { message?: unknown } | undefined)?.message === "string" &&
      ((stoppedObservation?.reason as { message: string } | undefined)?.message.length ?? 0) > 0).toBe(true);
    const stageName = mode === "inference" ? "inference-started" : "auth-started";
    expect(outcome.snapshot.stageProcesses.some((entry) => entry.stage === stageName && entry.pid === started.pid && !entry.alive)).toBe(true);

    if (mode === "inference") {
      const transport = readCallTransport(project, outcome.result.runId, error.callId);
      expect(transport).toMatchObject({ started: true, cancelled: true, timedOut: false });
    } else {
      expect(outcome.result.result).toMatchObject({ error: { launch: false } });
      expect(outcome.snapshot.operations.some(({ operation }) => operation === "invoke")).toBe(false);
      expect(readFixtureEvents(paths.eventsPath).some(({ stage: item }) => item === "inference-started")).toBe(false);
      expect(existsSync(path.join(project, ".nodulus", "runs", outcome.result.runId, "calls", error.callId, "transport.json"))).toBe(false);
    }
    expect(readEvents(project, outcome.result.runId).some((event) => event.event === "node.accepted")).toBe(false);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  let runSettled = run === undefined || outcome !== undefined;
  if (run) {
    try {
      outcome ??= await withDeadline(run, cleanupDeadline, "owned profile run cleanup");
      runSettled = true;
    } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  let operationsDrained = false;
  try {
    await observed.drain(cleanupDeadline);
    operationsDrained = true;
  } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  let nativeProcessesClosed = false;
  try { await nativeProcesses.drain(cleanupDeadline); nativeProcessesClosed = true; }
  catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  if (!hasPrimaryError && runSettled && operationsDrained && nativeProcessesClosed && cleanupErrors.length === 0) {
    try {
      assertOwnedProject(project, label);
      rmSync(path.resolve(project), { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], "P15B profile scenario failed and cleanup reported additional diagnostics.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P15B profile scenario cleanup failed.");
}

function captureValidatorSnapshot(project: string, startedPath: string, fixture: GraphProcessProviderFixture): ValidatorRunOutcome["snapshot"] {
  const snapshot: ValidatorSnapshot = {};
  try {
    snapshot.validatorPid = readPid(startedPath);
    if (snapshot.validatorPid !== undefined) snapshot.validatorAliveAtReturn = isProcessAlive(snapshot.validatorPid);
  } catch (error) {
    snapshot.readError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
  const invocation = fixture.invocations[0];
  if (invocation) {
    snapshot.providerCallId = invocation.callId;
    try {
      snapshot.providerTransport = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", invocation.runId, "calls", invocation.callId, "transport.json"), "utf8")) as Record<string, unknown>;
    } catch (error) {
      snapshot.readError ??= (error instanceof Error ? error.message : String(error)).slice(0, 500);
    }
  }
  return snapshot;
}

async function waitForValidatorOrOutcome(startedPath: string, getOutcome: () => ValidatorRunOutcome | undefined, deadline: number): Promise<number> {
  while (Date.now() < deadline) {
    const pid = readPid(startedPath);
    if (pid !== undefined) return pid;
    const outcome = getOutcome();
    if (outcome) throw new Error(`P15B validator run settled before its real process marker: ${describeValidatorOutcome(outcome)}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("P15B shared scenario budget expired waiting for the executable validator.");
}

function describeValidatorOutcome(outcome: ValidatorRunOutcome): string {
  if (outcome.kind === "rejection") return `rejection: ${String(outcome.error)}`;
  return `${outcome.result.status}: ${JSON.stringify(outcome.result.result)}`;
}

async function exerciseValidatorTimeout(): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = "par-015-profile-validator";
  const project = createInitializedProject(label);
  const startedPath = configureValidatorProject(project);
  const fixture = createGraphProcessProvider(project, ["prepare"]);
  const nativeProcesses = observeOwnedNativeProcesses();
  let outcome: ValidatorRunOutcome | undefined;
  let run: Promise<ValidatorRunOutcome> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];
  try {
    assertOwnedProject(project, label);
    run = runWorkflow(request(project), fixture.provider).then(
      (result) => {
        const value: ValidatorRunOutcome = { kind: "result", result, snapshot: captureValidatorSnapshot(project, startedPath, fixture) };
        outcome = value;
        return value;
      },
      (error: unknown) => {
        const value: ValidatorRunOutcome = { kind: "rejection", error, snapshot: captureValidatorSnapshot(project, startedPath, fixture) };
        outcome = value;
        return value;
      },
    );
    await fixture.waitForStarted(["prepare"]);
    fixture.release("prepare");
    await fixture.waitForFinished(["prepare"]);
    const validatorPid = await waitForValidatorOrOutcome(startedPath, () => outcome, scenarioDeadline);
    expect(nativeProcesses.diagnostics.some(({ stages }) => stages.includes("spawn")), "a real child process must be captured after the validator entry marker").toBe(true);
    expect(isProcessAlive(validatorPid), "validator PID must be alive after its started marker").toBe(true);
    outcome = await withDeadline(run, scenarioDeadline, "validator timeout result");
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("error");
    expect(outcome.result.result).toMatchObject({ error: { code: "VALIDATOR_TIMEOUT", nodeId: "prepare", launch: true, callId: expect.any(String) } });
    expect(outcome.snapshot.readError).toBeUndefined();
    expect(outcome.snapshot.validatorPid).toBe(validatorPid);
    expect(outcome.snapshot.validatorAliveAtReturn).toBe(false);
    expect(outcome.snapshot.providerTransport).toMatchObject({ started: true, cancelled: false, timedOut: false, exitCode: 0 });
    const runId = outcome.result.runId;
    const checkpoint = readCheckpoint(project, runId) as { graph: { nodes: Record<string, { phase: string; failure?: { code?: string } }> } };
    expect(checkpoint.graph.nodes.prepare).toMatchObject({ phase: "failed", failure: { code: "VALIDATOR_TIMEOUT" } });
    expect(readEvents(project, runId).some((event) => event.event === "node.accepted" && event.nodeId === "prepare")).toBe(false);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  try { fixture.releaseAll(); }
  catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  let runSettled = run === undefined || outcome !== undefined;
  if (run) {
    try {
      outcome ??= await withDeadline(run, cleanupDeadline, "owned validator run cleanup");
      runSettled = true;
    } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  let providerDrained = false;
  try {
    await fixture.drain(Math.max(1, cleanupDeadline - Date.now()));
    providerDrained = true;
  } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  let nativeProcessesClosed = false;
  try { await nativeProcesses.drain(cleanupDeadline); nativeProcessesClosed = true; }
  catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  if (!hasPrimaryError && runSettled && providerDrained && nativeProcessesClosed && cleanupErrors.length === 0) {
    try {
      assertOwnedProject(project, label);
      rmSync(path.resolve(project), { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], "P15B validator scenario failed and cleanup reported additional diagnostics.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P15B validator scenario cleanup failed.");
}

test("P15B1 graph profile deadline stops a real default Codex inference and preserves physical cancellation flags", async () => {
  await exerciseDefaultProfileDeadline("inference");
}, testCeilingMs);

test("P15B1 graph profile deadline stops a real default Codex readiness probe before inference", async () => {
  await exerciseDefaultProfileDeadline("readiness");
}, testCeilingMs);

test("P15B1 declared executable validator timeout remains VALIDATOR_TIMEOUT after successful provider transport", async () => {
  await exerciseValidatorTimeout();
}, testCeilingMs);

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { createInitializedProject } from "../support/intake-project.js";
import { createGraphProcessProvider } from "../support/graph-process-provider.js";
import { startWindowsFileLock, type WindowsFileLock } from "../support/windows-file-lock.js";
import { writeJson } from "../support/workflow-sequence.js";

type RunOutcome =
  | { kind: "result"; result: Awaited<ReturnType<typeof runWorkflow>> }
  | { kind: "rejection"; error: unknown };

const testWatchdogMs = 35_000;
const lockWatchdogMs = 12_000;
const pendingFileWatchdogMs = 5_000;
const controlledHoldAfterPendingMs = 200;

function configureSingleNodeGraph(project: string): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["prepare"];
  workflow.execution.maxConcurrency = 1;
  workflow.execution.dependsOn = { prepare: [] };
  workflow.execution.resources = { prepare: [] };
  workflow.outputs = [{ name: "prepared", from: "prepare.report", contract: "report.v1" }];
  writeJson(project, ".nodulus/workflows/example.json", workflow);
}

function runRequest(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Verify atomic graph checkpoint replacement under a real Windows sharing lock." }],
  };
}

function startRun(project: string, provider: ProviderPort): Promise<RunOutcome> {
  return runWorkflow(runRequest(project), provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

type CheckpointObservation =
  | { kind: "temporary"; path: string; bytes: Buffer; checkpoint: Record<string, any> }
  | { kind: "settled"; outcome: RunOutcome };

async function waitForCheckpointEvidence(
  runDirectory: string,
  settled: Promise<RunOutcome>,
  timeoutMs = pendingFileWatchdogMs,
): Promise<CheckpointObservation> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let names: string[] = [];
    try { names = readdirSync(runDirectory).filter((name) => name.startsWith("run.json.") && name.endsWith(".tmp")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of names) {
      const temporaryPath = path.join(runDirectory, name);
      try {
        const bytes = readFileSync(temporaryPath);
        const checkpoint = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
        if (checkpoint.schemaVersion === 2 && typeof checkpoint.graph?.nextEventSequence === "number") {
          return { kind: "temporary", path: temporaryPath, bytes, checkpoint };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
    const result = await Promise.race([
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)),
      settled.then((outcome) => ({ outcome })),
    ]);
    if (result) return { kind: "settled", outcome: result.outcome };
  }
  throw new Error(`Timed out waiting for a parseable checkpoint temporary or workflow settlement in '${runDirectory}'.`);
}

function describeOutcome(outcome: RunOutcome): string {
  if (outcome.kind === "rejection") return `rejected ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;
  const error = (outcome.result.result as any)?.error as { code?: string; message?: string } | undefined;
  return `${outcome.result.status}${error ? ` ${error.code}: ${error.message}` : ""}`;
}

function assertProjectUnderTemp(project: string): void {
  const tempRoot = path.resolve(os.tmpdir());
  const absolute = path.resolve(project);
  if (!absolute.startsWith(`${tempRoot}${path.sep}`) || !path.basename(absolute).startsWith("nodulus-par-012-windows-replacement-")) {
    throw new Error(`Refusing cleanup outside the owned P12W temp project: '${absolute}'.`);
  }
}

test.skipIf(process.platform !== "win32")("PAR-012W reproduces a Windows run.json replacement denial with a real file-sharing lock", async () => {
  const project = createInitializedProject("par-012-windows-replacement");
  assertProjectUnderTemp(project);
  configureParallelProject(project);
  configureSingleNodeGraph(project);
  const providerFixture = createGraphProcessProvider(project, ["prepare"]);
  let locker: WindowsFileLock | undefined;
  let runDirectory = "";
  let previousCheckpoint = Buffer.alloc(0);
  let lockReadyResolve!: (value: { locker: WindowsFileLock; runDirectory: string; checkpoint: Buffer }) => void;
  let lockReadyReject!: (error: unknown) => void;
  const lockReady = new Promise<{ locker: WindowsFileLock; runDirectory: string; checkpoint: Buffer }>((resolve, reject) => {
    lockReadyResolve = resolve;
    lockReadyReject = reject;
  });
  const provider: ProviderPort = {
    isAvailable: (profile, options) => providerFixture.provider.isAvailable?.(profile, options) ?? true,
    async invoke(invocation: ProviderInvocation) {
      const raw = await providerFixture.provider.invoke(invocation);
      runDirectory = path.join(project, ".nodulus", "runs", invocation.runId);
      const target = path.join(runDirectory, "run.json");
      previousCheckpoint = readFileSync(target);
      try {
        locker = startWindowsFileLock(project, target, lockWatchdogMs);
        await locker.waitForAcquired();
        lockReadyResolve({ locker, runDirectory, checkpoint: previousCheckpoint });
      } catch (error) {
        lockReadyReject(error);
        throw error;
      }
      return raw;
    },
    telemetryForCall: (callId) => providerFixture.provider.telemetryForCall?.(callId) ?? null,
    launchForCall: (callId) => providerFixture.provider.launchForCall?.(callId) ?? null,
  };

  const settled = startRun(project, provider);
  let lock: { locker: WindowsFileLock; runDirectory: string; checkpoint: Buffer } | undefined;
  let checkpointEvidence: CheckpointObservation | undefined;
  let completionDuringHold = true;
  let temporaryPresentAtHoldEnd = false;
  let temporaryBytesAtHoldEnd: Buffer | undefined;
  let targetUnchangedAtHoldEnd = false;
  let testError: unknown;
  try {
    await providerFixture.waitForStarted(["prepare"]);
    providerFixture.release("prepare");
    lock = await Promise.race([
      lockReady,
      settled.then((outcome) => { throw new Error(`Workflow settled before the OS lock was acquired: ${describeOutcome(outcome)}.`); }),
    ]);
    const checkpointPath = path.join(lock.runDirectory, "run.json");
    const previousRecord = JSON.parse(lock.checkpoint.toString("utf8")) as Record<string, any>;
    expect(previousRecord.schemaVersion).toBe(2);
    expect(lock.locker.pid).toBeGreaterThan(0);
    expect(readFileSync(checkpointPath).equals(lock.checkpoint)).toBe(true);

    const probePath = path.join(lock.runDirectory, `run.json.probe-${randomUUID()}.tmp`);
    writeFileSync(probePath, lock.checkpoint);
    let replacementError: NodeJS.ErrnoException | undefined;
    try { renameSync(probePath, checkpointPath); }
    catch (error) { replacementError = error as NodeJS.ErrnoException; }
    finally { if (existsSync(probePath)) unlinkSync(probePath); }
    expect(replacementError?.code).toBe("EPERM");
    expect(readFileSync(checkpointPath).equals(lock.checkpoint)).toBe(true);

    checkpointEvidence = await waitForCheckpointEvidence(lock.runDirectory, settled);
    if (checkpointEvidence.kind === "temporary") {
      expect(checkpointEvidence.checkpoint.graph.nextEventSequence).toBeGreaterThan(previousRecord.graph.nextEventSequence);
      expect(readFileSync(checkpointPath).equals(lock.checkpoint)).toBe(true);
      completionDuringHold = await Promise.race([
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), controlledHoldAfterPendingMs)),
        settled.then(() => true),
      ]);
      temporaryPresentAtHoldEnd = existsSync(checkpointEvidence.path);
      if (temporaryPresentAtHoldEnd) {
        try { temporaryBytesAtHoldEnd = readFileSync(checkpointEvidence.path); }
        catch { temporaryBytesAtHoldEnd = undefined; }
      }
      targetUnchangedAtHoldEnd = readFileSync(checkpointPath).equals(lock.checkpoint);
    }
    await lock.locker.releaseAndWait();
    const outcome = await settled;
    if (outcome.kind === "result" && outcome.result.status !== "success") process.stderr.write(`[P12W RED] ${describeOutcome(outcome)}\n`);
    if (outcome.kind === "rejection") process.stderr.write(`[P12W RED] ${describeOutcome(outcome)}\n`);
    expect(providerFixture.invocations).toHaveLength(1);
    expect(providerFixture.hasStarted("prepare")).toBe(true);
    expect(providerFixture.hasFinished("prepare")).toBe(true);
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("success");
    expect((outcome.result.result as any).artifacts).toEqual([{ name: "prepared", contract: "report.v1", data: { text: "done:prepare" } }]);
    expect(checkpointEvidence?.kind).toBe("temporary");
    if (!checkpointEvidence || checkpointEvidence.kind !== "temporary") throw new Error("Successful run did not expose a complete checkpoint temporary while the lock was held.");
    expect(completionDuringHold).toBe(false);
    expect(temporaryPresentAtHoldEnd).toBe(true);
    expect(temporaryBytesAtHoldEnd?.equals(checkpointEvidence.bytes)).toBe(true);
    expect(targetUnchangedAtHoldEnd).toBe(true);
    const finalCheckpoint = JSON.parse(readFileSync(path.join(lock.runDirectory, "run.json"), "utf8")) as Record<string, any>;
    expect(finalCheckpoint.graph.nodes.prepare.phase).toBe("accepted");
    expect((finalCheckpoint.graph.nodes.prepare.accepted as Record<string, unknown>).callId).toBe(providerFixture.invocations[0]?.callId);
    expect(existsSync(checkpointEvidence.path)).toBe(false);
  } catch (error) {
    testError = error;
  }

  const cleanupErrors: unknown[] = [];
  providerFixture.releaseAll();
  if (locker && !locker.isSafeToRemove()) {
    try { await locker.releaseAndWait(); }
    catch (error) { cleanupErrors.push(error); }
  }
  try {
    const first = await Promise.race([
      lockReady.then((value) => ({ kind: "lock" as const, value }), (error: unknown) => ({ kind: "lock-error" as const, error })),
      settled.then((outcome) => ({ kind: "settled" as const, outcome })),
    ]);
    if (first.kind === "lock") {
      locker = first.value.locker;
      if (!locker.isSafeToRemove()) await locker.releaseAndWait();
    } else if (first.kind === "settled") {
      if (first.outcome.kind === "rejection" || first.outcome.result.status !== "success") process.stderr.write(`[P12W cleanup] ${describeOutcome(first.outcome)}\n`);
    } else {
      cleanupErrors.push(first.error);
    }
  } catch (error) { cleanupErrors.push(error); }
  try {
    const outcome = await settled;
    if (outcome.kind === "rejection" || outcome.result.status !== "success") process.stderr.write(`[P12W cleanup] ${describeOutcome(outcome)}\n`);
  } catch (error) { cleanupErrors.push(error); }
  if (locker && !locker.isSafeToRemove()) {
    try { await locker.releaseAndWait(); }
    catch (error) { cleanupErrors.push(error); }
  }
  try { await providerFixture.drain(); }
  catch (error) { cleanupErrors.push(error); }
  if (locker && !locker.isSafeToRemove()) cleanupErrors.push(new Error("P12W locker liveness is unknown; retaining its fixture project."));
  if (!locker || locker.isSafeToRemove()) {
    try {
      assertProjectUnderTemp(project);
      rmSync(project, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
  } else {
    cleanupErrors.push(new Error(`P12W project retained for lock diagnosis: '${project}'.`));
  }
  if (testError !== undefined && cleanupErrors.length > 0) throw new AggregateError([testError, ...cleanupErrors], "P12W assertion failed and fixture cleanup also failed.");
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "P12W fixture cleanup failed.");
  if (testError !== undefined) throw testError;
}, testWatchdogMs);

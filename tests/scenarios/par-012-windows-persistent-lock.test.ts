import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, unlinkSync, existsSync, writeFileSync } from "node:fs";
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

function configureDependentGraph(project: string): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["prepare", "left"];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { prepare: [], left: ["prepare"] };
  workflow.execution.resources = { prepare: [], left: [] };
  workflow.outputs = [
    { name: "prepared", from: "prepare.report", contract: "report.v1" },
    { name: "followup", from: "left.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);
}

function startRun(project: string, provider: ProviderPort): Promise<RunOutcome> {
  return runWorkflow({
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline", text: "Verify persistent checkpoint replacement denial stops dependent graph admission." }],
  }, provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

function assertOwnedTempProject(project: string): void {
  const absolute = path.resolve(project);
  const tempRoot = path.resolve(os.tmpdir());
  if (!absolute.startsWith(`${tempRoot}${path.sep}`) || !path.basename(absolute).startsWith("nodulus-par-012-windows-persistent-lock-")) {
    throw new Error(`Refusing cleanup outside the owned persistent-lock fixture: '${absolute}'.`);
  }
}

function outcomeError(outcome: RunOutcome): { code?: string; message?: string } {
  if (outcome.kind === "rejection") return { code: "REJECTED", message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) };
  return (outcome.result.result as any)?.error ?? {};
}

test.skipIf(process.platform !== "win32")("PAR-012W control keeps a persistent checkpoint lock until the graph stops", async () => {
  const project = createInitializedProject("par-012-windows-persistent-lock");
  assertOwnedTempProject(project);
  configureParallelProject(project);
  configureDependentGraph(project);
  const providerFixture = createGraphProcessProvider(project, ["prepare", "left"]);
  let locker: WindowsFileLock | undefined;
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
      const runDirectory = path.join(project, ".nodulus", "runs", invocation.runId);
      const target = path.join(runDirectory, "run.json");
      const checkpoint = readFileSync(target);
      try {
        locker = startWindowsFileLock(project, target, lockWatchdogMs);
        await locker.waitForAcquired();
        lockReadyResolve({ locker, runDirectory, checkpoint });
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
  let testError: unknown;
  try {
    await providerFixture.waitForStarted(["prepare"]);
    providerFixture.release("prepare");
    const lock = await Promise.race([
      lockReady,
      settled.then((outcome) => { throw new Error(`Workflow settled before persistent lock acquisition: ${outcomeError(outcome).code}.`); }),
    ]);
    expect(lock.locker.pid).toBeGreaterThan(0);
    expect(readFileSync(path.join(lock.runDirectory, "run.json")).equals(lock.checkpoint)).toBe(true);

    const outcome = await settled;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("error");
    const error = outcomeError(outcome);
    expect(error.code).toBe("RUN_STORAGE_FAILED");
    expect(error.message).toContain("EPERM");
    const diagnosticMatch = error.message?.match(/\[windowsAtomicRename=(\{.*\})\]$/);
    expect(diagnosticMatch).not.toBeNull();
    if (!diagnosticMatch) throw new Error("Windows atomic-rename failure omitted its terminal diagnostic suffix.");
    const diagnostic = JSON.parse(diagnosticMatch[1]) as {
      phase: string;
      budgetMs: number;
      renameAttempts: number;
      elapsedMs: number;
      initialCode: string;
    };
    expect(diagnostic.phase).toBe("budget_exhausted");
    expect(diagnostic.budgetMs).toBe(1000);
    expect(diagnostic.renameAttempts).toBeGreaterThan(1);
    expect(Number.isFinite(diagnostic.elapsedMs)).toBe(true);
    expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostic.initialCode).toBe("EPERM");

    const checkpointPath = path.join(lock.runDirectory, "run.json");
    expect(readFileSync(checkpointPath).equals(lock.checkpoint)).toBe(true);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as Record<string, any>;
    expect(checkpoint.graph.nodes.prepare.phase).not.toBe("accepted");
    expect(checkpoint.graph.nodes.prepare.accepted).toBeUndefined();
    expect(checkpoint.graph.nodes.left.phase).not.toBe("accepted");
    expect(providerFixture.invocations).toHaveLength(1);
    expect(providerFixture.hasStarted("left")).toBe(false);

    const probePath = path.join(lock.runDirectory, `run.json.control-probe-${randomUUID()}.tmp`);
    writeFileSync(probePath, lock.checkpoint);
    let probeError: NodeJS.ErrnoException | undefined;
    try { renameSync(probePath, checkpointPath); }
    catch (error) { probeError = error as NodeJS.ErrnoException; }
    finally { if (existsSync(probePath)) unlinkSync(probePath); }
    expect(probeError?.code).toBe("EPERM");
    expect(readFileSync(checkpointPath).equals(lock.checkpoint)).toBe(true);
    await lock.locker.releaseAndWait();
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
    } else if (first.kind === "lock-error") {
      cleanupErrors.push(first.error);
    }
  } catch (error) { cleanupErrors.push(error); }
  try { await settled; }
  catch (error) { cleanupErrors.push(error); }
  if (locker && !locker.isSafeToRemove()) {
    try { await locker.releaseAndWait(); }
    catch (error) { cleanupErrors.push(error); }
  }
  try { await providerFixture.drain(); }
  catch (error) { cleanupErrors.push(error); }
  if (locker && !locker.isSafeToRemove()) cleanupErrors.push(new Error("Persistent-lock control PID is unverified or may still be alive; retaining project."));
  if (!locker || locker.isSafeToRemove()) {
    try {
      assertOwnedTempProject(project);
      rmSync(project, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
  }
  if (testError !== undefined && cleanupErrors.length > 0) throw new AggregateError([testError, ...cleanupErrors], "Persistent-lock assertion and cleanup both failed.");
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Persistent-lock fixture cleanup failed.");
  if (testError !== undefined) throw testError;
}, testWatchdogMs);

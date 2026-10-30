import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { createGraphProcessProvider } from "../support/graph-process-provider.js";
import { createInitializedProject } from "../support/intake-project.js";
import { startWindowsFileLock, type WindowsFileLock } from "../support/windows-file-lock.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { createWindowsRenameForensicStorage } from "../support/windows-rename-forensics.js";

type RunOutcome =
  | { kind: "result"; result: Awaited<ReturnType<typeof runWorkflow>> }
  | { kind: "rejection"; error: unknown };

type LockCheckpoint = { locker: WindowsFileLock; runDirectory: string; checkpoint: Buffer };

const testWatchdogMs = 35_000;
const lockWatchdogMs = 12_000;

function configureAlphaBetaGraph(project: string): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["alpha", "beta"];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { alpha: [], beta: ["alpha"] };
  workflow.execution.resources = { alpha: [], beta: [] };
  workflow.outputs = [
    { name: "alphaReport", from: "alpha.report", contract: "report.v1" },
    { name: "betaReport", from: "beta.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  const alpha = readProjectJson(project, ".nodulus/nodes/audit.json") as Record<string, any>;
  alpha.id = "alpha";
  alpha.instructions = [".nodulus/instructions/alpha.md"];
  alpha.inputs = { request: { from: "request", contract: "request.v1" } };
  writeJson(project, ".nodulus/nodes/alpha.json", alpha);
  writeFileSync(path.join(project, ".nodulus", "instructions", "alpha.md"), "Alpha instruction.\n", "utf8");

  const beta = readProjectJson(project, ".nodulus/nodes/left.json") as Record<string, any>;
  beta.id = "beta";
  beta.instructions = [".nodulus/instructions/beta.md"];
  beta.inputs = { report: { from: "alpha.report", contract: "report.v1" } };
  writeJson(project, ".nodulus/nodes/beta.json", beta);
  writeFileSync(path.join(project, ".nodulus", "instructions", "beta.md"), "Beta instruction.\n", "utf8");
}

function assertOwnedProject(project: string): void {
  const absolute = path.resolve(project);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(absolute) !== tempRoot || !path.basename(absolute).startsWith("nodulus-par-012-windows-forensics café & %-")) {
    throw new Error(`Refusing cleanup outside the owned Windows-forensics fixture: '${absolute}'.`);
  }
}

function assertOwnedContainer(container: string): void {
  const absolute = path.resolve(container);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(absolute) !== tempRoot || !path.basename(absolute).startsWith("nodulus-par-012-windows-forensics-alias-container-")) {
    throw new Error(`Refusing cleanup outside the owned alias container: '${absolute}'.`);
  }
}

function outcomeError(outcome: RunOutcome): { code?: string; message?: string } {
  if (outcome.kind === "rejection") return { code: "REJECTED", message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) };
  return (outcome.result.result as { error?: { code?: string; message?: string } } | undefined)?.error ?? {};
}

test.skipIf(process.platform !== "win32")("PAR-012FA captures forensic evidence when runWorkflow uses an owned junction alias", async () => {
  const project = createInitializedProject("par-012-windows-forensics café & %");
  const aliasContainer = mkdtempSync(path.join(os.tmpdir(), "nodulus-par-012-windows-forensics-alias-container-"));
  assertOwnedProject(project);
  assertOwnedContainer(aliasContainer);
  const projectIdentity = realpathSync(project);
  const containerIdentity = realpathSync(aliasContainer);
  const alias = path.join(aliasContainer, "project-alias");
  symlinkSync(projectIdentity, alias, "junction");
  if (realpathSync(alias) !== projectIdentity) throw new Error("Owned junction alias did not resolve to the generated project.");
  const providerProject = alias;
  configureParallelProject(providerProject);
  configureAlphaBetaGraph(providerProject);
  const providerFixture = createGraphProcessProvider(providerProject, ["alpha", "beta"]);
  const forensic = await createWindowsRenameForensicStorage(providerProject, path.join(providerProject, ".nodulus", "fixtures", "windows-rename-reports"));

  let locker: WindowsFileLock | undefined;
  let lockReadyResolve!: (value: LockCheckpoint) => void;
  let lockReadyReject!: (error: unknown) => void;
  const lockReady = new Promise<LockCheckpoint>((resolve, reject) => {
    lockReadyResolve = resolve;
    lockReadyReject = reject;
  });

  const provider: ProviderPort = {
    isAvailable: (profile, options) => providerFixture.provider.isAvailable?.(profile, options) ?? true,
    async invoke(invocation: ProviderInvocation) {
      const raw = await providerFixture.provider.invoke(invocation);
      if (invocation.nodeId === "alpha") {
        const runDirectory = path.join(providerProject, ".nodulus", "runs", invocation.runId);
        const target = path.join(runDirectory, "run.json");
        const checkpoint = readFileSync(target);
        try {
          locker = startWindowsFileLock(providerProject, target, lockWatchdogMs);
          await locker.waitForAcquired();
          lockReadyResolve({ locker, runDirectory, checkpoint });
        } catch (error) {
          lockReadyReject(error);
          throw error;
        }
      }
      return raw;
    },
    telemetryForCall: (callId) => providerFixture.provider.telemetryForCall?.(callId) ?? null,
    launchForCall: (callId) => providerFixture.provider.launchForCall?.(callId) ?? null,
  };

  let workflowSettled = false;
  const settled: Promise<RunOutcome> = runWorkflow({
    projectRoot: providerProject,
    cwd: providerProject,
    workflow: "example",
    sources: [{ kind: "inline", text: "Capture bounded evidence for a held Windows checkpoint replacement denial." }],
  }, provider, { storage: forensic.storage }).then(
    (result) => { workflowSettled = true; return { kind: "result", result }; },
    (error: unknown) => { workflowSettled = true; return { kind: "rejection", error }; },
  );

  let testError: unknown;
  try {
    await providerFixture.waitForStarted(["alpha"]);
    providerFixture.release("alpha");
    const lock = await Promise.race([
      lockReady,
      settled.then((outcome) => { throw new Error(`Workflow settled before lock acquisition: ${outcomeError(outcome).code}.`); }),
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

    const checkpointPath = path.join(lock.runDirectory, "run.json");
    expect(readFileSync(checkpointPath).equals(lock.checkpoint)).toBe(true);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as Record<string, any>;
    expect(checkpoint.graph.nodes.alpha.phase).not.toBe("accepted");
    expect(checkpoint.graph.nodes.alpha.accepted).toBeUndefined();
    expect(checkpoint.graph.nodes.beta.phase).not.toBe("accepted");
    expect(checkpoint.graph.nodes.beta.accepted).toBeUndefined();
    expect(providerFixture.invocations.map((invocation) => invocation.nodeId)).toEqual(["alpha"]);
    expect(providerFixture.hasStarted("beta")).toBe(false);

    const probePath = path.join(lock.runDirectory, `run.json.forensics-probe-${randomUUID()}.tmp`);
    writeFileSync(probePath, lock.checkpoint);
    let probeError: NodeJS.ErrnoException | undefined;
    try { renameSync(probePath, checkpointPath); }
    catch (probeFailure) { probeError = probeFailure as NodeJS.ErrnoException; }
    finally { if (existsSync(probePath)) unlinkSync(probePath); }
    expect(probeError?.code).toBe("EPERM");
    expect(readFileSync(checkpointPath).equals(lock.checkpoint)).toBe(true);

    const physicalCheckpointPath = realpathSync(checkpointPath);
    const lexicalCheckpointPath = path.resolve(providerProject, ".nodulus", "runs", outcome.result.runId, "run.json");
    expect(physicalCheckpointPath).not.toBe(lexicalCheckpointPath);
    expect(error.message).toContain(physicalCheckpointPath);
    expect(error.message).not.toContain(lexicalCheckpointPath);

    const report = forensic.reports.find((candidate) => candidate.runId === outcome.result.runId);
    expect(report, `No forensic report captured for physical target '${physicalCheckpointPath}' through alias '${lexicalCheckpointPath}'.`).toBeDefined();
    expect(report?.status, `Forensic report context: ${JSON.stringify({
      status: report?.status,
      reason: report?.reason,
      target: report?.target,
      observedFailure: report?.observedFailure,
      hasTargetEvidence: report?.targetEvidence !== undefined,
      hasDeleteAccessProbe: report?.deleteAccessProbe !== undefined,
      hasRestartManager: report?.restartManager !== undefined,
    })}`).toBe("available");
    if (!report || report.status !== "available") throw new Error("Windows rename forensic report is unavailable.");
    expect(report.target).toBe(checkpointPath);
    expect(report.targetEvidence).toMatchObject({
      sha256: createHash("sha256").update(lock.checkpoint).digest("hex"),
      type: "file",
      attributes: expect.any(Number),
    });
    expect(report.deleteAccessProbe?.win32ErrorCode).toBe(32);
    expect(report.restartManager?.processes.map((entry) => entry.pid)).toContain(lock.locker.pid);
  } catch (error) {
    testError = error;
  }

  const cleanupErrors: unknown[] = [];
  let forensicClosed = false;
  try { providerFixture.releaseAll(); }
  catch (error) { cleanupErrors.push(error); }
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
  let providerDrained = false;
  try { await providerFixture.drain(); providerDrained = true; }
  catch (error) { cleanupErrors.push(error); }
  try {
    await forensic.close();
    forensicClosed = true;
  } catch (error) { cleanupErrors.push(error); }
  if (locker && !locker.isSafeToRemove()) cleanupErrors.push(new Error("Forensic lock PID is unverified or may still be alive; retaining project."));
  if (!forensicClosed) cleanupErrors.push(new Error("Forensic helper shutdown is unconfirmed; retaining project."));
  if (cleanupErrors.length === 0 && forensicClosed && workflowSettled && providerDrained && (!locker || locker.isSafeToRemove())) {
    try {
      assertOwnedProject(project);
      assertOwnedContainer(aliasContainer);
      if (realpathSync(project) !== projectIdentity || realpathSync(aliasContainer) !== containerIdentity) {
        throw new Error("Generated project or alias container no longer resolves to its immutable owned path; retaining fixtures.");
      }
      if (realpathSync(alias) !== projectIdentity) throw new Error("Alias target identity changed; retaining fixtures.");
      unlinkSync(alias);
      if (existsSync(alias)) throw new Error("Junction still exists after unlink; retaining generated project and container.");
      rmSync(project, { recursive: true, force: true });
      if (existsSync(project)) throw new Error("Generated project still exists after verified recursive cleanup.");
      rmSync(aliasContainer, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
  }
  if (testError !== undefined && cleanupErrors.length > 0) throw new AggregateError([testError, ...cleanupErrors], "Forensic assertion and cleanup both failed.");
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Forensic fixture cleanup failed.");
  if (testError !== undefined) throw testError;
}, testWatchdogMs);

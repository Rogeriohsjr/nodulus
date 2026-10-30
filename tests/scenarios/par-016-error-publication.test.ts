import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject } from "../support/parallel-project.js";
import { startWindowsFileLock, type WindowsFileLock } from "../support/windows-file-lock.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type ChildHandle = { child: ChildProcess; result: Promise<ChildResult> };
type ExternalEvent = { sequence: number; event: string; [key: string]: unknown };
type RunReport = {
  runId?: string;
  outcome?: { kind?: string; result?: { status?: string; result?: { error?: Record<string, unknown> } }; error?: unknown };
  probeCounts?: Record<string, number>;
  invokeCounts?: Record<string, number>;
  repairCount?: number;
};
type ReadyRecord = {
  runId: string;
  mode: "events_blocker" | "checkpoint_lock";
  checkpointBase64: string;
  checkpointSha256: string;
  eventsBase64: string;
  eventsSha256: string;
  resultText: string;
  validationText: string;
  failedEvent: ExternalEvent;
  checkpointPath: string;
  eventsPath: string;
  backupPath: string;
  blockerPath: string;
};

const fixturePath = fileURLToPath(new URL("../fixtures/par-016-terminal-error-provider.mjs", import.meta.url));
const scenarioDeadlineMs = 18_000;
const sharedCleanupDeadlineMs = 8_000;
const testCeilingMs = 30_000;

test("PAR-016 a required node.failed event write error retains the terminal node cause", async () => {
  await runPublicationFailureCase("events_blocker");
}, testCeilingMs);

test.skipIf(process.platform !== "win32")("PAR-016 a required node.failed checkpoint rename error retains the terminal node cause", async () => {
  await runPublicationFailureCase("checkpoint_lock");
}, testCeilingMs);

async function runPublicationFailureCase(mode: ReadyRecord["mode"]): Promise<void> {
  const project = createInitializedProject(`par-016-error-publication-${mode}`);
  const canonicalProject = realpathSync.native(project);
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "par-016-error-publication-state");
  const readyPath = path.join(stateDirectory, "ready.json");
  const allowFailurePath = path.join(stateDirectory, "allow-failure");
  let worker: ChildHandle | undefined;
  let workerSettled = false;
  let fileLock: WindowsFileLock | undefined;
  let ready: ReadyRecord | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let setupSafeToRemove = true;
  const cleanupErrors: string[] = [];

  try {
    mkdirSync(stateDirectory, { recursive: true });
    const deadline = Date.now() + scenarioDeadlineMs;
    configureParallelProject(project);
    configureTerminalGraph(project);
    worker = startChild(["run", project, mode, stateDirectory, readyPath, allowFailurePath, String(deadline)]);
    await waitForFile(readyPath, remaining(deadline), "terminal evidence ready marker");
    ready = JSON.parse(readFileSync(readyPath, "utf8")) as ReadyRecord;
    expect(ready.mode).toBe(mode);
    expect(ready.runId).toMatch(/^[0-9a-f-]{36}$/i);
    const runDirectory = path.join(project, ".nodulus", "runs", ready.runId);
    const checkpointPath = path.join(runDirectory, "run.json");
    const eventsPath = path.join(runDirectory, "events.jsonl");
    expect(realpathSync.native(ready.checkpointPath)).toBe(realpathSync.native(checkpointPath));
    expect(realpathSync.native(ready.eventsPath)).toBe(realpathSync.native(eventsPath));
    expect(readFileSync(checkpointPath).toString("base64")).toBe(ready.checkpointBase64);
    expect(sha256(readFileSync(checkpointPath))).toBe(ready.checkpointSha256);
    expect(readFileSync(eventsPath).toString("base64")).toBe(ready.eventsBase64);
    expect(sha256(readFileSync(eventsPath))).toBe(ready.eventsSha256);
    expect(JSON.parse(ready.resultText)).toMatchObject({ status: "error", error: { code: "CONTROL_NODE_ERROR", message: "controlled terminal node failure" } });
    expect(JSON.parse(ready.validationText)).toMatchObject({ valid: true, outcome: "error", errors: [] });
    expect(ready.failedEvent).toMatchObject({ event: "node.failed", nodeId: "root", code: "CONTROL_NODE_ERROR" });
    const oldCheckpoint = JSON.parse(ready.checkpointBase64 ? Buffer.from(ready.checkpointBase64, "base64").toString("utf8") : "{}") as {
      status?: string;
      graph?: { nodes?: Record<string, { phase?: string; accepted?: unknown }> };
      completedNodes?: unknown[];
    };
    expect(oldCheckpoint.status).toBe("running");
    expect(oldCheckpoint.completedNodes).toEqual([]);
    expect(oldCheckpoint.graph?.nodes?.root).toMatchObject({ phase: "active" });
    expect(oldCheckpoint.graph?.nodes?.root?.accepted).toBeUndefined();

    if (mode === "checkpoint_lock") {
      if (process.platform !== "win32") throw new Error("Windows checkpoint locking was dispatched on a non-Windows host.");
      fileLock = startWindowsFileLock(project, checkpointPath, 12_000);
      await fileLock.waitForAcquired(Math.min(5_000, remaining(deadline)));
      expect(fileLock.isSafeToRemove()).toBe(false);
    }
    writeFileSync(allowFailurePath, "allow\n", "utf8");

    const workerResult = await waitForChild(worker, remaining(deadline));
    workerSettled = true;
    expect(workerResult, `P16C worker failed: ${workerResult.stderr || workerResult.stdout}`).toMatchObject({ code: 0, signal: null });
    const report = JSON.parse(workerResult.stdout) as RunReport;
    expect(report.runId).toBe(ready.runId);
    expect(report.outcome?.kind).toBe("result");
    expect(report.outcome?.result?.status).toBe("error");
    const publicError = report.outcome.result.result?.error;
    expect(publicError).toMatchObject({ code: "RUN_STORAGE_FAILED", nodeId: "root", cause: { code: "CONTROL_NODE_ERROR", message: "controlled terminal node failure", nodeId: "root", callId: expect.any(String), launch: true } });

    const events = readExternalEvents(stateDirectory);
    const captured = oneEvent(events, "provider_process_captured");
    const failure = oneEvent(events, "node_failed_storage_error");
    expect(publicError?.cause).toMatchObject({ callId: captured.callId });
    expect(captured).toMatchObject({ nodeId: "root", started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false, pidExited: true });
    expect(failure).toMatchObject({ errorCode: expect.any(String), target: mode === "checkpoint_lock" ? ready.checkpointPath : ready.eventsPath });
    expect(failure.errorSyscall).toBe("rename");
    expect(typeof failure.errorDest).toBe("string");
    expect(String(failure.errorMessage)).toContain(String(failure.errorCode));
    const expectedErrorTarget = path.resolve(canonicalProject, path.relative(project, String(failure.target)));
    expect(realpathSync.native(String(failure.errorDest))).toBe(expectedErrorTarget);
    expect(publicError?.message).toContain(String(failure.errorMessage));

    const transportPath = path.join(runDirectory, "calls", String(captured.callId), "transport.json");
    const transportBytes = readFileSync(transportPath);
    expect(sha256(transportBytes)).toBe(captured.transportSha256);
    const transport = JSON.parse(transportBytes.toString("utf8")) as Record<string, unknown>;
    expect(transport).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false });
    expect(transport.stdout).toBe(captured.rawResponse);
    expect(JSON.parse(String(captured.rawResponse))).toMatchObject({ status: "error", error: { code: "CONTROL_NODE_ERROR", message: "controlled terminal node failure" } });

    expect(report.probeCounts).toEqual({ "profile-root": 1 });
    expect(report.invokeCounts).toEqual({ root: 1 });
    expect(report.repairCount).toBe(0);
    expect(events.filter(({ event }) => event === "provider_probe").map(({ profileModel }) => profileModel)).toEqual(["profile-root"]);
    expect(events.filter(({ event }) => event === "provider_process_captured").map(({ nodeId }) => nodeId)).toEqual(["root"]);
    expect(existsSync(path.join(stateDirectory, "started-successor.json"))).toBe(false);

    const finalCheckpointBytes = readFileSync(checkpointPath);
    expect(finalCheckpointBytes.toString("base64")).toBe(ready.checkpointBase64);
    expect(sha256(finalCheckpointBytes)).toBe(ready.checkpointSha256);
    const finalCheckpoint = JSON.parse(finalCheckpointBytes.toString("utf8")) as typeof oldCheckpoint;
    expect(finalCheckpoint).toMatchObject({ status: "running", completedNodes: [] });
    expect(finalCheckpoint.graph?.nodes?.root).toMatchObject({ phase: "active" });
    expect(finalCheckpoint.graph?.nodes?.root?.accepted).toBeUndefined();
    expect(finalCheckpoint.graph?.nodes?.successor?.phase).toBe("not_started");

    const eventsBytes = mode === "events_blocker"
      ? (expect(statSync(eventsPath).isDirectory()).toBe(true), readFileSync(ready.backupPath))
      : readFileSync(eventsPath);
    const savedEvents = eventsBytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ExternalEvent);
    expect(savedEvents.some(({ event }) => event === "node.accepted" || event === "run.completed" || event === "run.failed")).toBe(false);
    expect(savedEvents.some(({ event, nodeId }) => nodeId === "successor" || event === "run.completed")).toBe(false);
    if (mode === "events_blocker") {
      expect(eventsBytes.toString("base64")).toBe(ready.eventsBase64);
      expect(savedEvents.some(({ event, nodeId }) => event === "node.failed" && nodeId === "root")).toBe(false);
    } else {
      expect(savedEvents.some(({ event, nodeId, code }) => event === "node.failed" && nodeId === "root" && code === "CONTROL_NODE_ERROR")).toBe(true);
      const failedSequence = savedEvents.find(({ event, nodeId }) => event === "node.failed" && nodeId === "root")?.sequence;
      const oldNextSequence = (oldCheckpoint.graph as { nextEventSequence?: number } | undefined)?.nextEventSequence;
      expect(typeof failedSequence).toBe("number");
      expect(typeof oldNextSequence).toBe("number");
      expect(failedSequence).toBe(oldNextSequence);
      const diagnostic = String(failure.errorMessage);
      expect(diagnostic).toContain("windowsAtomicRename=");
      expect(diagnostic).toContain('"phase":"budget_exhausted"');
    }
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    const cleanupDeadline = Date.now() + sharedCleanupDeadlineMs;
    if (!existsSync(allowFailurePath)) {
      try { writeFileSync(allowFailurePath, "cleanup-release\n", "utf8"); }
      catch (error) { cleanupErrors.push(`Could not release the terminal batch gate: ${messageOf(error)}`); }
    }
    if (fileLock) {
      try {
        const releaseWaitMs = remaining(cleanupDeadline) - 2_000;
        if (releaseWaitMs <= 0) {
          cleanupErrors.push("Shared cleanup deadline could not reserve the lock helper's bounded fallback; project retained.");
          setupSafeToRemove = false;
          writeFileSync(fileLock.releasePath, "release\n", "utf8");
        } else await fileLock.releaseAndWait(Math.min(4_000, releaseWaitMs));
      } catch (error) {
        cleanupErrors.push(`Windows run checkpoint lock could not be confirmed closed: ${messageOf(error)}`);
        setupSafeToRemove = false;
      }
    }
    if (worker) {
      try {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
        await waitForChild(worker, remaining(cleanupDeadline));
        workerSettled = true;
      } catch (error) {
        cleanupErrors.push(`Owned P16C scenario worker did not close: ${messageOf(error)}`);
        setupSafeToRemove = false;
      }
    }
    try {
      const started = path.join(stateDirectory, "started-root.json");
      if (existsSync(started)) {
        const record = JSON.parse(readFileSync(started, "utf8")) as { pid?: unknown; nodeId?: unknown };
        if (record.nodeId !== "root" || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
          cleanupErrors.push("Root provider PID marker is malformed; project retained.");
          setupSafeToRemove = false;
        } else if (!pidExited(record.pid)) {
          try { process.kill(record.pid); }
          catch (error) { cleanupErrors.push(`Could not stop owned provider ${record.pid}: ${messageOf(error)}`); }
          if (!await waitForPidExit(record.pid, remaining(cleanupDeadline))) cleanupErrors.push(`Provider ${record.pid} exit could not be confirmed.`);
        }
      }
    } catch (error) {
      cleanupErrors.push(`Provider ownership could not be verified: ${messageOf(error)}`);
    }
    if (mode === "events_blocker" && ready && workerSettled) {
      try { restoreOwnedEventBackup(project, canonicalProject, ready); }
      catch (error) { cleanupErrors.push(`Portable event target restoration failed: ${messageOf(error)}`); setupSafeToRemove = false; }
    }
    if (cleanupErrors.length > 0) setupSafeToRemove = false;
    if (setupSafeToRemove) {
      try {
        assertOwnedProject(project, canonicalProject);
        rmSync(project, { recursive: true, force: true });
      } catch (error) { cleanupErrors.push(`Owned P16C project was retained: ${messageOf(error)}`); }
    }
  }

  if (cleanupErrors.length > 0) {
    const detail = `${cleanupErrors.join("; ")} Project retained at ${project}.`;
    if (primaryError instanceof Error) primaryError.message += ` Cleanup: ${detail}`;
    else if (!hasPrimaryError) { primaryError = new Error(detail); hasPrimaryError = true; }
  }
  if (hasPrimaryError) throw primaryError;
}

function configureTerminalGraph(project: string): void {
  const settings = readProjectJson(project, ".nodulus/settings.json") as { providerProfiles: Record<string, Record<string, unknown>> };
  const profile = settings.providerProfiles.fixture;
  if (!profile) throw new Error("Initialized project omitted fixture profile.");
  settings.providerProfiles = {
    root: { ...profile, model: "profile-root", timeoutMs: 60_000 },
    successor: { ...profile, model: "profile-successor", timeoutMs: 60_000 },
  };
  writeJson(project, ".nodulus/settings.json", settings);
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 2,
    id: "example",
    nodes: ["root", "successor"],
    execution: { kind: "dag", maxConcurrency: 1, dependsOn: { root: [], successor: ["root"] }, resources: { root: [], successor: [] } },
    outputs: [
      { name: "rootResult", from: "root.report", contract: "report.v1" },
      { name: "successorResult", from: "successor.report", contract: "report.v1" },
    ],
  });
  for (const [id, providerProfile, inputs] of [
    ["root", "root", { request: { from: "request", contract: "request.v1" } }],
    ["successor", "successor", { root: { from: "root.report", contract: "report.v1" } }],
  ] as const) {
    writeJson(project, `.nodulus/nodes/${id}.json`, {
      schemaVersion: 1,
      id,
      providerProfile,
      instructions: [`.nodulus/instructions/${id}.md`],
      inputs,
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
  }
}

function restoreOwnedEventBackup(project: string, canonicalProject: string, ready: ReadyRecord): void {
  const runDirectory = path.join(project, ".nodulus", "runs", ready.runId);
  const eventsPath = path.join(runDirectory, "events.jsonl");
  const backupPath = path.join(runDirectory, path.relative(runDirectory, ready.backupPath));
  const blockerPath = path.join(runDirectory, path.relative(runDirectory, ready.blockerPath));
  expect(ready.backupPath).toBe(path.join(runDirectory, "p16c-events-before-failure.jsonl"));
  expect(ready.blockerPath).toBe(path.join(runDirectory, "events.jsonl", "owned-blocker.json"));
  expect(realpathSync.native(eventsPath)).toBe(path.join(canonicalProject, path.relative(project, eventsPath)));
  expect(path.resolve(backupPath).startsWith(`${path.resolve(runDirectory)}${path.sep}`)).toBe(true);
  expect(path.resolve(blockerPath).startsWith(`${path.resolve(runDirectory)}${path.sep}`)).toBe(true);
  expect(realpathSync.native(project)).toBe(canonicalProject);
  expect(statSync(eventsPath).isDirectory()).toBe(true);
  expect(readFileSync(backupPath).toString("base64")).toBe(ready.eventsBase64);
  const blockerMarker = path.join(eventsPath, "owned-blocker.json");
  expect(readFileSync(blockerMarker, "utf8")).toContain("events.jsonl");
  unlinkSync(blockerMarker);
  rmdirSync(eventsPath);
  renameSync(backupPath, eventsPath);
  expect(readFileSync(eventsPath).toString("base64")).toBe(ready.eventsBase64);
}

function startChild(args: string[]): ChildHandle {
  const child = spawn(process.execPath, [fixturePath, ...args], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, result };
}

async function waitForChild(handle: ChildHandle, timeoutMs: number): Promise<ChildResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("P16C bounded wait expired.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.result,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned child ${String(handle.child.pid)} exceeded its bounded wait.`)), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function waitForFile(file: string, timeoutMs: number, label: string): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`P16C deadline expired before ${label}.`);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) await delay(20);
  if (!existsSync(file)) throw new Error(`Timed out waiting for ${label}.`);
}

function readExternalEvents(directory: string): ExternalEvent[] {
  return readFileSync(path.join(directory, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as ExternalEvent);
}

function oneEvent(events: ExternalEvent[], event: string): ExternalEvent {
  const matches = events.filter((entry) => entry.event === event);
  expect(matches, `Expected exactly one '${event}' external event.`).toHaveLength(1);
  const match = matches[0];
  if (!match) throw new Error(`Missing external event '${event}'.`);
  return match;
}

function pidExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidExited(pid)) return true;
    await delay(20);
  }
  return pidExited(pid);
}

function assertOwnedProject(project: string, canonicalProject: string): void {
  const actual = realpathSync.native(project);
  const temp = realpathSync.native(os.tmpdir());
  expect(actual).toBe(canonicalProject);
  expect(actual.startsWith(`${temp}${path.sep}`)).toBe(true);
  expect(path.basename(actual)).toMatch(/^nodulus-par-016-error-publication-/);
}

function sha256(contents: string | Buffer): string { return createHash("sha256").update(contents).digest("hex"); }
function remaining(deadline: number): number { return Math.max(0, deadline - Date.now()); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type ChildHandle = { child: ChildProcess; result: Promise<ChildResult> };
type LoggedEvent = { sequence: number; event: string; [key: string]: unknown };
type CaseReport = {
  outcome?: { kind: string; result?: { status?: string; result?: unknown }; error?: unknown };
  runId?: string;
  probeCounts?: Record<string, number>;
  invokeCounts?: Record<string, number>;
};

const fixturePath = fileURLToPath(new URL("../fixtures/par-016-concurrent-write-provider.mjs", import.meta.url));
const scenarioDeadlineMs = 22_000;
const sharedCleanupDeadlineMs = 8_000;
const testCeilingMs = 35_000;

test("PAR-016 a required artifact write failure poisons before releasing a captured sibling response", async () => {
  const project = createInitializedProject("par-016-concurrent-write-failure");
  const canonicalProject = realpathSync.native(project);
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "par-016-concurrent-write-state");
  let worker: ChildHandle | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: string[] = [];

  try {
    configureParallelProject(project);
    configureConcurrentFailureGraph(project);
    const deadline = Date.now() + scenarioDeadlineMs;
    worker = startChild(["run", project, stateDirectory]);
    const workerResult = await waitForChild(worker, remaining(deadline));
    expect(workerResult, `Concurrent failure worker failed: ${workerResult.stderr || workerResult.stdout}`).toMatchObject({ code: 0, signal: null });
    const report = JSON.parse(workerResult.stdout) as CaseReport;
    expect(report.outcome?.kind).toBe("result");
    expect(report.outcome?.result?.status).toBe("error");
    const runId = report.runId;
    expect(typeof runId).toBe("string");
    if (typeof runId !== "string") throw new Error(`Worker omitted run ID: ${workerResult.stdout}`);

    const events = readEvents(stateDirectory);
    const bHeld = oneEvent(events, "b_raw_delivery_held");
    const blocker = oneEvent(events, "a_blocker_created");
    const aDelivery = oneEvent(events, "a_raw_response_delivery");
    const storageFailure = oneEvent(events, "a_storage_write_failed");
    const bAbort = oneEvent(events, "b_graph_stop_observed");
    const bDelivery = oneEvent(events, "b_raw_response_delivery");
    // The storage observer proves the OS failure was seen before B's stop/delivery;
    // synchronous poison-before-abort ordering is established by the production callback path.
    expect(bHeld.sequence).toBeLessThan(blocker.sequence);
    expect(blocker.sequence).toBeLessThan(aDelivery.sequence);
    expect(aDelivery.sequence).toBeLessThan(storageFailure.sequence);
    expect(storageFailure.sequence).toBeLessThan(bAbort.sequence);
    expect(bAbort.sequence).toBeLessThan(bDelivery.sequence);
    expect(storageFailure).toMatchObject({ targetIsDirectory: true });
    expect(typeof storageFailure.errorCode).toBe("string");
    expect(String(storageFailure.errorMessage).length).toBeGreaterThan(0);
    expect(storageFailure.errorSyscall).toBe("rename");
    expect(typeof storageFailure.errorDest).toBe("string");
    expect(bAbort.reason).toMatchObject({ source: "nodulus.graph", kind: "graph_stop", code: "GRAPH_CANCELLED" });

    const target = String(blocker.target);
    const expectedTarget = path.join(canonicalProject, ".nodulus", "runs", runId, "nodes", "a", "artifacts", "report.json");
    expect(realpathSync.native(String(storageFailure.errorDest))).toBe(expectedTarget);
    expect(realpathSync.native(target)).toBe(expectedTarget);
    expect(statSync(target).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(String(blocker.blockerMarker), "utf8"))).toMatchObject({ nodeId: "a", target });

    const checkpointPath = path.join(project, ".nodulus", "runs", runId, "run.json");
    const checkpointBytes = readFileSync(checkpointPath);
    const checkpointPublishes = events.filter((event) => event.event === "checkpoint_published");
    expect(checkpointPublishes.length).toBeGreaterThan(0);
    const lastPublish = checkpointPublishes.at(-1);
    expect(lastPublish).toBeDefined();
    expect(lastPublish?.checkpointBytesBase64).toBe(checkpointBytes.toString("base64"));
    expect(lastPublish?.checkpointSha256).toBe(sha256(checkpointBytes));

    const checkpoint = JSON.parse(checkpointBytes.toString("utf8")) as {
      schemaVersion: number;
      status: string;
      completedNodes: string[];
      graph: { admissionClosed: boolean; nodes: Record<string, { phase: string; accepted?: unknown }> };
    };
    expect(checkpoint).toMatchObject({ schemaVersion: 2, status: "running", completedNodes: [] });
    expect(checkpoint.graph.nodes.a).toMatchObject({ phase: "active" });
    expect(checkpoint.graph.nodes.b).toMatchObject({ phase: "active" });
    expect(checkpoint.graph.nodes.a.accepted).toBeUndefined();
    expect(checkpoint.graph.nodes.b.accepted).toBeUndefined();
    expect(checkpoint.graph.nodes.successor.phase).toBe("not_started");

    const runEvents = readFileSync(path.join(project, ".nodulus", "runs", runId, "events.jsonl"), "utf8")
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { event?: unknown; nodeId?: unknown });
    expect(runEvents.some(({ event }) => event === "node.accepted" || event === "run.completed" || event === "run.failed")).toBe(false);
    expect(runEvents.some(({ event, nodeId }) => nodeId === "successor" || event === "run.completed")).toBe(false);

    const aProcess = oneNodeEvent(events, "provider_process_captured", "a");
    expect(aProcess).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false, pidExited: true });
    const bProcess = oneNodeEvent(events, "provider_process_captured", "b");
    expect(bProcess).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false, pidExited: true });
    const bCallId = String(bProcess.callId);
    const transportBytes = readFileSync(path.join(project, ".nodulus", "runs", runId, "calls", bCallId, "transport.json"));
    expect(sha256(transportBytes)).toBe(bProcess.transportSha256);
    const transport = JSON.parse(transportBytes.toString("utf8")) as Record<string, unknown>;
    expect(transport).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false });
    expect(transport.stdout).toBe(bProcess.rawResponse);

    const outcome = report.outcome?.result;
    expect(outcome?.result).toMatchObject({ error: { code: "RUN_STORAGE_FAILED" } });
    const publicError = (outcome?.result as { error?: { message?: unknown } } | undefined)?.error;
    expect(publicError?.message).toContain(String(storageFailure.errorMessage));
    const probeEvents = events.filter((event) => event.event === "provider_probe");
    expect(probeEvents.map(({ profileModel }) => String(profileModel)).sort((left, right) => left.localeCompare(right))).toEqual(["profile-a", "profile-b"]);
    expect(report.probeCounts).toEqual({ "profile-a": 1, "profile-b": 1 });
    expect(report.invokeCounts).toEqual({ a: 1, b: 1 });
    expect(events.some((event) => event.event === "provider_process_captured" && event.nodeId === "successor")).toBe(false);
    expect(existsSync(path.join(stateDirectory, "started-successor.json"))).toBe(false);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    const cleanupDeadline = Date.now() + sharedCleanupDeadlineMs;
    if (worker) {
      try {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
        await waitForChild(worker, remaining(cleanupDeadline));
      } catch (error) {
        cleanupErrors.push(`Owned scenario worker ${String(worker.child.pid)} did not close cleanly: ${messageOf(error)}`);
      }
    }
    for (const nodeId of ["a", "b", "successor"]) {
      try {
        const pid = readProviderPid(stateDirectory, nodeId);
        if (pid === undefined || ownedPidExited(pid)) continue;
        try { process.kill(pid); }
        catch (error) { cleanupErrors.push(`Could not stop owned provider ${pid}: ${messageOf(error)}`); }
        if (!await waitForPidExit(pid, remaining(cleanupDeadline))) cleanupErrors.push(`Owned provider ${pid} exit could not be confirmed.`);
      } catch (error) {
        cleanupErrors.push(`Provider ${nodeId} ownership could not be verified: ${messageOf(error)}`);
      }
    }
    if (cleanupErrors.length === 0) {
      try {
        assertOwnedProject(project, canonicalProject);
        rmSync(project, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(`Owned project was retained: ${messageOf(error)}`);
      }
    }
  }
  if (cleanupErrors.length > 0) {
    const detail = `${cleanupErrors.join("; ")} Project retained at ${project}.`;
    if (primaryError instanceof Error) primaryError.message += ` Cleanup: ${detail}`;
    else if (!hasPrimaryError) {
      primaryError = new Error(detail);
      hasPrimaryError = true;
    }
  }
  if (hasPrimaryError) throw primaryError;
}, testCeilingMs);

function configureConcurrentFailureGraph(project: string): void {
  const settings = readProjectJson(project, ".nodulus/settings.json") as { providerProfiles: Record<string, Record<string, unknown>> };
  const sourceProfile = settings.providerProfiles.fixture;
  if (!sourceProfile) throw new Error("Parallel project did not create its fixture provider profile.");
  settings.providerProfiles = {
    a: { ...sourceProfile, model: "profile-a", timeoutMs: 60_000 },
    b: { ...sourceProfile, model: "profile-b", timeoutMs: 60_000 },
    successor: { ...sourceProfile, model: "profile-successor", timeoutMs: 60_000 },
  };
  writeJson(project, ".nodulus/settings.json", settings);
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 2,
    id: "example",
    nodes: ["a", "b", "successor"],
    execution: { kind: "dag", maxConcurrency: 2, dependsOn: { a: [], b: [], successor: ["a", "b"] }, resources: { a: [], b: [], successor: [] } },
    outputs: [
      { name: "aOutput", from: "a.report", contract: "report.v1" },
      { name: "bOutput", from: "b.report", contract: "report.v1" },
      { name: "successorOutput", from: "successor.report", contract: "report.v1" },
    ],
  });
  for (const [id, inputName, source, profile] of [
    ["a", "request", "request", "a"],
    ["b", "request", "request", "b"],
    ["successor", "a", "a.report", "successor"],
  ] as const) {
    writeJson(project, `.nodulus/nodes/${id}.json`, {
      schemaVersion: 1,
      id,
      providerProfile: profile,
      instructions: [`.nodulus/instructions/${id}.md`],
      inputs: { [inputName]: { from: source, contract: source === "request" ? "request.v1" : "report.v1" } },
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
  }
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("P16B bounded deadline expired.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.result,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned child ${String(handle.child.pid)} exceeded its bounded wait.`)), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function readEvents(directory: string): LoggedEvent[] {
  return readFileSync(path.join(directory, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEvent);
}

function oneEvent(events: LoggedEvent[], name: string): LoggedEvent {
  const matches = events.filter((event) => event.event === name);
  expect(matches, `Expected exactly one '${name}' event.`).toHaveLength(1);
  const match = matches[0];
  if (!match) throw new Error(`Missing event '${name}'.`);
  return match;
}

function oneNodeEvent(events: LoggedEvent[], name: string, nodeId: string): LoggedEvent {
  const matches = events.filter((event) => event.event === name && event.nodeId === nodeId);
  expect(matches, `Expected exactly one '${name}' event for '${nodeId}'.`).toHaveLength(1);
  const match = matches[0];
  if (!match) throw new Error(`Missing '${name}' event for '${nodeId}'.`);
  return match;
}

function readProviderPid(directory: string, nodeId: string): number | undefined {
  const file = path.join(directory, `started-${nodeId}.json`);
  if (!existsSync(file)) return undefined;
  const record = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; nodeId?: unknown };
  if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.nodeId !== nodeId) {
    throw new Error(`Owned provider PID record '${nodeId}' is invalid.`);
  }
  return record.pid;
}

function ownedPidExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ownedPidExited(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return ownedPidExited(pid);
}

function assertOwnedProject(project: string, canonicalProject: string): void {
  const actual = realpathSync.native(project);
  const temp = realpathSync.native(os.tmpdir());
  expect(actual).toBe(canonicalProject);
  expect(actual.startsWith(`${temp}${path.sep}`)).toBe(true);
  expect(path.basename(actual)).toMatch(/^nodulus-par-016-concurrent-write-failure-/);
}

function sha256(contents: string | Buffer): string { return createHash("sha256").update(contents).digest("hex"); }
function remaining(deadline: number): number { return Math.max(0, deadline - Date.now()); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

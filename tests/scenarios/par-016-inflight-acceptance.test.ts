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
type FixtureEvent = { sequence: number; event: string; [key: string]: unknown };
type ScenarioReport = {
  runId?: string;
  outcome?: { kind?: string; result?: { status?: string; result?: unknown }; error?: Record<string, unknown> };
  probeCounts?: Record<string, number>;
  invokeCounts?: Record<string, number>;
  originalStorageErrorSeen?: boolean;
  aFailureDelivered?: boolean;
  bAcceptanceCaptured?: boolean;
};
type Checkpoint = {
  status: string;
  completedNodes: string[];
  graph: { nodes: Record<string, { phase?: string; accepted?: AcceptedRecord; callId?: string }> };
};
type AcceptedRecord = {
  callId: string;
  artifacts: Array<{ ref: string; sha256: string }>;
  resultRef: string;
  resultSha256: string;
  validationRef: string;
  validationSha256: string;
  responseRef: string;
  responseSha256: string;
};

const fixturePath = fileURLToPath(new URL("../fixtures/par-016-inflight-provider.mjs", import.meta.url));
const scenarioBudgetMs = 18_000;
const sharedCleanupDeadlineMs = 8_000;
const testCeilingMs = 35_000;

test("PAR-016B2 preserves a durable sibling acceptance while its storage return is in flight", async () => {
  const project = createInitializedProject("par-016-inflight-acceptance");
  const canonicalProject = realpathSync.native(project);
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "par-016-inflight-state");
  let worker: ChildHandle | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: string[] = [];

  try {
    configureParallelProject(project);
    configureInflightGraph(project);
    const deadline = Date.now() + scenarioBudgetMs;
    worker = startScenarioChild(["run", project, stateDirectory, String(deadline)]);
    const childResult = await waitForChild(worker, remaining(deadline));
    expect(childResult, `P16B2 scenario worker failed: ${childResult.stderr || childResult.stdout}`).toMatchObject({ code: 0, signal: null });
    const report = JSON.parse(childResult.stdout) as ScenarioReport;
    expect(report.outcome?.kind).toBe("result");
    expect(report.outcome?.result?.status).toBe("error");
    expect(report.originalStorageErrorSeen).toBe(true);
    expect(report.aFailureDelivered).toBe(true);
    expect(report.bAcceptanceCaptured).toBe(true);
    expect(typeof report.runId).toBe("string");
    if (typeof report.runId !== "string") throw new Error(`P16B2 worker omitted run ID: ${childResult.stdout}`);

    const events = readFixtureEvents(stateDirectory);
    const aCaptured = oneEvent(events, "provider_process_captured", (event) => event.nodeId === "a");
    const bCaptured = oneEvent(events, "provider_process_captured", (event) => event.nodeId === "b");
    const blocker = oneEvent(events, "a_storage_write_failed_held");
    const bDelivered = oneEvent(events, "b_response_delivered");
    const accepted = oneEvent(events, "b_accepted_checkpoint_held");
    const heldReturn = oneEvent(events, "b_storage_return_held");
    const aReleased = oneEvent(events, "a_storage_error_released");
    const barrier = oneEvent(events, "a_error_delivery_microtask_barrier");
    const bReleased = oneEvent(events, "b_successful_storage_return_released");
    const settled = oneEvent(events, "workflow_settled");
    const finalCheckpoint = oneEvent(events, "final_checkpoint");
    expect(aCaptured.sequence).toBeLessThan(blocker.sequence);
    expect(bCaptured.sequence).toBeLessThan(bDelivered.sequence);
    expect(blocker.sequence).toBeLessThan(accepted.sequence);
    expect(blocker.sequence).toBeLessThan(bDelivered.sequence);
    expect(bDelivered.sequence).toBeLessThan(accepted.sequence);
    expect(accepted.sequence).toBeLessThan(heldReturn.sequence);
    expect(heldReturn.sequence).toBeLessThan(aReleased.sequence);
    expect(aReleased.sequence).toBeLessThan(barrier.sequence);
    expect(barrier.sequence).toBeLessThan(bReleased.sequence);
    expect(bReleased.sequence).toBeLessThan(settled.sequence);
    expect(settled.sequence).toBeLessThan(finalCheckpoint.sequence);
    expect(blocker).toMatchObject({ nodeId: "a", blockerIsDirectory: true });
    expect(aReleased.sameException).toBe(true);
    expect(typeof blocker.errorCode).toBe("string");
    expect(typeof blocker.errorMessage).toBe("string");
    expect(typeof blocker.errorPath).toBe("string");
    expect(typeof accepted.checkpointBase64).toBe("string");
    expect(accepted.aCallCompletedBeforeB).toBe(true);
    expect(finalCheckpoint.matchesAcceptedSnapshot).toBe(true);
    expect(aCaptured).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false, pidExited: true });
    expect(bCaptured).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false, pidExited: true });

    const blockerPath = String(blocker.target);
    const expectedBlockerPath = path.join(canonicalProject, ".nodulus", "runs", report.runId, "nodes", "a", "artifacts", "report.json");
    expect(realpathSync.native(blockerPath)).toBe(expectedBlockerPath);
    expect(statSync(blockerPath).isDirectory()).toBe(true);
    expect(realpathSync.native(path.dirname(blockerPath))).toBe(path.dirname(expectedBlockerPath));

    const checkpointPath = path.join(project, ".nodulus", "runs", report.runId, "run.json");
    const eventPath = path.join(project, ".nodulus", "runs", report.runId, "events.jsonl");
    const acceptedCheckpointBytes = Buffer.from(String(accepted.checkpointBase64), "base64");
    const acceptedEventsBytes = Buffer.from(String(accepted.eventsBase64), "base64");
    expect(sha256(acceptedCheckpointBytes)).toBe(accepted.checkpointSha256);
    expect(sha256(acceptedEventsBytes)).toBe(accepted.eventsSha256);
    expect(readFileSync(checkpointPath)).toEqual(acceptedCheckpointBytes);
    expect(readFileSync(eventPath)).toEqual(acceptedEventsBytes);
    const checkpoint = JSON.parse(acceptedCheckpointBytes.toString("utf8")) as Checkpoint;
    expect(checkpoint.status).toBe("running");
    expect(checkpoint.completedNodes).toEqual(["b"]);
    expect(checkpoint.graph.nodes.a).toMatchObject({ phase: "active" });
    expect(checkpoint.graph.nodes.a?.accepted).toBeUndefined();
    expect(checkpoint.graph.nodes.b?.phase).toBe("accepted");
    const bAccepted = checkpoint.graph.nodes.b?.accepted;
    expect(bAccepted).toBeDefined();
    if (!bAccepted) throw new Error("P16B2 durable checkpoint omitted B's accepted references.");
    assertAcceptedReferences(project, report.runId, bAccepted);

    const runEvents = parseJsonLines(acceptedEventsBytes.toString("utf8")) as Array<{ event?: string; nodeId?: string; operation?: string; callId?: string }>;
    const aCompleted = runEvents.find((event) => event.event === "provider.call.completed" && event.nodeId === "a" && event.operation === "invoke");
    const bAcceptedEvent = runEvents.find((event) => event.event === "node.accepted" && event.nodeId === "b");
    expect(aCompleted).toBeDefined();
    expect(bAcceptedEvent).toBeDefined();
    expect(aCompleted?.callId).toBe(String(aCaptured.callId));
    expect(runEvents.some((event) => event.nodeId === "c" || event.event === "run.completed" || event.event === "run.failed")).toBe(false);

    const aTransportBytes = readTransportBytes(project, report.runId, String(aCaptured.callId));
    const bTransportBytes = readTransportBytes(project, report.runId, String(bCaptured.callId));
    expect(sha256(aTransportBytes)).toBe(aCaptured.transportSha256);
    expect(sha256(bTransportBytes)).toBe(bCaptured.transportSha256);
    const aTransport = JSON.parse(aTransportBytes.toString("utf8")) as Record<string, unknown>;
    const bTransport = JSON.parse(bTransportBytes.toString("utf8")) as Record<string, unknown>;
    expect(aTransport).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false });
    expect(bTransport).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false });
    expect(aTransport.stdout).toBe(aCaptured.rawResponse);
    expect(bTransport.stdout).toBe(bCaptured.rawResponse);
    expect(sha256(readFileSync(path.join(project, ".nodulus", "runs", report.runId, bAccepted.resultRef)))).toBe(bAccepted.resultSha256);

    expect(report.probeCounts).toMatchObject({ "profile-a": 1, "profile-b": 1 });
    expect(report.probeCounts).not.toHaveProperty("profile-c");
    expect(report.invokeCounts).toEqual({ a: 1, b: 1 });
    const publicError = (report.outcome?.result?.result as { error?: Record<string, unknown> } | undefined)?.error;
    expect(publicError).toMatchObject({ code: "RUN_STORAGE_FAILED" });
    expect(String(publicError?.message)).toContain(String(blocker.errorMessage));
    expect(String(publicError?.message)).toContain(blockerPath);
    expect(events.some((event) => event.event === "provider_probe" && event.profileModel === "profile-c")).toBe(false);
    expect(events.some((event) => event.event === "provider_process_captured" && event.nodeId === "c")).toBe(false);
    expect(existsSync(path.join(stateDirectory, "started-c.json"))).toBe(false);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    const cleanupDeadline = Date.now() + sharedCleanupDeadlineMs;
    if (worker) {
      try {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
        await waitForChild(worker, remaining(cleanupDeadline));
      } catch (error) { cleanupErrors.push(`P16B2 scenario worker ${String(worker.child.pid)} did not close cleanly: ${messageOf(error)}`); }
    }
    for (const nodeId of ["a", "b", "c"]) {
      try {
        const pid = readProviderPid(stateDirectory, nodeId);
        if (pid === undefined || ownedPidExited(pid)) continue;
        try { process.kill(pid); }
        catch (error) { cleanupErrors.push(`Could not stop owned P16B2 provider ${pid}: ${messageOf(error)}`); }
        if (!await waitForPidExit(pid, remaining(cleanupDeadline))) cleanupErrors.push(`Owned P16B2 provider ${pid} exit was not confirmed.`);
      } catch (error) { cleanupErrors.push(`P16B2 provider ${nodeId} ownership could not be verified: ${messageOf(error)}`); }
    }
    if (cleanupErrors.length === 0) {
      try { assertOwnedProject(project, canonicalProject); rmSync(project, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(`Owned project was retained: ${messageOf(error)}`); }
    }
  }
  if (hasPrimaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors.map((detail) => new Error(detail))], `P16B2 primary failure; project retained at ${project}.`);
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors.map((detail) => new Error(detail)), `P16B2 cleanup failed; project retained at ${project}.`);
  if (hasPrimaryError) throw primaryError;
}, testCeilingMs);

function configureInflightGraph(project: string): void {
  const settings = readProjectJson(project, ".nodulus/settings.json") as { providerProfiles: Record<string, Record<string, unknown>> };
  const source = settings.providerProfiles.fixture;
  if (!source) throw new Error("P16B2 setup has no fixture provider profile.");
  settings.providerProfiles = {
    a: { ...source, model: "profile-a", timeoutMs: 20_000 },
    b: { ...source, model: "profile-b", timeoutMs: 20_000 },
    c: { ...source, model: "profile-c", timeoutMs: 20_000 },
  };
  writeJson(project, ".nodulus/settings.json", settings);
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 2,
    id: "example",
    nodes: ["a", "b", "c"],
    execution: { kind: "dag", maxConcurrency: 2, dependsOn: { a: [], b: [], c: ["b"] }, resources: { a: [], b: [], c: [] } },
    outputs: [
      { name: "aOutput", from: "a.report", contract: "report.v1" },
      { name: "bOutput", from: "b.report", contract: "report.v1" },
      { name: "cOutput", from: "c.report", contract: "report.v1" },
    ],
  });
  for (const id of ["a", "b", "c"]) {
    writeJson(project, `.nodulus/nodes/${id}.json`, {
      schemaVersion: 1,
      id,
      providerProfile: id,
      instructions: [`.nodulus/instructions/${id}.md`],
      inputs: { request: { from: "request", contract: "request.v1" } },
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
  }
}

function startScenarioChild(args: string[]): ChildHandle {
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("P16B2 bounded deadline expired.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.result,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned P16B2 worker ${String(handle.child.pid)} exceeded its bounded wait.`)), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function readFixtureEvents(directory: string): FixtureEvent[] {
  return parseJsonLines(readFileSync(path.join(directory, "events.jsonl"), "utf8")) as FixtureEvent[];
}
function parseJsonLines(text: string): unknown[] { return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown); }
function oneEvent(events: FixtureEvent[], name: string, predicate: (event: FixtureEvent) => boolean = () => true): FixtureEvent {
  const matches = events.filter((event) => event.event === name && predicate(event));
  expect(matches, `Expected exactly one P16B2 '${name}' milestone.`).toHaveLength(1);
  const match = matches[0];
  if (!match) throw new Error(`Missing P16B2 milestone '${name}'.`);
  return match;
}
function readProviderPid(directory: string, nodeId: string): number | undefined {
  const file = path.join(directory, `started-${nodeId}.json`);
  if (!existsSync(file)) return undefined;
  const record = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; nodeId?: unknown };
  if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.nodeId !== nodeId) throw new Error(`Invalid owned P16B2 PID record for '${nodeId}'.`);
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return ownedPidExited(pid);
}
function assertOwnedProject(project: string, canonicalProject: string): void {
  const actual = realpathSync.native(project);
  const temp = realpathSync.native(os.tmpdir());
  if (actual !== canonicalProject || path.dirname(actual) !== temp || !path.basename(actual).startsWith("nodulus-par-016-inflight-acceptance-")) {
    throw new Error(`Refusing recursive cleanup outside the exact generated project '${canonicalProject}'.`);
  }
}
function assertAcceptedReferences(project: string, runId: string, accepted: AcceptedRecord): void {
  const runRoot = path.join(project, ".nodulus", "runs", runId);
  for (const [ref, expected] of [
    [accepted.resultRef, accepted.resultSha256],
    [accepted.validationRef, accepted.validationSha256],
    [accepted.responseRef, accepted.responseSha256],
    ...accepted.artifacts.map(({ ref, sha256: digest }) => [ref, digest] as [string, string]),
  ] as Array<[string, string]>) {
    const file = path.join(runRoot, ref);
    const content = readFileSync(file);
    expect(sha256(content), `Accepted B reference hash mismatch: ${ref}`).toBe(expected);
  }
}
function readTransportBytes(project: string, runId: string, callId: string): Buffer {
  return readFileSync(path.join(project, ".nodulus", "runs", runId, "calls", callId, "transport.json"));
}
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function remaining(deadline: number): number { return Math.max(0, deadline - Date.now()); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Non-Error cleanup failure."; }

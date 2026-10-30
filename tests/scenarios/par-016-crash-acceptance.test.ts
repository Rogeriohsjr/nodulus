import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject } from "../support/parallel-project.js";
import { writeJson } from "../support/workflow-sequence.js";

type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type ChildHandle = { child: ChildProcess; result: Promise<ChildResult> };
type AcceptedEvidence = {
  resultRef: string;
  resultSha256: string;
  validationRef: string;
  validationSha256: string;
  responseRef: string;
  responseSha256: string;
  artifacts: Array<{ name: string; contract: string; ref: string; sha256: string }>;
};
type GraphCheckpoint = {
  schemaVersion: number;
  runId: string;
  status: string;
  completedNodes: string[];
  graph: { nodes: Record<string, { phase: string; attempt?: number; accepted?: AcceptedEvidence }> };
};

const fixturePath = fileURLToPath(new URL("../fixtures/par-016-crash-runner.mjs", import.meta.url));
const scenarioDeadlineMs = 15_000;
const sharedCleanupDeadlineMs = 8_000;
const testCeilingMs = 30_000;

test("PAR-016 files written before acceptance cannot authorize a node after a crash", async () => {
  await verifyCrashBoundary("before_acceptance");
}, testCeilingMs);

test("PAR-016 an accepted checkpoint survives a crash before scheduler delivery", async () => {
  await verifyCrashBoundary("after_acceptance");
}, testCeilingMs);

async function verifyCrashBoundary(milestone: "before_acceptance" | "after_acceptance"): Promise<void> {
  const project = createInitializedProject(`par-016-crash-acceptance-${milestone}`);
  configureParallelProject(project);
  configureCrashGraph(project);
  const canonicalProject = realpathSync.native(project);
  const marker = path.join(project, ".nodulus", "fixtures", `crash-${milestone}.json`);
  const providerState = path.join(project, ".nodulus", "fixtures", "par-016-provider-state");
  const deadline = Date.now() + scenarioDeadlineMs;
  let worker: ChildHandle | undefined;
  let inspector: ChildHandle | undefined;
  let workerClosed = false;
  let retainProject = false;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: string[] = [];

  try {
    worker = startChild(["run", project, milestone, marker, providerState]);
    const workerResult = await waitForChild(worker, remaining(deadline));
    workerClosed = true;
    expect(workerResult, `Crash worker output: ${workerResult.stderr || workerResult.stdout}`).toMatchObject({ code: 0, signal: null });
    expect(existsSync(marker), `Crash milestone marker was not written. ${workerResult.stderr || workerResult.stdout}`).toBe(true);
    const markerRecord = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
    expect(markerRecord).toMatchObject({ milestone, workerPid: worker.child.pid });
    const runId = markerRecord.runId;
    expect(typeof runId).toBe("string");
    if (typeof runId !== "string") throw new Error("Crash marker omitted run ID.");

    const providerRecord = readProviderRecord(providerState, "root");
    expect(providerRecord).toMatchObject({ nodeId: "root", finished: true });
    expect(markerRecord.providerPid).toBe(providerRecord.pid);
    expect(existsSync(path.join(providerState, "started-successor.json"))).toBe(false);

    const runDirectory = path.join(project, ".nodulus", "runs", runId);
    const checkpointText = readFileSync(path.join(runDirectory, "run.json"), "utf8");
    const checkpoint = JSON.parse(checkpointText) as GraphCheckpoint;
    expect(checkpoint).toMatchObject({ schemaVersion: 2, runId, status: "running" });
    expect(checkpoint.graph.nodes.successor.phase).toBe("not_started");

    if (milestone === "before_acceptance") {
      expect(checkpoint.completedNodes).toEqual([]);
      expect(checkpoint.graph.nodes.root).toMatchObject({ phase: "active", attempt: 1 });
      expect(checkpoint.graph.nodes.root.accepted).toBeUndefined();
      const resultText = readFileSync(path.join(runDirectory, "nodes/root/attempt-001/result.json"), "utf8");
      const validationText = readFileSync(path.join(runDirectory, "nodes/root/attempt-001/validation.json"), "utf8");
      const artifactText = readFileSync(path.join(runDirectory, "nodes/root/artifacts/report.json"), "utf8");
      expect(JSON.parse(resultText)).toMatchObject({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "done:root" } }] });
      expect(JSON.parse(validationText)).toMatchObject({ valid: true, outcome: "success" });
      expect(JSON.parse(artifactText)).toMatchObject({ name: "report", contract: "report.v1", data: { text: "done:root" } });
    } else {
      const accepted = checkpoint.graph.nodes.root.accepted;
      expect(accepted).toBeDefined();
      if (!accepted) throw new Error("Accepted root checkpoint omitted its evidence references.");
      expect(checkpoint.completedNodes).toEqual(["root"]);
      expect(checkpoint.graph.nodes.root.phase).toBe("accepted");
      assertReferencedFile(runDirectory, accepted.resultRef, accepted.resultSha256);
      assertReferencedFile(runDirectory, accepted.validationRef, accepted.validationSha256);
      assertReferencedFile(runDirectory, accepted.responseRef, accepted.responseSha256);
      expect(accepted.artifacts).toHaveLength(1);
      for (const artifact of accepted.artifacts as Array<Record<string, string>>) {
        expect(artifact).toMatchObject({ name: "report", contract: "report.v1" });
        assertReferencedFile(runDirectory, artifact.ref, artifact.sha256);
      }
    }

    const beforeFreshProcess = hashRunFiles(runDirectory);
    inspector = startChild(["inspect", project, runId]);
    const inspectResult = await waitForChild(inspector, remaining(deadline));
    expect(inspectResult, `Fresh status/resume process output: ${inspectResult.stderr}`).toMatchObject({ code: 0, signal: null });
    const report = JSON.parse(inspectResult.stdout) as {
      status?: unknown;
      checkpoint?: { status?: unknown };
      resumeError?: { code?: unknown };
      providerProbeCount?: unknown;
      providerInvokeCount?: unknown;
    };
    expect(report.status).toBe("running");
    const inspectedCheckpoint = report.checkpoint;
    expect(inspectedCheckpoint).toBeDefined();
    if (!inspectedCheckpoint) throw new Error("Fresh recovery inspector omitted checkpoint state.");
    expect(inspectedCheckpoint.status).toBe("running");
    expect(report.resumeError).toMatchObject({ code: "RUN_RECOVERY_REQUIRED" });
    expect(report.providerProbeCount).toBe(0);
    expect(report.providerInvokeCount).toBe(0);
    expect(hashRunFiles(runDirectory)).toEqual(beforeFreshProcess);
    expect(existsSync(path.join(providerState, "started-successor.json"))).toBe(false);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    const cleanupDeadline = Date.now() + sharedCleanupDeadlineMs;
    for (const handle of [inspector, worker]) {
      if (!handle) continue;
      try {
        if (handle.child.exitCode === null && handle.child.signalCode === null) {
          handle.child.kill();
        }
        await waitForChild(handle, remaining(cleanupDeadline));
        if (handle === worker) workerClosed = true;
      } catch (error) {
        cleanupErrors.push(`Owned worker ${String(handle.child.pid)} did not close cleanly: ${messageOf(error)}`);
      }
    }
    try {
      const closure = providerClosureEvidence(providerState, marker, milestone, workerClosed, worker?.child.pid);
      if (closure.started && !closure.closed) {
        cleanupErrors.push(`Nested provider close was not established from the completed crash milestone and worker close; project retained at ${project}.`);
      }
    } catch (error) {
      cleanupErrors.push(`Nested provider close evidence could not be verified: ${messageOf(error)}`);
    }
    if (hasPrimaryError) retainProject = true;
    if (cleanupErrors.length > 0) retainProject = true;
    if (!retainProject) {
      try {
        assertOwnedProject(project, canonicalProject);
        rmSync(project, { recursive: true, force: true });
      } catch (error) {
        retainProject = true;
        cleanupErrors.push(`Owned project was retained: ${messageOf(error)}`);
      }
    }
  }
  if (hasPrimaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors.map((detail) => new Error(detail))], `P16 crash primary failure; project retained at ${project}.`);
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors.map((detail) => new Error(detail)), `P16 crash cleanup failed; project retained at ${project}.`);
  if (hasPrimaryError) throw primaryError;
}

function configureCrashGraph(project: string): void {
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
  for (const [id, inputs] of [
    ["root", { request: { from: "request", contract: "request.v1" } }],
    ["successor", { root: { from: "root.report", contract: "report.v1" } }],
  ] as const) {
    writeJson(project, `.nodulus/nodes/${id}.json`, {
      schemaVersion: 1,
      id,
      providerProfile: "fixture",
      instructions: [`.nodulus/instructions/${id}.md`],
      inputs,
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("P16A shared scenario deadline expired.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.result,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned child ${String(handle.child.pid)} exceeded its bounded wait.`)), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function assertReferencedFile(runDirectory: string, reference: string, expectedHash: string): void {
  const file = path.resolve(runDirectory, reference);
  expect(file.startsWith(`${path.resolve(runDirectory)}${path.sep}`)).toBe(true);
  const bytes = readFileSync(file);
  expect(sha256(bytes)).toBe(expectedHash);
}

function hashRunFiles(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of requireDirectoryEntries(current)) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result[path.relative(directory, absolute)] = sha256(readFileSync(absolute));
    }
  };
  visit(directory);
  return result;
}

function requireDirectoryEntries(directory: string): import("node:fs").Dirent[] {
  // Kept synchronous so the snapshot is taken without yielding to the observer or engine.
  return readdirSync(directory, { withFileTypes: true });
}

function readProviderRecord(directory: string, nodeId: string): { pid: number; nodeId: string; callId: string; finished: boolean } {
  const started = JSON.parse(readFileSync(path.join(directory, `started-${nodeId}.json`), "utf8")) as { pid?: unknown; nodeId?: unknown; callId?: unknown };
  const record = JSON.parse(readFileSync(path.join(directory, `finished-${nodeId}.json`), "utf8")) as { pid?: unknown; nodeId?: unknown; callId?: unknown; finished?: unknown };
  if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.nodeId !== nodeId ||
      record.finished !== true || started.pid !== record.pid || started.nodeId !== nodeId || typeof started.callId !== "string" || record.callId !== started.callId) {
    throw new Error(`Provider exit evidence for '${nodeId}' is invalid.`);
  }
  return { pid: record.pid, nodeId, callId: started.callId, finished: true };
}

function providerClosureEvidence(directory: string, marker: string, milestone: string, workerClosed: boolean, workerPid: number | undefined): { started: boolean; closed: boolean } {
  const startPath = path.join(directory, "started-root.json");
  if (!existsSync(startPath)) return { started: false, closed: true };
  const started = JSON.parse(readFileSync(startPath, "utf8")) as { pid?: unknown; nodeId?: unknown; callId?: unknown };
  if (typeof started.pid !== "number" || !Number.isSafeInteger(started.pid) || started.pid <= 0 ||
      started.nodeId !== "root" || typeof started.callId !== "string") throw new Error("Root provider start evidence is malformed.");
  let finished: ReturnType<typeof readProviderRecord>;
  try { finished = readProviderRecord(directory, "root"); }
  catch (error) { if (isMissingFile(error)) return { started: true, closed: false }; throw error; }
  if (finished.pid !== started.pid || finished.callId !== started.callId || !finished.finished) return { started: true, closed: false };
  if (!existsSync(marker)) return { started: true, closed: false };
  const milestoneRecord = JSON.parse(readFileSync(marker, "utf8")) as { milestone?: unknown; workerPid?: unknown; providerPid?: unknown };
  return {
    started: true,
    closed: workerClosed && workerPid !== undefined && milestoneRecord.milestone === milestone &&
      milestoneRecord.workerPid === workerPid && milestoneRecord.providerPid === started.pid,
  };
}

function assertOwnedProject(project: string, canonicalProject: string): void {
  const actual = realpathSync.native(project);
  const temp = realpathSync.native(os.tmpdir());
  expect(actual).toBe(canonicalProject);
  expect(actual.startsWith(`${temp}${path.sep}`)).toBe(true);
  expect(path.basename(actual)).toMatch(/^nodulus-par-016-crash-acceptance-/);
}

function remaining(deadline: number): number { return Math.max(0, deadline - Date.now()); }
function sha256(contents: string | Buffer): string { return createHash("sha256").update(contents).digest("hex"); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isMissingFile(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

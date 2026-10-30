import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  probes?: Record<string, number>;
  invocations?: Record<string, number>;
  repairs?: Record<string, number>;
};
type AcceptedRecord = {
  artifacts: Array<{ ref: string; sha256: string }>;
  resultRef: string;
  resultSha256: string;
  validationRef: string;
  validationSha256: string;
  responseRef: string;
  responseSha256: string;
};
type PolicyCheckpoint = { completedNodes: string[]; graph: { nodes: Record<string, { phase?: string; accepted?: AcceptedRecord }> } };
type CaseMode = "dependent" | "current";

const fixturePath = fileURLToPath(new URL("../fixtures/par-016-policy-provider.mjs", import.meta.url));
const scenarioBudgetMs = 18_000;
const sharedCleanupBudgetMs = 8_000;
const testCeilingMs = 35_000;
const validatorRelative = {
  dependent: ".nodulus/validators/policy-b.mjs",
  current: ".nodulus/validators/policy-held.mjs",
} as const;

test("PAR-016D rejects a changed dependent validator before B provider readiness", async () => {
  await runPolicyCase("dependent");
}, testCeilingMs);

test("PAR-016D rejects a changed current validator after held inference but before script execution", async () => {
  await runPolicyCase("current");
}, testCeilingMs);

async function runPolicyCase(mode: CaseMode): Promise<void> {
  const project = createInitializedProject(`par-016-validator-policy-${mode}`);
  const canonicalProject = realpathSync.native(project);
  const stateDirectory = path.join(project, ".nodulus", "fixtures", `par-016-policy-${mode}-state`);
  let worker: ChildHandle | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];

  try {
    configureParallelProject(project);
    configurePolicyGraph(project, mode, stateDirectory);
    const scenarioDeadline = Date.now() + scenarioBudgetMs;
    worker = startScenarioChild(["run", project, stateDirectory, mode, String(scenarioDeadline)]);
    const startedNode = mode === "dependent" ? "a" : "held";
    await waitForJson(path.join(stateDirectory, `started-${startedNode}.json`), scenarioDeadline, `${startedNode} provider child start`);
    const started = readJson(path.join(stateDirectory, `started-${startedNode}.json`));
    const runId = String(started.runId);
    const validatorPath = path.join(project, validatorRelative[mode]);
    const definitionsPath = path.join(project, ".nodulus", "runs", runId, "context", "definitions.json");
    const originalBytes = readFileSync(validatorPath);
    expect(realpathSync.native(validatorPath)).toBe(path.join(canonicalProject, validatorRelative[mode]));
    const definitionsBytes = readFileSync(definitionsPath);
    const definitions = JSON.parse(definitionsBytes.toString("utf8")) as { validatorHashes?: Record<string, string> };
    const capturedHash = definitions.validatorHashes?.[validatorRelative[mode]];
    expect(capturedHash).toBe(sha256(originalBytes));
    const originalPolicyHash = sha256(originalBytes);
    const changedBytes = createValidatorScript(stateDirectory, `${mode}-changed`);
    expect(sha256(changedBytes)).not.toBe(originalPolicyHash);
    const originalMarker = path.join(stateDirectory, `${mode}-original-executed.txt`);
    const changedMarker = path.join(stateDirectory, `${mode}-changed-executed.txt`);
    expect(existsSync(originalMarker)).toBe(false);
    expect(existsSync(changedMarker)).toBe(false);

    writeFileSync(validatorPath, changedBytes, { encoding: "utf8", flag: "w" });
    expect(sha256(readFileSync(validatorPath))).toBe(sha256(changedBytes));
    expect(sha256(readFileSync(validatorPath))).not.toBe(capturedHash);
    expect(readFileSync(definitionsPath)).toEqual(definitionsBytes);
    writeFileSync(path.join(stateDirectory, `release-${startedNode}.json`), "release\n", { encoding: "utf8", flag: "wx" });

    const childResult = await waitForChild(worker, remaining(scenarioDeadline));
    expect(childResult, `P16D scenario worker failed: ${childResult.stderr || childResult.stdout}`).toMatchObject({ code: 0, signal: null });
    const report = JSON.parse(childResult.stdout) as ScenarioReport;
    expect(report.runId).toBe(runId);
    expect(report.outcome?.kind).toBe("result");
    expect(report.outcome?.result?.status).toBe("error");
    const publicError = (report.outcome?.result?.result as { error?: Record<string, unknown> } | undefined)?.error;
    expect(publicError).toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(String(publicError?.message)).toContain("validator");
    expect(readFileSync(validatorPath)).toEqual(changedBytes);
    expect(readFileSync(definitionsPath)).toEqual(definitionsBytes);
    expect(existsSync(originalMarker)).toBe(false);
    expect(existsSync(changedMarker)).toBe(false);

    const events = readEvents(stateDirectory);
    const captures = events.filter((event) => event.event === "provider_process_captured");
    const heldCaptures = captures.filter((event) => event.nodeId === startedNode);
    expect(heldCaptures).toHaveLength(1);
    const heldCapture = heldCaptures[0];
    if (!heldCapture) throw new Error("P16D held provider process capture is missing.");
    expect(heldCapture).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false, pidExited: true });
    const heldTransportBytes = readFileSync(path.join(project, ".nodulus", "runs", runId, "calls", String(heldCapture.callId), "transport.json"));
    expect(sha256(heldTransportBytes)).toBe(heldCapture.transportSha256);
    expect(JSON.parse(heldTransportBytes.toString("utf8"))).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false, stdout: heldCapture.rawResponse });
    const runRoot = path.join(canonicalProject, ".nodulus", "runs", runId);
    const finalCheckpointBytes = readFileSync(path.join(runRoot, "run.json"));
    const finalCheckpoint = JSON.parse(finalCheckpointBytes.toString("utf8")) as PolicyCheckpoint;
    if (mode === "dependent") {
      expect(finalCheckpoint.completedNodes).toEqual(["a"]);
      expect(finalCheckpoint.graph.nodes.a).toMatchObject({ phase: "accepted" });
      const acceptedA = finalCheckpoint.graph.nodes.a?.accepted;
      expect(acceptedA).toBeDefined();
      if (!acceptedA) throw new Error("P16D checkpoint omitted A's accepted authority.");
      assertAcceptedHashes(runRoot, acceptedA);
      expect(finalCheckpoint.graph.nodes.b?.accepted).toBeUndefined();
    } else {
      expect(finalCheckpoint.completedNodes).toEqual([]);
      expect(finalCheckpoint.graph.nodes.held?.accepted).toBeUndefined();
    }

    // The held predecessor/current node has already completed with truthful transport,
    // and its final authority is checked before any assertion about the dependent provider.
    const runEvents = parseJsonLines(readFileSync(path.join(project, ".nodulus", "runs", runId, "events.jsonl"), "utf8")) as Array<{ event?: string; nodeId?: string; operation?: string; callId?: string }>;
    expect(runEvents.filter((event) => event.event === "provider.call.started" && event.nodeId === startedNode)).toHaveLength(1);
    expect(runEvents.filter((event) => event.event === "provider.call.completed" && event.nodeId === startedNode)).toHaveLength(1);
    expect(runEvents.some((event) => event.event === "node.accepted" && event.nodeId === (mode === "dependent" ? "b" : "held"))).toBe(false);
    expect(runEvents.some((event) => event.event === "node.started" && event.nodeId === "successor")).toBe(false);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toBe(heldCapture);
    if (mode === "dependent") {
      expect(runEvents.some((event) => event.event === "node.accepted" && event.nodeId === "a")).toBe(true);
      expect(events.some((event) => event.event === "provider_probe" && event.model === "profile-b")).toBe(false);
      expect(report.probes).toEqual({ "profile-a": 1 });
      expect(report.invocations).toEqual({ a: 1 });
      expect(events.some((event) => event.event === "provider_process_captured" && event.nodeId === "b")).toBe(false);
    } else {
      expect(report.probes).toEqual({ "profile-held": 1 });
      expect(report.invocations).toEqual({ held: 1 });
      expect(report.probes).not.toHaveProperty("profile-successor");
      expect(report.invocations).not.toHaveProperty("successor");
      expect(events.some((event) => event.event === "provider_probe" && event.model === "profile-successor")).toBe(false);
      expect(events.some((event) => event.event === "provider_process_captured" && event.nodeId === "successor")).toBe(false);
    }
    expect(report.repairs).toEqual({});
    expect(events.some((event) => event.event === "provider_repair_started")).toBe(false);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    const cleanupDeadline = Date.now() + sharedCleanupBudgetMs;
    try { writeFileSync(path.join(stateDirectory, "release-a.json"), "cleanup\n", "utf8"); } catch (error) { if (!isAlreadyExists(error)) cleanupErrors.push(toError(error)); }
    try { writeFileSync(path.join(stateDirectory, "release-held.json"), "cleanup\n", "utf8"); } catch (error) { if (!isAlreadyExists(error)) cleanupErrors.push(toError(error)); }
    if (worker) {
      try { await waitForChild(worker, Math.min(5_000, remaining(cleanupDeadline))); }
      catch (error) {
        try {
          if (worker.child.exitCode === null && worker.child.signalCode === null) {
            worker.child.kill();
            cleanupErrors.push(new Error(`P16D worker required force-stop after ${messageOf(error)}; retain its generated project for process review.`));
          }
        }
        catch (killError) { cleanupErrors.push(toError(killError)); }
        try { await waitForChild(worker, remaining(cleanupDeadline)); }
        catch (drainError) { cleanupErrors.push(toError(drainError)); }
      }
    }
    for (const nodeId of ["a", "held", "b", "successor"]) {
      try {
        const pid = readOwnedPid(stateDirectory, nodeId);
        if (pid === undefined || ownedPidExited(pid)) continue;
        try { process.kill(pid); } catch (error) { cleanupErrors.push(toError(error)); }
        if (!await waitForPidExit(pid, remaining(cleanupDeadline))) cleanupErrors.push(new Error(`Owned P16D provider PID ${pid} exit was not confirmed.`));
      } catch (error) { cleanupErrors.push(toError(error)); }
    }
    if (cleanupErrors.length === 0) {
      try { assertOwnedProject(project, canonicalProject); rmSync(project, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(toError(error)); }
    }
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], `P16D primary failure; retained project at ${project}.`);
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `P16D cleanup failed; retained project at ${project}.`);
}

function configurePolicyGraph(project: string, mode: CaseMode, stateDirectory: string): void {
  const validatorNode = mode === "dependent" ? "b" : "held";
  const markerBase = `${mode}`;
  const original = createValidatorScript(stateDirectory, `${markerBase}-original`);
  const validatorPath = path.join(project, validatorRelative[mode]);
  writeFileSync(validatorPath, original, "utf8");
  const settings = readProjectJson(project, ".nodulus/settings.json") as { providerProfiles: Record<string, Record<string, unknown>> };
  const source = settings.providerProfiles.fixture;
  if (!source) throw new Error("P16D setup lacks its fixture provider profile.");
  const ids = mode === "dependent" ? ["a", "b"] : ["held", "successor"];
  settings.providerProfiles = Object.fromEntries(ids.map((id) => [id, { ...source, model: `profile-${id}`, timeoutMs: 20_000 }]));
  writeJson(project, ".nodulus/settings.json", settings);
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 2,
    id: "example",
    nodes: ids,
    execution: {
      kind: "dag", maxConcurrency: 1,
      dependsOn: mode === "dependent" ? { a: [], b: ["a"] } : { held: [], successor: ["held"] },
      resources: Object.fromEntries(ids.map((id) => [id, []])),
    },
    outputs: ids.map((id) => ({ name: `${id}Output`, from: `${id}.report`, contract: "report.v1" })),
  });
  for (const id of ids) {
    writeJson(project, `.nodulus/nodes/${id}.json`, {
      schemaVersion: 1,
      id,
      providerProfile: id,
      instructions: [`.nodulus/instructions/${id}.md`],
      inputs: { request: { from: "request", contract: "request.v1" } },
      expectedOutputs: [{ name: "report", contract: "report.v1", ...(id === validatorNode ? { validator: validatorRelative[mode] } : {}) }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
  }
}

function createValidatorScript(stateDirectory: string, version: string): Buffer {
  const marker = path.join(stateDirectory, `${version}-executed.txt`);
  return Buffer.from(`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, ${JSON.stringify(version)});\nprocess.stdout.write('{"valid":true,"errors":[]}');\n`, "utf8");
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("P16D bounded wait deadline expired.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([handle.result, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`P16D worker ${String(handle.child.pid)} exceeded its bounded wait.`)), timeoutMs); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function waitForJson(file: string, deadline: number, label: string): Promise<Record<string, unknown>> {
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`P16D timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readJson(file);
}
function readJson(file: string): Record<string, unknown> { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; }
function readEvents(directory: string): FixtureEvent[] { return parseJsonLines(readFileSync(path.join(directory, "events.jsonl"), "utf8")) as FixtureEvent[]; }
function parseJsonLines(text: string): unknown[] { return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown); }
function readOwnedPid(directory: string, nodeId: string): number | undefined {
  const file = path.join(directory, `started-${nodeId}.json`);
  if (!existsSync(file)) return undefined;
  const record = readJson(file);
  if (record.nodeId !== nodeId || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error(`P16D owned PID record for '${nodeId}' is invalid.`);
  return record.pid;
}
function ownedPidExited(pid: number): boolean { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }
async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (ownedPidExited(pid)) return true; await new Promise((resolve) => setTimeout(resolve, 20)); }
  return ownedPidExited(pid);
}
function assertOwnedProject(project: string, canonicalProject: string): void {
  const actual = realpathSync.native(project);
  const temp = realpathSync.native(os.tmpdir());
  if (actual !== canonicalProject || path.dirname(actual) !== temp || !path.basename(actual).startsWith("nodulus-par-016-validator-policy-")) {
    throw new Error(`Refusing cleanup outside the exact generated P16D project '${canonicalProject}'.`);
  }
}
function sha256(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function assertAcceptedHashes(runRoot: string, accepted: AcceptedRecord): void {
  const references = [
    [accepted.resultRef, accepted.resultSha256],
    [accepted.validationRef, accepted.validationSha256],
    [accepted.responseRef, accepted.responseSha256],
    ...accepted.artifacts.map(({ ref, sha256: digest }) => [ref, digest] as [string, string]),
  ] as Array<[string, string]>;
  for (const [ref, digest] of references) {
    expect(sha256(readFileSync(path.join(runRoot, ref)))).toBe(digest);
  }
}
function remaining(deadline: number): number { return Math.max(0, deadline - Date.now()); }
function isAlreadyExists(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"; }
function toError(error: unknown): Error { return error instanceof Error ? error : new Error("Non-Error P16D cleanup failure."); }

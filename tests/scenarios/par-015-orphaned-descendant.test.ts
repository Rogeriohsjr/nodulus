import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { runWorkflow } from "../../src/index.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { createInitializedProject } from "../support/intake-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type FixtureEvent = { stage: string; pid: number; role: string; atMs: number; [key: string]: unknown };
type RunResult = Awaited<ReturnType<typeof runWorkflow>>;
type FirstReturnProcessSnapshot = { rootPid: number; descendantPid: number; rootAlive: boolean; descendantAlive: boolean; returnedAt: number };
type RunOutcome = { result?: RunResult; error?: unknown; processSnapshot?: FirstReturnProcessSnapshot };

const label = "par-015-orphaned-descendant";
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 35_000;
const fixturePath = fileURLToPath(new URL("../fixtures/par-015-orphaned-descendant-cli.mjs", import.meta.url));

test.skipIf(process.platform !== "win32")("P15C1 reports a settled cancelled root with a real orphaned descendant", async () => {
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  assertOwnedProject(project, projectIdentity);
  configureScenario(project);
  copyFileSync(fixturePath, path.join(project, ".nodulus", "fixtures", "par-015-orphaned-descendant-cli.mjs"));
  const controlRelative = ".nodulus/fixtures/par-015-orphaned-control.json";
  const eventsRelative = ".nodulus/fixtures/par-015-orphaned-events.jsonl";
  const controlAbsolute = path.join(project, controlRelative);
  const eventsAbsolute = path.join(project, eventsRelative);
  const paths = {
    heldRootStartedPath: ".nodulus/fixtures/par-015-held-root-started.json",
    heldRootReleasePath: ".nodulus/fixtures/par-015-held-root-release",
    intermediateChildPath: ".nodulus/fixtures/par-015-intermediate-child.json",
    descendantStartedPath: ".nodulus/fixtures/par-015-descendant-started.json",
    descendantReleasePath: ".nodulus/fixtures/par-015-descendant-release",
    stopperReleasePath: ".nodulus/fixtures/par-015-stopper-release",
    fixtureLifetimeMs,
  };
  writeFileSync(controlAbsolute, JSON.stringify(paths), { encoding: "utf8", flag: "wx" });
  writeFileSync(eventsAbsolute, "", { encoding: "utf8", flag: "wx" });

  let rootPid: number | undefined;
  let intermediatePid: number | undefined;
  let descendantPid: number | undefined;
  let outcome: RunOutcome | undefined;
  let run: Promise<RunOutcome> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];
  const scenarioDeadline = Date.now() + scenarioBudgetMs;

  try {
    assertOwnedProject(project, projectIdentity);
    const provider = createDefaultProviderPort(project);
    run = runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Exercise orphaned descendant cleanup after a separate graph branch fails." }],
    }, provider).then(
      (result) => {
        const returnedAt = performance.now();
        const processSnapshot = rootPid !== undefined && descendantPid !== undefined
          ? { rootPid, descendantPid, rootAlive: isProcessAlive(rootPid), descendantAlive: isProcessAlive(descendantPid), returnedAt }
          : undefined;
        const value: RunOutcome = { result, ...(processSnapshot ? { processSnapshot } : {}) };
        outcome = value;
        return value;
      },
      (error: unknown) => {
        const returnedAt = performance.now();
        const processSnapshot = rootPid !== undefined && descendantPid !== undefined
          ? { rootPid, descendantPid, rootAlive: isProcessAlive(rootPid), descendantAlive: isProcessAlive(descendantPid), returnedAt }
          : undefined;
        const value: RunOutcome = { error, ...(processSnapshot ? { processSnapshot } : {}) };
        outcome = value;
        return value;
      },
    );

    const rootMarker = await waitForJson(path.join(project, paths.heldRootStartedPath), scenarioDeadline, "held root start", () => outcome);
    rootPid = readOwnedPid(rootMarker.pid, "held root");
    const intermediateRecord = await waitForJson(path.join(project, paths.intermediateChildPath), scenarioDeadline, "intermediate child record", () => outcome);
    intermediatePid = readOwnedPid(intermediateRecord.pid, "intermediate");
    const descendantMarker = await waitForJson(path.join(project, paths.descendantStartedPath), scenarioDeadline, "descendant self marker", () => outcome);
    descendantPid = readOwnedPid(descendantMarker.pid, "descendant");
    expect(rootMarker.intermediatePid).toBe(intermediatePid);
    expect(rootMarker.descendantPid).toBe(descendantPid);
    expect(intermediateRecord.descendantPid).toBe(descendantPid);
    expect(isProcessAlive(rootPid), "Provider inference root must be alive before the separate failure trigger.").toBe(true);
    expect(isProcessAlive(intermediatePid), "Intermediate must have exited before the descendant is treated as orphaned.").toBe(false);
    expect(isProcessAlive(descendantPid), "Descendant must still be alive after its parent intermediate exited.").toBe(true);

    writeFileSync(path.join(project, paths.stopperReleasePath), "fail\n", { encoding: "utf8", flag: "wx" });
    const runResult = await withDeadline(run, scenarioDeadline, "public graph result");
    expect(runResult.result).toBeDefined();
    if (!runResult.result) throw runResult.error ?? new Error("Public graph run rejected instead of returning its failure result.");
    expect(runResult.processSnapshot).toMatchObject({
      rootPid,
      descendantPid,
      rootAlive: false,
      descendantAlive: true,
    });
    expect(runResult.result.status).toBe("error");

    const runId = runResult.result.runId;
    const checkpoint = readCheckpoint(project, runId);
    const graph = checkpoint.graph as { admissionClosed: boolean; recoveryRequired?: boolean; uncertainNodeIds?: string[]; cleanupUnverifiedNodeIds?: string[]; nodes: Record<string, Record<string, unknown>> };
    const heldNode = graph.nodes.held;
    const stopperNode = graph.nodes.stopper;
    expect(graph.admissionClosed).toBe(true);
    expect(heldNode).toMatchObject({
      phase: "failed",
      callId: expect.any(String),
      launch: true,
      failure: { code: "GRAPH_CANCELLED", message: expect.any(String) },
      cleanupUnverified: { code: "PROCESS_TREE_UNVERIFIED", operation: "invoke", message: expect.any(String) },
    });
    expect(graph.recoveryRequired).toBe(true);
    expect(graph.cleanupUnverifiedNodeIds).toEqual(["held"]);
    expect(graph.uncertainNodeIds).toBeUndefined();
    expect(stopperNode).toMatchObject({ phase: "failed", failure: { code: "P15C1_TRIGGER" } });
    const resultPayload = runResult.result.result as { error?: Record<string, unknown> };
    expect(resultPayload.error).toMatchObject({ code: "P15C1_TRIGGER", nodeId: "stopper", recoveryRequired: true, cleanupUnverifiedNodeIds: ["held"] });
    expect(resultPayload.error).not.toHaveProperty("uncertainNodeIds");
    const stopperCallId = String(stopperNode.callId);
    expect(resultPayload.error).toMatchObject({ callId: stopperCallId, launch: true });

    const events = readEvents(project, runId);
    const heldCallId = String(heldNode.callId);
    expect(events.filter((event) => event.event === "node.cleanup_unverified" && event.nodeId === "held")).toHaveLength(1);
    expect(events.some((event) => event.event === "provider.call.completed" && event.callId === heldCallId && event.operation === "invoke" && event.launched === true)).toBe(true);
    expect(events.some((event) => event.event === "provider.call.completed" && event.callId === stopperCallId && event.operation === "invoke" && event.launched === true)).toBe(true);
    expect(events.some((event) => event.event === "node.accepted" && event.nodeId === "held")).toBe(false);
    expect(events.some((event) => event.event === "node.started" && event.nodeId === "dependent")).toBe(false);
    expect(events.filter((event) => event.event === "provider.call.started" && event.nodeId === "held" && event.operation === "invoke")).toHaveLength(1);

    const transport = readTransport(project, runId, heldCallId);
    expect(transport).toMatchObject({ started: true, cancelled: true, timedOut: false, outputLimitExceeded: false });
    expect(transport.cleanupUnverified).toMatchObject({ code: "PROCESS_TREE_UNVERIFIED", operationCause: "cancelled" });
    const reportPath = path.join(project, ".nodulus", "runs", runId, "nodes", "held", "artifacts", "report.json");
    expect(existsSync(reportPath)).toBe(false);
    expect(readFixtureEvents(eventsAbsolute).filter(({ role, stage }) => role === "held" && stage === "held-inference-started")).toHaveLength(1);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  let processIdentityKnown = rootPid !== undefined && intermediatePid !== undefined && descendantPid !== undefined;
  try { writeFileSync(path.join(project, paths.heldRootReleasePath), "release\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { cleanupErrors.push(toError(error)); }
  try { writeFileSync(path.join(project, paths.descendantReleasePath), "release\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { cleanupErrors.push(toError(error)); }
  try { writeFileSync(path.join(project, paths.stopperReleasePath), "fail\n", { encoding: "utf8" }); }
  catch (error) { cleanupErrors.push(toError(error)); }

  let runSettled = run === undefined || outcome !== undefined;
  if (run) {
    try { outcome ??= await withDeadline(run, cleanupDeadline, "owned graph run cleanup"); runSettled = true; }
    catch (error) { cleanupErrors.push(toError(error)); }
  }
  let processesExited = false;
  try {
    const pids = await readAllOwnedPids(project, eventsAbsolute, paths);
    if (rootPid !== undefined && !pids.includes(rootPid)) throw new Error("Captured root PID was not present in the owned fixture identity records.");
    if (intermediatePid !== undefined && !pids.includes(intermediatePid)) throw new Error("Intermediate PID was not present in the owned fixture identity records.");
    if (descendantPid !== undefined && !pids.includes(descendantPid)) throw new Error("Descendant PID was not present in the owned fixture identity records.");
    processesExited = processIdentityKnown && await waitForPids(pids, cleanupDeadline);
  } catch (error) {
    processIdentityKnown = false;
    cleanupErrors.push(toError(error));
  }
  if (runSettled && processesExited && processIdentityKnown && cleanupErrors.length === 0) {
    try {
      assertOwnedProject(project, projectIdentity);
      rmSync(project, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(toError(error)); }
  } else {
    cleanupErrors.push(new Error(`P15C1 project retained because run/process cleanup is uncertain: ${path.basename(project)}; root=${String(rootPid)}, intermediate=${String(intermediatePid)}, descendant=${String(descendantPid)}`));
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], "P15C1 scenario and owned cleanup both failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P15C1 owned cleanup failed.");
}, testCeilingMs);

function configureScenario(project: string): void {
  configureParallelProject(project);
  const controlPath = ".nodulus/fixtures/par-015-orphaned-control.json";
  const eventPath = ".nodulus/fixtures/par-015-orphaned-events.jsonl";
  const roles = ["held", "stopper"] as const;
  for (const role of roles) {
    const wrapperName = `par-015-orphaned-${role}.cmd`;
    const wrapperPath = path.join(project, ".nodulus", "fixtures", wrapperName);
    const scriptRelative = ".nodulus\\fixtures\\par-015-orphaned-descendant-cli.mjs";
    const wrapper = `@echo off\r\n"${process.execPath}" "${scriptRelative}" "${controlPath}" "${eventPath}" ${role} %*\r\nexit /b %ERRORLEVEL%\r\n`;
    writeFileSync(wrapperPath, wrapper, "utf8");
  }

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  for (const role of roles) {
    profiles[`fixture-${role}`] = {
      ...profiles.fixture,
      enabled: true,
      executable: path.join(project, ".nodulus", "fixtures", `par-015-orphaned-${role}.cmd`),
      kind: "codex",
      model: `p15c1-${role}`,
      timeoutMs: profileTimeoutMs,
      capabilities: [],
    };
  }
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["held", "stopper", "dependent"];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { held: [], stopper: [], dependent: ["held"] };
  workflow.execution.resources = { held: [], stopper: [], dependent: [] };
  workflow.outputs = [{ name: "held", from: "held.report", contract: "report.v1" }];
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  for (const nodeId of workflow.nodes) {
    const node = nodeId === "held" ? readProjectJson(project, ".nodulus/nodes/prepare.json") : structuredClone(readProjectJson(project, ".nodulus/nodes/audit.json"));
    node.id = nodeId;
    node.providerProfile = nodeId === "held" ? "fixture-held" : "fixture-stopper";
    node.instructions = [`.nodulus/instructions/${nodeId}.md`];
    node.inputs = nodeId === "dependent" ? { report: { from: "held.report", contract: "report.v1" } } : { request: { from: "request", contract: "request.v1" } };
    node.expectedOutputs = [{ name: "report", contract: "report.v1" }];
    writeJson(project, `.nodulus/nodes/${nodeId}.json`, node);
    writeFileSync(path.join(project, ".nodulus", "instructions", `${nodeId}.md`), `Instructions for ${nodeId}.\n`, "utf8");
  }
}

function assertOwnedProject(project: string, identity: string): void {
  const tempRoot = realpathSync.native(os.tmpdir());
  if (path.dirname(identity) !== tempRoot || !path.basename(identity).startsWith(`nodulus-${label}-`) || realpathSync.native(project) !== identity) {
    throw new Error(`Refusing P15C1 cleanup outside the exact generated project: '${identity}'.`);
  }
}

async function waitForJson<T extends Record<string, unknown>>(file: string, deadline: number, labelText: string, getOutcome?: () => RunOutcome | undefined): Promise<T> {
  while (!existsSync(file)) {
    const earlyOutcome = getOutcome?.();
    if (earlyOutcome) throw new Error(`P15C1 public run settled before ${labelText}; retaining partial PID evidence. ${describeOutcome(earlyOutcome)}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${labelText}: ${path.basename(file)}.`);
    await delay(10);
  }
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function describeOutcome(outcome: RunOutcome): string {
  if (outcome.error !== undefined) return `rejected: ${describeRejection(outcome.error)}`;
  const result = outcome.result?.result as { error?: { code?: string; message?: string } } | undefined;
  return `${outcome.result?.status ?? "unknown"}: ${result?.error?.code ?? "no error code"} ${result?.error?.message ?? ""}`;
}

function describeRejection(error: unknown): string {
  try {
    if (error instanceof Error) return error.message.slice(0, 500);
  } catch { return "uninspectable rejection value"; }
  if (typeof error === "string") return error.slice(0, 500);
  if (error === null) return "null rejection value";
  if (typeof error === "boolean" || typeof error === "number" || typeof error === "bigint" || typeof error === "symbol") {
    try { return String(error).slice(0, 500); }
    catch { return "uninspectable rejection value"; }
  }
  return "non-Error rejection value";
}

function readOwnedPid(value: unknown, labelText: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${labelText} PID in atomic fixture marker.`);
  return value;
}

function readCheckpoint(project: string, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, unknown>;
}

function readEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(project, ".nodulus", "runs", runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readTransport(project: string, runId: string, callId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "calls", callId, "transport.json"), "utf8")) as Record<string, unknown>;
}

function readFixtureEvents(file: string): FixtureEvent[] {
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
}

async function readAllOwnedPids(project: string, eventsPath: string, paths: Record<string, string | number>): Promise<number[]> {
  const events = readFixtureEvents(eventsPath);
  const pids = events.map(({ pid }) => readOwnedPid(pid, "event"));
  for (const relative of [paths.heldRootStartedPath, paths.intermediateChildPath, paths.descendantStartedPath]) {
    if (typeof relative !== "string") throw new Error("P15C1 owned marker path is invalid.");
    const record = await waitForJson<Record<string, unknown>>(path.join(project, relative), Date.now() + 1, "owned PID marker");
    pids.push(readOwnedPid(record.pid, path.basename(relative)));
    if (relative === paths.intermediateChildPath && typeof record.descendantPid === "number") pids.push(readOwnedPid(record.descendantPid, "intermediate descendant"));
    if (relative === paths.heldRootStartedPath) {
      pids.push(readOwnedPid(record.intermediatePid, "held-root intermediate"));
      pids.push(readOwnedPid(record.descendantPid, "held-root descendant"));
    }
  }
  return [...new Set(pids)];
}

async function waitForPids(pids: number[], deadline: number): Promise<boolean> {
  while (pids.some(isProcessAlive)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(typeof error === "object" && error !== null && "code" in error && String(error.code) === "ESRCH"); }
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, labelText: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`P15C1 deadline expired before ${labelText}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`P15C1 timed out waiting for ${labelText} after ${remaining} ms.`)), remaining); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

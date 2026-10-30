import { copyFileSync, existsSync, lstatSync, opendirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

type Mode = "sibling-stop" | "validator-timeout";
type FixtureEvent = { stage: string; pid: number; role: string; atMs: number; [key: string]: unknown };
type RunResult = Awaited<ReturnType<typeof runWorkflow>>;
type Snapshot = { rootPid: number; descendantPid: number; rootAlive: boolean; descendantAlive: boolean; returnedAt: number };
type RunOutcome = { result?: RunResult; error?: unknown; processSnapshot?: Snapshot };

const label = "par-015-validator-cleanup";
const validatorTimeoutMs = 5_000;
const providerTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 35_000;
const fixturePath = fileURLToPath(new URL("../fixtures/par-015-validator-cleanup.mjs", import.meta.url));
const validatorRelative = ".nodulus/validators/par-015-validator-cleanup.mjs";
const controlRelative = ".nodulus/fixtures/par-015-validator-control.json";
const eventsRelative = ".nodulus/fixtures/par-015-validator-events.jsonl";
const paths = {
  validatorRootStartedPath: ".nodulus/fixtures/par-015-validator-root-started.json",
  validatorRootReleasePath: ".nodulus/fixtures/par-015-validator-root-release",
  intermediateChildPath: ".nodulus/fixtures/par-015-validator-intermediate-child.json",
  descendantStartedPath: ".nodulus/fixtures/par-015-validator-descendant-started.json",
  descendantReleasePath: ".nodulus/fixtures/par-015-validator-descendant-release",
  stopperReleasePath: ".nodulus/fixtures/par-015-validator-stopper-release",
};

test.skipIf(process.platform !== "win32")("P15C3 reports validator descendant uncertainty after sibling graph stop", async () => {
  await runValidatorScenario("sibling-stop");
}, testCeilingMs);

test.skipIf(process.platform !== "win32")("P15C3 reports validator descendant uncertainty after its captured timeout", async () => {
  await runValidatorScenario("validator-timeout");
}, testCeilingMs);

async function runValidatorScenario(mode: Mode): Promise<void> {
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  assertOwnedProject(project, projectIdentity);
  const controlAbsolute = path.join(project, controlRelative);
  const eventsAbsolute = path.join(project, eventsRelative);
  let validatorRootPid: number | undefined;
  let intermediatePid: number | undefined;
  let descendantPid: number | undefined;
  let outcome: RunOutcome | undefined;
  let run: Promise<RunOutcome> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];
  let capturedTransport: { path: string; bytes: Buffer; sha256: string } | undefined;

  try {
    configureScenario(project, mode);
    writeFileSync(controlAbsolute, JSON.stringify({ ...paths, fixtureLifetimeMs }), { encoding: "utf8", flag: "wx" });
    writeFileSync(eventsAbsolute, "", { encoding: "utf8", flag: "wx" });
    assertOwnedProject(project, projectIdentity);
    const provider = createDefaultProviderPort(project);
    run = runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Exercise real executable-validator process-tree cleanup evidence." }],
    }, provider).then(
      (result) => {
        const returnedAt = performance.now();
        const processSnapshot = validatorRootPid !== undefined && descendantPid !== undefined
          ? { rootPid: validatorRootPid, descendantPid, rootAlive: isProcessAlive(validatorRootPid), descendantAlive: isProcessAlive(descendantPid), returnedAt }
          : undefined;
        const value: RunOutcome = { result, ...(processSnapshot ? { processSnapshot } : {}) };
        outcome = value;
        return value;
      },
      (error: unknown) => {
        const returnedAt = performance.now();
        const processSnapshot = validatorRootPid !== undefined && descendantPid !== undefined
          ? { rootPid: validatorRootPid, descendantPid, rootAlive: isProcessAlive(validatorRootPid), descendantAlive: isProcessAlive(descendantPid), returnedAt }
          : undefined;
        const value: RunOutcome = { error, ...(processSnapshot ? { processSnapshot } : {}) };
        outcome = value;
        return value;
      },
    );

    const scenarioDeadline = Date.now() + scenarioBudgetMs;
    const marker = await waitForJson(path.join(project, paths.validatorRootStartedPath), scenarioDeadline, "validator root start", () => outcome);
    validatorRootPid = readOwnedPid(marker.pid, "validator root");
    intermediatePid = readOwnedPid(marker.intermediatePid, "validator intermediate");
    descendantPid = readOwnedPid(marker.descendantPid, "validator orphan");
    const intermediateRecord = await waitForJson(path.join(project, paths.intermediateChildPath), scenarioDeadline, "validator intermediate child record", () => outcome);
    const descendantMarker = await waitForJson(path.join(project, paths.descendantStartedPath), scenarioDeadline, "validator descendant self marker", () => outcome);
    expect(intermediateRecord.pid).toBe(intermediatePid);
    expect(intermediateRecord.descendantPid).toBe(descendantPid);
    expect(descendantMarker.pid).toBe(descendantPid);
    expect(isProcessAlive(validatorRootPid), "Executable validator root must be alive before failure or timeout.").toBe(true);
    expect(isProcessAlive(intermediatePid), "Validator intermediate must exit before its child is orphaned.").toBe(false);
    expect(isProcessAlive(descendantPid), "Detached validator descendant must remain alive before settlement.").toBe(true);

    const activeRunId = locateActiveRunId(project);
    const completedCall = await waitForEvent(project, activeRunId, (event) => event.event === "provider.call.completed" && event.nodeId === "held" && event.operation === "invoke", scenarioDeadline, () => outcome);
    const heldCallId = String(completedCall.callId);
    expect(completedCall).toMatchObject({ attempt: 1, operation: "invoke", launched: true });
    const transportPath = path.join(project, ".nodulus", "runs", activeRunId, "calls", heldCallId, "transport.json");
    const transportBytes = readFileSync(transportPath);
    capturedTransport = { path: transportPath, bytes: transportBytes, sha256: hash(transportBytes) };
    expect(JSON.parse(transportBytes.toString("utf8"))).toMatchObject({ started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
    expect(readFixtureEvents(eventsAbsolute).filter((event) => event.role === "codex-held" && event.stage === "inference-completed")).toHaveLength(1);
    expect(readFixtureEvents(eventsAbsolute).filter((event) => event.role === "validator" && event.stage === "validator-input-consumed")).toMatchObject([{ text: "validated artifact" }]);

    if (mode === "sibling-stop") {
      writeFileSync(path.join(project, paths.stopperReleasePath), "release\n", { encoding: "utf8", flag: "wx" });
    }
    const publicOutcome = await withDeadline(run, scenarioDeadline, `public ${mode} graph result`);
    outcome = publicOutcome;
    assertRunFailure(publicOutcome);
    expect(publicOutcome.processSnapshot).toMatchObject({ rootPid: validatorRootPid, descendantPid, rootAlive: false, descendantAlive: true });
    const runId = publicOutcome.result.runId;
    assertValidatorCleanupResult(project, runId, publicOutcome.result, mode, heldCallId);
    assertProviderEvidenceUnchanged(capturedTransport);
    expect(readFixtureEvents(eventsAbsolute).filter((event) => event.role === "validator" && event.stage === "validator-input-consumed")).toHaveLength(1);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  let processIdentityKnown = validatorRootPid !== undefined && intermediatePid !== undefined && descendantPid !== undefined;
  try { writeFileSync(path.join(project, paths.validatorRootReleasePath), "release\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!isAlreadyExists(error)) cleanupErrors.push(toError(error)); }
  try { writeFileSync(path.join(project, paths.descendantReleasePath), "release\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!isAlreadyExists(error)) cleanupErrors.push(toError(error)); }
  try { writeFileSync(path.join(project, paths.stopperReleasePath), "release\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!isAlreadyExists(error)) cleanupErrors.push(toError(error)); }

  let runSettled = run === undefined || outcome !== undefined;
  if (run) {
    try { outcome ??= await withDeadline(run, cleanupDeadline, "owned graph run cleanup"); runSettled = true; }
    catch (error) { cleanupErrors.push(toError(error)); }
  }
  let processesExited = false;
  try {
    const pids = await readOwnedPids(eventsAbsolute, controlAbsolute);
    if (validatorRootPid !== undefined && !pids.includes(validatorRootPid)) throw new Error("Captured validator PID was not present in owned fixture records.");
    if (intermediatePid !== undefined && !pids.includes(intermediatePid)) throw new Error("Captured validator intermediate PID was not present in owned fixture records.");
    if (descendantPid !== undefined && !pids.includes(descendantPid)) throw new Error("Captured validator descendant PID was not present in owned fixture records.");
    processesExited = processIdentityKnown && await waitForPids(pids, cleanupDeadline);
  } catch (error) {
    processIdentityKnown = false;
    cleanupErrors.push(toError(error));
  }
  if (runSettled && processesExited && processIdentityKnown && cleanupErrors.length === 0) {
    try {
      assertOwnedProject(project, projectIdentity);
    } catch (error) { cleanupErrors.push(toError(error)); }
    if (cleanupErrors.length === 0) {
      try { rmSync(project, { recursive: true, force: true }); }
      catch (error) {
        cleanupErrors.push(toError(error));
        try {
          cleanupErrors.push(new Error(`P15C3 removal failure state: ${describeRemovalFailureState(project, [validatorRootPid, intermediatePid, descendantPid])}`));
        } catch {
          cleanupErrors.push(new Error("P15C3 removal failure state could not be captured."));
        }
      }
    }
  } else {
    cleanupErrors.push(new Error(`P15C3 project retained because run/process cleanup is uncertain: ${path.basename(project)}; validator=${String(validatorRootPid)}, intermediate=${String(intermediatePid)}, descendant=${String(descendantPid)}`));
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([toError(primaryError), ...cleanupErrors], "P15C3 scenario and owned cleanup both failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P15C3 owned cleanup failed.");
}

function configureScenario(project: string, mode: Mode): void {
  configureParallelProject(project);
  copyFileSync(fixturePath, path.join(project, validatorRelative));
  copyFileSync(fixturePath, path.join(project, ".nodulus", "fixtures", "par-015-validator-cleanup.mjs"));
  const roles = mode === "sibling-stop" ? ["codex-held", "codex-stopper"] as const : ["codex-held"] as const;
  for (const role of roles) {
    const wrapperPath = path.join(project, ".nodulus", "fixtures", `par-015-validator-${role}.cmd`);
    const scriptRelative = ".nodulus\\fixtures\\par-015-validator-cleanup.mjs";
    const wrapper = `@echo off\r\n"${process.execPath}" "${scriptRelative}" "${controlRelative}" "${eventsRelative}" ${role} %*\r\nexit /b %ERRORLEVEL%\r\n`;
    writeFileSync(wrapperPath, wrapper, "utf8");
  }
  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  profiles.held = {
    ...profiles.fixture,
    enabled: true,
    executable: path.join(project, ".nodulus", "fixtures", "par-015-validator-codex-held.cmd"),
    kind: "codex",
    model: "p15c3-held",
    timeoutMs: providerTimeoutMs,
    capabilities: [],
  };
  profiles.stopper = {
    ...profiles.fixture,
    enabled: true,
    executable: path.join(project, ".nodulus", "fixtures", "par-015-validator-codex-stopper.cmd"),
    kind: "codex",
    model: "p15c3-stopper",
    timeoutMs: providerTimeoutMs,
    capabilities: [],
  };
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = mode === "sibling-stop" ? ["held", "stopper", "dependent"] : ["held"];
  workflow.execution.maxConcurrency = mode === "sibling-stop" ? 2 : 1;
  workflow.execution.dependsOn = mode === "sibling-stop" ? { held: [], stopper: [], dependent: ["held"] } : { held: [] };
  workflow.execution.resources = Object.fromEntries(workflow.nodes.map((nodeId) => [nodeId, []]));
  workflow.outputs = [{ name: "held", from: "held.report", contract: "report.v1" }];
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  for (const nodeId of workflow.nodes) {
    const node = nodeId === "held" ? readProjectJson(project, ".nodulus/nodes/prepare.json") : structuredClone(readProjectJson(project, ".nodulus/nodes/audit.json"));
    node.id = nodeId;
    node.providerProfile = nodeId === "held" ? "held" : "stopper";
    node.instructions = [`.nodulus/instructions/${nodeId}.md`];
    node.inputs = nodeId === "dependent" ? { report: { from: "held.report", contract: "report.v1" } } : { request: { from: "request", contract: "request.v1" } };
    node.expectedOutputs = [{ name: "report", contract: "report.v1", ...(nodeId === "held" ? { validator: validatorRelative, validatorTimeoutMs } : {}) }];
    writeJson(project, `.nodulus/nodes/${nodeId}.json`, node);
    writeFileSync(path.join(project, ".nodulus", "instructions", `${nodeId}.md`), `Instructions for ${nodeId}.\n`, "utf8");
  }
}

function assertValidatorCleanupResult(project: string, runId: string, result: RunResult, mode: Mode, heldCallId: string): void {
  const expectedCode = mode === "sibling-stop" ? "GRAPH_CANCELLED" : "VALIDATOR_TIMEOUT";
  const checkpoint = readCheckpoint(project, runId);
  const graph = checkpoint.graph as { admissionClosed: boolean; recoveryRequired?: boolean; uncertainNodeIds?: string[]; cleanupUnverifiedNodeIds?: string[]; nodes: Record<string, Record<string, unknown>> };
  expect(graph.admissionClosed).toBe(true);
  expect(graph.nodes.held).toMatchObject({
    phase: "failed",
    callId: heldCallId,
    launch: true,
    failure: { code: expectedCode, message: expect.any(String) },
    cleanupUnverified: { code: "PROCESS_TREE_UNVERIFIED", operation: "validator", message: expect.any(String) },
  });
  expect(graph.recoveryRequired).toBe(true);
  expect(graph.cleanupUnverifiedNodeIds).toEqual(["held"]);
  expect(graph.uncertainNodeIds).toBeUndefined();
  if (mode === "sibling-stop") {
    expect(graph.nodes.stopper).toMatchObject({ phase: "failed", failure: { code: "P15C3_TRIGGER" } });
  }
  const payload = result.result as { error?: Record<string, unknown> };
  if (mode === "sibling-stop") {
    const stopperCallId = String(graph.nodes.stopper?.callId);
    expect(payload.error).toMatchObject({ code: "P15C3_TRIGGER", nodeId: "stopper", callId: stopperCallId, launch: true, recoveryRequired: true, cleanupUnverifiedNodeIds: ["held"] });
  } else {
    expect(payload.error).toMatchObject({ code: "VALIDATOR_TIMEOUT", nodeId: "held", callId: heldCallId, launch: true, recoveryRequired: true, cleanupUnverifiedNodeIds: ["held"] });
  }
  expect(payload.error).not.toHaveProperty("uncertainNodeIds");
  const events = readRunEvents(project, runId);
  expect(events.filter((event) => event.event === "provider.call.started" && event.nodeId === "held" && event.operation === "invoke")).toHaveLength(1);
  expect(events.filter((event) => event.event === "provider.call.completed" && event.nodeId === "held" && event.operation === "invoke" && event.launched === true)).toHaveLength(1);
  expect(events.some((event) => event.event === "provider.call.started" && event.nodeId === "held" && event.operation === "validator")).toBe(false);
  expect(events.some((event) => event.event === "node.accepted" && event.nodeId === "held")).toBe(false);
  expect(events.some((event) => event.event === "node.started" && event.nodeId === "dependent")).toBe(false);
  const cleanupEvents = events.filter((event) => event.event === "node.cleanup_unverified" && event.nodeId === "held");
  expect(cleanupEvents).toHaveLength(1);
  expect(cleanupEvents[0]).toMatchObject({ code: expectedCode, operation: "validator" });
  expect(existsSync(path.join(project, ".nodulus", "runs", runId, "nodes", "held", "artifacts", "report.json"))).toBe(false);
}

function assertRunFailure(outcome: RunOutcome): asserts outcome is RunOutcome & { result: RunResult; processSnapshot: Snapshot } {
  expect(outcome.result).toBeDefined();
  if (!outcome.result) throw outcome.error ?? new Error("Public graph run rejected instead of returning its failure result.");
  expect(outcome.result.status).toBe("error");
  expect(outcome.processSnapshot).toBeDefined();
  if (!outcome.processSnapshot) throw new Error("Public result callback did not capture the first-return process snapshot.");
}

function assertProviderEvidenceUnchanged(snapshot: { path: string; bytes: Buffer; sha256: string } | undefined): void {
  if (!snapshot) throw new Error("Captured Codex transport snapshot is missing.");
  const after = readFileSync(snapshot.path);
  expect(hash(after)).toBe(snapshot.sha256);
  expect(after.equals(snapshot.bytes)).toBe(true);
  expect(JSON.parse(after.toString("utf8"))).toMatchObject({ started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
}

function assertOwnedProject(project: string, identity: string): void {
  const tempRoot = realpathSync.native(os.tmpdir());
  if (path.dirname(identity) !== tempRoot || !path.basename(identity).startsWith(`nodulus-${label}-`) || realpathSync.native(project) !== identity) {
    throw new Error(`Refusing P15C3 cleanup outside the exact generated project: '${identity}'.`);
  }
}

async function waitForJson<T extends Record<string, unknown>>(file: string, deadline: number, labelText: string, getOutcome?: () => RunOutcome | undefined): Promise<T> {
  while (!existsSync(file)) {
    const earlyOutcome = getOutcome?.();
    if (earlyOutcome) throw new Error(`P15C3 public run settled before ${labelText}; retaining partial PID evidence. ${describeOutcome(earlyOutcome)}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${labelText}: ${path.basename(file)}.`);
    await delay(10);
  }
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

async function waitForEvent(project: string, runId: string, predicate: (event: Record<string, unknown>) => boolean, deadline: number, getOutcome?: () => RunOutcome | undefined): Promise<Record<string, unknown>> {
  while (Date.now() < deadline) {
    const event = readRunEvents(project, runId).find(predicate);
    if (event) return event;
    const earlyOutcome = getOutcome?.();
    if (earlyOutcome) throw new Error(`P15C3 public run settled before provider completion evidence. ${describeOutcome(earlyOutcome)}`);
    await delay(10);
  }
  throw new Error("Timed out waiting for the held node provider completion evidence.");
}

async function readOwnedPids(eventsPath: string, controlPath: string): Promise<number[]> {
  const pids = readFixtureEvents(eventsPath).map(({ pid }) => readOwnedPid(pid, "fixture event"));
  const control = JSON.parse(readFileSync(controlPath, "utf8")) as Record<string, unknown>;
  for (const key of ["validatorRootStartedPath", "intermediateChildPath", "descendantStartedPath"]) {
    const relative = control[key];
    if (typeof relative !== "string") throw new Error("P15C3 owned marker path is invalid.");
    const markerPath = path.join(path.dirname(controlPath), relative.replace(/^\.nodulus[\\/]+fixtures[\\/]+/, ""));
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
      if (typeof marker.pid === "number") pids.push(readOwnedPid(marker.pid, key));
      if (typeof marker.intermediatePid === "number") pids.push(readOwnedPid(marker.intermediatePid, "validator root intermediate"));
      if (typeof marker.descendantPid === "number") pids.push(readOwnedPid(marker.descendantPid, "validator root descendant"));
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
  catch (error) { return !(typeof error === "object" && error !== null && "code" in error && String((error as NodeJS.ErrnoException).code) === "ESRCH"); }
}

function locateActiveRunId(project: string): string {
  const runIds = readdirSync(path.join(project, ".nodulus", "runs")).filter((entry) => entry !== "preexisting-run");
  if (runIds.length !== 1) throw new Error(`Expected one active run directory, found ${runIds.length}.`);
  return runIds[0]!;
}

function readCheckpoint(project: string, runId: string): Record<string, unknown> {
  return readJson(path.join(project, ".nodulus", "runs", runId, "run.json"));
}

function readRunEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(project, ".nodulus", "runs", runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readFixtureEvents(file: string): FixtureEvent[] {
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function readOwnedPid(value: unknown, labelText: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${labelText} PID in atomic fixture marker.`);
  return value;
}

function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

async function withDeadline<T>(promise: Promise<T> | undefined, deadline: number, labelText: string): Promise<T> {
  if (!promise) throw new Error(`P15C3 ${labelText} is unavailable.`);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`P15C3 deadline expired before ${labelText}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`P15C3 timed out waiting for ${labelText} after ${remaining} ms.`)), remaining); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function describeOutcome(value: RunOutcome): string {
  if (value.error !== undefined) return `rejected: ${safeDiagnostic(value.error)}`;
  const payload = value.result?.result as { error?: { code?: string; message?: string } } | undefined;
  return `${value.result?.status ?? "unknown"}: ${payload?.error?.code ?? "no error code"} ${payload?.error?.message ?? ""}`;
}

function safeDiagnostic(value: unknown): string {
  try { if (value instanceof Error) return value.message.slice(0, 300); }
  catch { return "uninspectable Error rejection"; }
  if (typeof value === "string") return value.slice(0, 300);
  if (value === null) return "null rejection";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol") {
    try { return String(value).slice(0, 300); } catch { return "uninspectable primitive rejection"; }
  }
  return "non-Error rejection value";
}

function describeRemovalFailureState(project: string, pids: Array<number | undefined>): string {
  const entries: Array<Record<string, unknown>> = [];
  const maximumEntries = 64;
  const maximumDepth = 4;
  let truncated = false;
  let root: Record<string, unknown> | undefined;
  let exists: boolean | null = null;
  let rootStat: ReturnType<typeof lstatSync> | undefined;
  try {
    rootStat = lstatSync(project);
    exists = true;
    root = lstatSummary(rootStat);
  } catch (error) {
    exists = (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
    root = { error: safeDiagnostic(error) };
  }
  if (rootStat?.isDirectory()) {
    try { visit(project, "", 0); }
    catch (error) {
      if (entries.length < maximumEntries) entries.push({ path: ".", error: safeDiagnostic(error) });
      else truncated = true;
    }
  }
  let nativeRoot: string | undefined;
  let nativeRootError: string | undefined;
  try { nativeRoot = realpathSync.native(project); }
  catch (error) { nativeRootError = safeDiagnostic(error); }
  const processes = pids.map((pid) => ({ pid: pid ?? null, state: pid === undefined ? "unavailable" : isProcessAlive(pid) ? "alive" : "not-alive" }));
  return JSON.stringify({ lexicalRoot: project, nativeRoot: nativeRoot ?? null, nativeRootError: nativeRootError ?? null, exists, root: root ?? null, entries, truncated, processes });

  function visit(directory: string, relativeDirectory: string, depth: number): void {
    if (entries.length >= maximumEntries) {
      truncated = true;
      return;
    }
    if (depth >= maximumDepth) {
      truncated = true;
      return;
    }
    let handle: ReturnType<typeof opendirSync>;
    try { handle = opendirSync(directory); }
    catch (error) {
      if (entries.length < maximumEntries) entries.push({ path: relativeDirectory || ".", error: safeDiagnostic(error) });
      else truncated = true;
      return;
    }
    try {
      while (entries.length < maximumEntries) {
        const entry = handle.readSync();
        if (!entry) break;
        const childPath = path.join(directory, entry.name);
        const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
        try {
          const childStat = lstatSync(childPath);
          entries.push({ path: relativePath, ...lstatSummary(childStat) });
          if (childStat.isDirectory()) visit(childPath, relativePath, depth + 1);
        } catch (error) {
          if (entries.length < maximumEntries) entries.push({ path: relativePath, error: safeDiagnostic(error) });
          else truncated = true;
        }
      }
      if (entries.length >= maximumEntries) truncated = true;
    } finally { handle.closeSync(); }
  }
}

function lstatSummary(value: ReturnType<typeof lstatSync>): Record<string, unknown> {
  return {
    mode: value.mode,
    type: value.isSymbolicLink() ? "symlink" : value.isDirectory() ? "directory" : value.isFile() ? "file" : "other",
    size: value.size,
  };
}

function toError(value: unknown): Error { return value instanceof Error ? value : new Error(safeDiagnostic(value)); }
function isAlreadyExists(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

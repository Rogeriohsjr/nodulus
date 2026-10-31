import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { getRunStatus, inspectRun, runWorkflow } from "../../src/index.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { createInitializedProject } from "../support/intake-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";
import { observeOwnedNativeProcesses, type OwnedNativeProcessObserver } from "../support/owned-native-processes.js";
import { observeReadStorage } from "../support/read-only-storage-observer.js";
import { startWindowsProcessPin, type WindowsProcessPin } from "../support/windows-process-pin.js";

type Mode = "readiness" | "repair";
type FixtureEvent = { stage: string; pid: number; role: string; atMs: number; [key: string]: unknown };
type RunResult = Awaited<ReturnType<typeof runWorkflow>>;
type Snapshot = { rootPid: number; descendantPid: number; rootAlive: boolean; descendantAlive: boolean; returnedAt: number };
type RunOutcome = { result?: RunResult; error?: unknown; processSnapshot?: Snapshot };

const label = "par-015-cleanup-stages";
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 35_000;
const fixturePath = fileURLToPath(new URL("../fixtures/par-015-cleanup-stages-cli.mjs", import.meta.url));
const controlRelative = ".nodulus/fixtures/par-015-cleanup-control.json";
const eventsRelative = ".nodulus/fixtures/par-015-cleanup-events.jsonl";
const paths = {
  heldRootStartedPath: ".nodulus/fixtures/par-015-held-root-started.json",
  heldRootReleasePath: ".nodulus/fixtures/par-015-held-root-release",
  intermediateChildPath: ".nodulus/fixtures/par-015-intermediate-child.json",
  descendantStartedPath: ".nodulus/fixtures/par-015-descendant-started.json",
  descendantReleasePath: ".nodulus/fixtures/par-015-descendant-release",
  stopperReleasePath: ".nodulus/fixtures/par-015-stopper-release",
};

test.skipIf(process.platform !== "win32")("P15C2 preserves cancelled readiness cleanup evidence without claiming inference", async () => {
  await runStageScenario("readiness");
}, testCeilingMs);

test.skipIf(process.platform !== "win32")("P15C2 preserves cancelled OpenCode repair cleanup evidence without replaying build", async () => {
  await runStageScenario("repair");
}, testCeilingMs);

async function runStageScenario(mode: Mode): Promise<void> {
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  assertOwnedProject(project, projectIdentity);
  const controlAbsolute = path.join(project, controlRelative);
  const eventsAbsolute = path.join(project, eventsRelative);
  let rootPid: number | undefined;
  let intermediatePid: number | undefined;
  let descendantPid: number | undefined;
  let outcome: RunOutcome | undefined;
  let run: Promise<RunOutcome> | undefined;
  let processObserver: OwnedNativeProcessObserver | undefined;
  const processPins: WindowsProcessPin[] = [];
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];
  const queryPromises: Promise<unknown>[] = [];
  const pendingQueries = new Set<Promise<unknown>>();
  let queriesDrained = true;
  let runId: string | undefined;

  const capturePinnedProcessSnapshot = (): Snapshot | undefined => {
    if (rootPid === undefined || descendantPid === undefined) return undefined;
    const pinnedTargets = new Set(processPins.filter((pin) => pin.handleHeld).map((pin) => pin.targetPid));
    if (!pinnedTargets.has(rootPid) || !pinnedTargets.has(descendantPid)) return undefined;
    // The PID probes are lifetime-bound by the open native handles; later handle exit records are cleanup proof only.
    return { rootPid, descendantPid, rootAlive: isProcessAlive(rootPid), descendantAlive: isProcessAlive(descendantPid), returnedAt: performance.now() };
  };

  try {
    configureScenario(project, mode);
    writeFileSync(controlAbsolute, JSON.stringify({ ...paths, fixtureLifetimeMs }), { encoding: "utf8", flag: "wx" });
    writeFileSync(eventsAbsolute, "", { encoding: "utf8", flag: "wx" });
    assertOwnedProject(project, projectIdentity);
    processObserver = observeOwnedNativeProcesses();
    const provider = createDefaultProviderPort(project);
    run = runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: `Exercise ${mode} process-tree cleanup evidence using local CLI fixtures.` }],
    }, provider).then(
      (result) => {
        const processSnapshot = capturePinnedProcessSnapshot();
        const value: RunOutcome = { result, ...(processSnapshot ? { processSnapshot } : {}) };
        outcome = value;
        return value;
      },
      (error: unknown) => {
        const processSnapshot = capturePinnedProcessSnapshot();
        const value: RunOutcome = { error, ...(processSnapshot ? { processSnapshot } : {}) };
        outcome = value;
        return value;
      },
    );

    const scenarioDeadline = Date.now() + scenarioBudgetMs;
    const rootMarker = await waitForJson(path.join(project, paths.heldRootStartedPath), scenarioDeadline, `${mode} root start`, () => outcome);
    rootPid = readOwnedPid(rootMarker.pid, "provider root");
    intermediatePid = readOwnedPid(rootMarker.intermediatePid, "intermediate");
    descendantPid = readOwnedPid(rootMarker.descendantPid, "orphan descendant");
    const intermediateRecord = await waitForJson(path.join(project, paths.intermediateChildPath), scenarioDeadline, "intermediate child record", () => outcome);
    const descendantMarker = await waitForJson(path.join(project, paths.descendantStartedPath), scenarioDeadline, "descendant self marker", () => outcome);
    expect(rootMarker.descendantPid).toBe(descendantPid);
    expect(intermediateRecord.pid).toBe(intermediatePid);
    expect(intermediateRecord.descendantPid).toBe(descendantPid);
    expect(descendantMarker.pid).toBe(descendantPid);
    expect(rootPid).not.toBe(descendantPid);
    // The fixture writes heldRootStartedPath only after its own ChildProcess close event for the intermediate.
    const pinParent = path.join(project, ".nodulus", "fixtures", "par-015-native-pins");
    mkdirSync(pinParent, { recursive: true });
    const rootPin = startWindowsProcessPin({
      controlDirectory: path.join(pinParent, "root"), targetPid: rootPid, watchdogMs: fixtureLifetimeMs,
    });
    processPins.push(rootPin);
    const rootPinReady = await rootPin.acquire(scenarioDeadline);
    expect(rootPinReady).toMatchObject({ rootPid, handlePid: rootPid, exitCode: 259, nonce: rootPin.nonce });
    const descendantPin = startWindowsProcessPin({
      controlDirectory: path.join(pinParent, "descendant"), targetPid: descendantPid, watchdogMs: fixtureLifetimeMs,
    });
    processPins.push(descendantPin);
    const descendantPinReady = await descendantPin.acquire(scenarioDeadline);
    expect(descendantPinReady).toMatchObject({ rootPid: descendantPid, handlePid: descendantPid, exitCode: 259, nonce: descendantPin.nonce });

    if (mode === "repair") {
      const currentRunId = locateActiveRunId(project);
      runId = currentRunId;
      const parentCall = await waitForEvent(project, currentRunId, (event) => event.event === "provider.call.completed" && event.nodeId === "held" && event.operation === "invoke", scenarioDeadline, () => outcome);
      const parentCallId = String(parentCall.callId);
      const parentEvidencePaths = [
        path.join(project, ".nodulus", "runs", currentRunId, "calls", parentCallId, "transport.json"),
        path.join(project, ".nodulus", "runs", currentRunId, "provider", "held", "attempt-001", "transport.json"),
        path.join(project, ".nodulus", "runs", currentRunId, "nodes", "held", "attempt-001", "response.raw.txt"),
        path.join(project, ".nodulus", "runs", currentRunId, "nodes", "held", "attempt-001", "stderr.log"),
        path.join(project, ".nodulus", "runs", currentRunId, "nodes", "held", "attempt-001", "validation.json"),
        path.join(project, ".nodulus", "runs", currentRunId, "nodes", "held", "attempt-001", "result.json"),
      ];
      const parentEvidence = parentEvidencePaths.map((file) => {
        const bytes = readFileSync(file);
        return { file, bytes, sha256: hash(bytes) };
      });
      expect(parentCall).toMatchObject({ attempt: 1, operation: "invoke", launched: true });
      expect(readFixtureEvents(eventsAbsolute).filter((event) => event.role === "opencode" && event.stage === "build-completed")).toHaveLength(1);
      expect(rootMarker).toMatchObject({ agent: "nodulus-response", session: "p15c2-session" });
      writeFileSync(path.join(project, paths.stopperReleasePath), "release\n", { encoding: "utf8", flag: "wx" });
      const publicOutcome = await withDeadline(run, scenarioDeadline, "public repair graph result");
      outcome = publicOutcome;
      assertRunFailure(publicOutcome);
      expect(publicOutcome.processSnapshot).toMatchObject({ rootPid, descendantPid, rootAlive: false, descendantAlive: true });
      runId = publicOutcome.result!.runId;
      const result = publicOutcome.result!;
      assertCleanupSummary(project, runId, result, "repair_response");
      assertRepairEvidence(project, runId, parentCallId, eventsAbsolute, rootPid, descendantPid);
      for (const item of parentEvidence) {
        const after = readFileSync(item.file);
        expect(hash(after)).toBe(item.sha256);
        expect(after.equals(item.bytes)).toBe(true);
      }
      // Keep the captured evidence in scope until after the sealed graph returns.
      expect(parentEvidence).toHaveLength(6);
    } else {
      const stopperRelease = path.join(project, paths.stopperReleasePath);
      writeFileSync(stopperRelease, "release\n", { encoding: "utf8", flag: "wx" });
      const publicOutcome = await withDeadline(run, scenarioDeadline, "public readiness graph result");
      outcome = publicOutcome;
      assertRunFailure(publicOutcome);
      expect(publicOutcome.processSnapshot).toMatchObject({ rootPid, descendantPid, rootAlive: false, descendantAlive: true });
      runId = publicOutcome.result!.runId;
      assertCleanupSummary(project, runId, publicOutcome.result!, "readiness");
      const events = readRunEvents(project, runId);
      const cliEvents = readFixtureEvents(eventsAbsolute).filter((event) => event.role === "codex-readiness").map(({ stage }) => stage);
      expect(cliEvents).toEqual(["version", "readiness", "readiness-root-ready"]);
      const heldCall = events.find((event) => event.event === "provider.call.started" && event.nodeId === "held" && event.operation === "invoke");
      expect(heldCall).toBeDefined();
      const heldCallId = String(heldCall?.callId);
      expect(events.filter((event) => event.event === "provider.call.completed" && event.callId === heldCallId && event.operation === "invoke" && event.launched === false)).toHaveLength(1);
      expect(events.some((event) => event.event === "provider.call.started" && event.nodeId === "held" && event.operation === "availability")).toBe(false);
      expect(existsSync(path.join(project, ".nodulus", "runs", runId, "calls", heldCallId, "transport.json"))).toBe(false);
      expect(readFixtureEvents(eventsAbsolute).some((event) => event.role === "codex-readiness" && event.stage === "inference-started")).toBe(false);
    }

    if (!runId || !outcome?.result) throw new Error("The held graph did not produce a saved run before inspection.");
    const readStorage = observeReadStorage();
    const runDirectory = path.join(project, ".nodulus", "runs", runId);
    const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
    const runTreeBefore = snapshotTree(runDirectory);
    const fixtureTreeBefore = snapshotTree(fixtureDirectory);
    const fixtureEventsBefore = readFixtureEvents(eventsAbsolute);
    const nativeProcessesBefore = nativeProcessSnapshot(processObserver);
    const savedCheckpoint = readCheckpoint(project, runId);
    const savedEvents = readRunEvents(project, runId);
    const status = await withDeadline(
      trackQuery(getRunStatus(project, runId, readStorage.storage), queryPromises, pendingQueries),
      scenarioDeadline,
      "cleanup recovery status query",
    );
    expect(readStorage.mutations).toEqual(emptyStorageMutations());
    expect(status.status).toBe("error");
    expect(status.checkpoint).toEqual(savedCheckpoint);
    expect(status.events).toEqual(savedEvents);
    expect(status.pendingRequests).toEqual([]);
    expect(status).not.toHaveProperty("pendingRequest");
    const inspection = await withDeadline(
      trackQuery(inspectRun(project, runId, readStorage.storage), queryPromises, pendingQueries),
      scenarioDeadline,
      "cleanup recovery inspection query",
    );
    expect(readStorage.mutations).toEqual(emptyStorageMutations());
    expect(inspection.checkpoint).toEqual(savedCheckpoint);
    expect(inspection.events).toEqual(savedEvents);
    expect(inspection.timeline).toEqual(savedEvents);
    const uncertainty = inspection.uncertainty;
    const nextActions = inspection.nextActions;
    expect(inspection.status).toBe("error");
    expect(inspection.pendingRequests).toEqual([]);
    expect(inspection).not.toHaveProperty("pendingRequest");
    expect(Array.isArray(uncertainty)).toBe(true);
    expect(Array.isArray(nextActions)).toBe(true);
    if (!Array.isArray(uncertainty) || !Array.isArray(nextActions)) throw new Error("Inspection did not return uncertainty and next-action lists.");
    expect(uncertainty.join(" ")).toContain("held");
    expect(uncertainty.join(" ")).toMatch(/cleanup/i);
    expect(uncertainty.join(" ")).toMatch(/unverified|unconfirmed/i);
    expect(nextActions).toEqual(["inspect_attempts", "do_not_replay_uncertain_call"]);
    expect(snapshotTree(runDirectory)).toEqual(runTreeBefore);
    expect(snapshotTree(fixtureDirectory)).toEqual(fixtureTreeBefore);
    expect(readFixtureEvents(eventsAbsolute)).toEqual(fixtureEventsBefore);
    expect(nativeProcessSnapshot(processObserver)).toEqual(nativeProcessesBefore);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  const remainingCleanupMs = Math.max(0, cleanupDeadline - Date.now());
  const abortReserveMs = Math.floor(remainingCleanupMs * 0.4);
  const pinProofDeadline = Math.min(cleanupDeadline - abortReserveMs, Date.now() + Math.floor(remainingCleanupMs * 0.6));
  try { writeFileSync(path.join(project, paths.heldRootReleasePath), "release\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { cleanupErrors.push(toError(error)); }
  try { writeFileSync(path.join(project, paths.descendantReleasePath), "release\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { cleanupErrors.push(toError(error)); }
  try { writeFileSync(path.join(project, paths.stopperReleasePath), "release\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (!isAlreadyExists(error)) cleanupErrors.push(toError(error)); }

  let runSettled = run === undefined || outcome !== undefined;
  if (run) {
    try { outcome ??= await withDeadline(run, pinProofDeadline, "owned graph run cleanup"); runSettled = true; }
    catch (error) { cleanupErrors.push(toError(error)); }
  }

  try {
    if (pendingQueries.size > 0) await withDeadline(Promise.allSettled(queryPromises).then(() => undefined), cleanupDeadline, "read-only query settlement");
    queriesDrained = true;
  } catch (error) {
    queriesDrained = false;
    cleanupErrors.push(toError(error));
  }

  const pinExits: Array<{ targetPid: number; exitCode: number }> = [];
  const releasedPins = new Set<number>();
  const failedPins: Array<{ pin: WindowsProcessPin; error: unknown }> = [];
  for (const pin of processPins) {
    try {
      if (pin.pinReady && pin.handleHeld) {
        const exited = await pin.waitForTargetExit(pinProofDeadline);
        pinExits.push({ targetPid: exited.rootPid, exitCode: exited.exitCode });
        await pin.releaseAfterTargetExit(pinProofDeadline);
        releasedPins.add(pin.targetPid);
      } else {
        await pin.stopBeforePin(pinProofDeadline);
      }
    } catch (error) { failedPins.push({ pin, error }); }
  }
  const abortResults = await Promise.allSettled(failedPins.map(({ pin }) => pin.abortUnverified(cleanupDeadline)));
  for (const [index, result] of abortResults.entries()) {
    const failure = failedPins[index];
    if (failure) cleanupErrors.push(toError(failure.error));
    if (result.status === "rejected") cleanupErrors.push(toError(result.reason));
  }

  let observerDrained = processObserver === undefined;
  if (processObserver) {
    try { await processObserver.drain(cleanupDeadline); observerDrained = true; }
    catch (error) { cleanupErrors.push(toError(error)); }
  }

  let nestedFixtureWorkObserved = rootPid !== undefined || descendantPid !== undefined;
  if (existsSync(eventsAbsolute)) {
    try {
      nestedFixtureWorkObserved ||= readFixtureEvents(eventsAbsolute).some(({ role, stage }) =>
        stage === "intermediate-started" || stage === "intermediate-spawned-descendant" || stage === "descendant-started"
        || (mode === "readiness" && role === "codex-readiness" && stage === "readiness")
        || (mode === "repair" && role === "opencode" && stage === "build-completed"),
      );
    } catch (error) {
      cleanupErrors.push(toError(error));
    }
  }

  let nativeTargetsDrained = !nestedFixtureWorkObserved;
  if (nestedFixtureWorkObserved) {
    const expectedTargets = rootPid !== undefined && descendantPid !== undefined ? [rootPid, descendantPid] : [];
    const exitedTargets = new Set(pinExits.filter(({ exitCode }) => exitCode !== 259).map(({ targetPid }) => targetPid));
    nativeTargetsDrained = expectedTargets.length === 2
      && processPins.length === 2
      && expectedTargets.every((targetPid) => exitedTargets.has(targetPid) && releasedPins.has(targetPid));
    if (!nativeTargetsDrained) cleanupErrors.push(new Error("P15C2 retained the project because one or more fixture process lifetimes lack native exit and handle-close proof."));
  }

  if (!runSettled) cleanupErrors.push(new Error("P15C2 retained the project because the public workflow did not settle within the shared cleanup deadline."));
  if (!observerDrained) cleanupErrors.push(new Error("P15C2 retained the project because owned Node child-process handles did not all close."));

  if (runSettled && queriesDrained && nativeTargetsDrained && observerDrained && cleanupErrors.length === 0) {
    if (!hasPrimaryError) {
      try {
        assertOwnedProject(project, projectIdentity);
        rmSync(project, { recursive: true, force: true });
      } catch (error) { cleanupErrors.push(toError(error)); }
    }
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([toError(primaryError), ...cleanupErrors], "P15C2 scenario and owned cleanup both failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P15C2 owned cleanup failed.");
}

function configureScenario(project: string, mode: Mode): void {
  configureParallelProject(project);
  copyFileSync(fixturePath, path.join(project, ".nodulus", "fixtures", "par-015-cleanup-stages-cli.mjs"));
  const roles = mode === "readiness" ? ["codex-readiness", "codex-stopper"] as const : ["opencode", "codex-stopper"] as const;
  for (const role of roles) {
    const wrapperPath = path.join(project, ".nodulus", "fixtures", `par-015-cleanup-${role}.cmd`);
    const scriptRelative = ".nodulus\\fixtures\\par-015-cleanup-stages-cli.mjs";
    const wrapper = `@echo off\r\n"${process.execPath}" "${scriptRelative}" "${controlRelative}" "${eventsRelative}" ${role} %*\r\nexit /b %ERRORLEVEL%\r\n`;
    writeFileSync(wrapperPath, wrapper, "utf8");
  }

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  profiles.held = {
    ...profiles.fixture,
    enabled: true,
    executable: path.join(project, ".nodulus", "fixtures", `par-015-cleanup-${roles[0]}.cmd`),
    kind: mode === "readiness" ? "codex" : "opencode",
    model: mode === "readiness" ? "p15c2-readiness" : "ollama/p15c2-fixture-model",
    timeoutMs: profileTimeoutMs,
    capabilities: mode === "repair" ? ["responseRepair"] : [],
  };
  profiles.stopper = {
    ...profiles.fixture,
    enabled: true,
    executable: path.join(project, ".nodulus", "fixtures", "par-015-cleanup-codex-stopper.cmd"),
    kind: "codex",
    model: "p15c2-stopper",
    timeoutMs: profileTimeoutMs,
    capabilities: [],
  };
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
    node.providerProfile = nodeId === "held" ? "held" : "stopper";
    node.instructions = [`.nodulus/instructions/${nodeId}.md`];
    node.inputs = nodeId === "dependent" ? { report: { from: "held.report", contract: "report.v1" } } : { request: { from: "request", contract: "request.v1" } };
    node.expectedOutputs = [{ name: "report", contract: "report.v1" }];
    writeJson(project, `.nodulus/nodes/${nodeId}.json`, node);
    writeFileSync(path.join(project, ".nodulus", "instructions", `${nodeId}.md`), `Instructions for ${nodeId}.\n`, "utf8");
  }
}

function assertRunFailure(outcome: RunOutcome): asserts outcome is RunOutcome & { result: RunResult; processSnapshot: Snapshot } {
  expect(outcome.result).toBeDefined();
  if (!outcome.result) throw outcome.error ?? new Error("Public graph call rejected instead of returning its failure result.");
  expect(outcome.result.status).toBe("error");
  expect(outcome.processSnapshot).toBeDefined();
  if (!outcome.processSnapshot) throw new Error("Public result callback did not capture the first-return process snapshot.");
}

function assertCleanupSummary(project: string, runIdValue: string, result: RunResult, operation: "readiness" | "repair_response"): void {
  const checkpoint = readCheckpoint(project, runIdValue);
  const graph = checkpoint.graph as { admissionClosed: boolean; recoveryRequired?: boolean; uncertainNodeIds?: string[]; cleanupUnverifiedNodeIds?: string[]; nodes: Record<string, Record<string, unknown>> };
  const heldNode = graph.nodes.held;
  const stopperNode = graph.nodes.stopper;
  expect(graph.admissionClosed).toBe(true);
  expect(heldNode).toMatchObject({
    phase: "failed",
    callId: expect.any(String),
    launch: operation === "readiness" ? false : true,
    failure: { code: "GRAPH_CANCELLED", message: expect.any(String) },
    cleanupUnverified: { code: "PROCESS_TREE_UNVERIFIED", operation, message: expect.any(String) },
  });
  if (operation === "repair_response") expect(heldNode.attempt).toBe(2);
  expect(graph.recoveryRequired).toBe(true);
  expect(graph.cleanupUnverifiedNodeIds).toEqual(["held"]);
  expect(graph.uncertainNodeIds).toBeUndefined();
  expect(stopperNode).toMatchObject({ phase: "failed", failure: { code: "P15C2_TRIGGER" } });
  const payload = result.result as { error?: Record<string, unknown> };
  const error = payload.error;
  const stopperCallId = String(stopperNode.callId);
  expect(error).toMatchObject({ code: "P15C2_TRIGGER", nodeId: "stopper", callId: stopperCallId, launch: true, recoveryRequired: true, cleanupUnverifiedNodeIds: ["held"] });
  expect(error).not.toHaveProperty("uncertainNodeIds");
}

function assertRepairEvidence(project: string, runIdValue: string, parentCallId: string, fixtureEventsPath: string, rootPid: number, descendantPid: number): void {
  const events = readRunEvents(project, runIdValue);
  const repairStarted = events.find((event) => event.event === "provider.call.started" && event.nodeId === "held" && event.operation === "repair_response");
  const repairCallId = String(repairStarted?.callId);
  expect(repairStarted).toMatchObject({ attempt: 2, parentCallId });
  expect(events.some((event) => event.event === "provider.call.completed" && event.callId === parentCallId && event.operation === "invoke")).toBe(true);
  expect(events.some((event) => event.event === "provider.call.completed" && event.callId === repairCallId && event.operation === "repair_response" && event.launched === true)).toBe(true);
  const parentTransport = readJson(path.join(project, ".nodulus", "runs", runIdValue, "calls", parentCallId, "transport.json"));
  const repairTransport = readJson(path.join(project, ".nodulus", "runs", runIdValue, "calls", repairCallId, "transport.json"));
  const repairRequest = readJson(path.join(project, ".nodulus", "runs", runIdValue, "calls", repairCallId, "request.json"));
  expect(parentTransport).toMatchObject({ started: true, exitCode: 0, cancelled: false });
  expect(repairRequest).toMatchObject({ callId: repairCallId, attempt: 2, operation: "repair_response", parentCallId });
  const argv = repairRequest.argv as string[];
  expect(argv[argv.indexOf("--agent") + 1]).toBe("nodulus-response");
  expect(argv[argv.indexOf("--session") + 1]).toBe("p15c2-session");
  expect(repairTransport).toMatchObject({ started: true, cancelled: true, timedOut: false, outputLimitExceeded: false });
  expect(repairTransport.cleanupUnverified).toMatchObject({ code: "PROCESS_TREE_UNVERIFIED", operationCause: "cancelled" });
  expect(repairTransport.terminationCause).toBe("cancelled");
  const fixtureEvents = readFixtureEvents(fixtureEventsPath);
  const opencodeStages = fixtureEvents.filter((event) => event.role === "opencode").map(({ stage }) => stage);
  const buildIndex = opencodeStages.indexOf("build-completed");
  expect(buildIndex).toBeGreaterThan(0);
  expect(opencodeStages.slice(0, buildIndex)).toContain("version");
  expect(opencodeStages.slice(0, buildIndex)).toContain("models");
  expect(opencodeStages.filter((stage) => stage === "build-completed")).toHaveLength(1);
  expect(opencodeStages.filter((stage) => stage === "repair-root-ready")).toHaveLength(1);
  expect(fixtureEvents.filter((event) => event.role === "opencode" && event.stage === "build-completed")).toHaveLength(1);
  const repairStart = fixtureEvents.find((event) => event.role === "opencode" && event.stage === "repair-root-ready");
  expect(repairStart).toMatchObject({ pid: rootPid, descendantPid, agent: "nodulus-response", session: "p15c2-session" });
  expect(fixtureEvents.filter((event) => event.role === "opencode" && event.stage === "repair-root-ready")).toHaveLength(1);
}

function assertOwnedProject(project: string, identity: string): void {
  const tempRoot = realpathSync.native(os.tmpdir());
  if (path.dirname(identity) !== tempRoot || !path.basename(identity).startsWith(`nodulus-${label}-`) || realpathSync.native(project) !== identity) {
    throw new Error(`Refusing P15C2 cleanup outside the exact generated project: '${identity}'.`);
  }
}

async function waitForJson<T extends Record<string, unknown>>(file: string, deadline: number, labelText: string, getOutcome?: () => RunOutcome | undefined): Promise<T> {
  while (!existsSync(file)) {
    const earlyOutcome = getOutcome?.();
    if (earlyOutcome) throw new Error(`P15C2 public run settled before ${labelText}; retaining partial PID evidence. ${describeOutcome(earlyOutcome)}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${labelText}: ${path.basename(file)}.`);
    await delay(10);
  }
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

async function waitForEvent(project: string, runIdValue: string, predicate: (event: Record<string, unknown>) => boolean, deadline: number, getOutcome?: () => RunOutcome | undefined): Promise<Record<string, unknown>> {
  while (Date.now() < deadline) {
    const event = readRunEvents(project, runIdValue).find(predicate);
    if (event) return event;
    const earlyOutcome = getOutcome?.();
    if (earlyOutcome) throw new Error(`P15C2 public run settled before required provider event. ${describeOutcome(earlyOutcome)}`);
    await delay(10);
  }
  throw new Error("Timed out waiting for parent provider completion evidence.");
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

function readCheckpoint(project: string, runIdValue: string): Record<string, unknown> {
  return readJson(path.join(project, ".nodulus", "runs", runIdValue, "run.json"));
}

function readRunEvents(project: string, runIdValue: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(project, ".nodulus", "runs", runIdValue, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
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

function emptyStorageMutations() {
  return { createRun: 0, writeRunFiles: 0, acquireRunLock: 0, releaseRunLock: 0 };
}

function nativeProcessSnapshot(observer: OwnedNativeProcessObserver | undefined) {
  if (!observer) throw new Error("P15C2 native process observer was not initialized before status inspection.");
  expect(observer.observationFailure).toBe(false);
  return {
    observationFailure: observer.observationFailure,
    diagnostics: observer.diagnostics.map(({ identity, pid, stages, exitCode, signal, errorName }) => ({ identity, pid, stages: [...stages], exitCode, signal, errorName })),
  };
}

function trackQuery<T>(promise: Promise<T>, queries: Promise<unknown>[], pending: Set<Promise<unknown>>): Promise<T> {
  let tracked: Promise<T>;
  tracked = promise.then((value) => {
    pending.delete(tracked);
    return value;
  }, (error: unknown) => {
    pending.delete(tracked);
    throw error;
  });
  queries.push(tracked);
  pending.add(tracked);
  void tracked.catch(() => undefined);
  return tracked;
}

function snapshotTree(root: string): Map<string, { kind: "directory" | "file"; bytes?: Buffer }> {
  const snapshot = new Map<string, { kind: "directory" | "file"; bytes?: Buffer }>();
  let totalBytes = 0;
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (snapshot.size >= 2048) throw new Error(`Snapshot exceeded 2048 entries under '${root}'.`);
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`Unexpected symbolic link while snapshotting '${root}'.`);
      if (metadata.isDirectory()) {
        if (!entry.isDirectory()) throw new Error(`Filesystem kind changed while snapshotting '${root}'.`);
        snapshot.set(relative, { kind: "directory" });
        visit(absolute, relative);
      } else if (metadata.isFile()) {
        if (!entry.isFile() || metadata.size > 8 * 1024 * 1024 - totalBytes) throw new Error(`Snapshot exceeded 8 MiB or encountered a kind change under '${root}'.`);
        const bytes = readFileSync(absolute);
        if (bytes.length !== metadata.size) throw new Error(`File size changed while snapshotting '${root}'.`);
        totalBytes += bytes.length;
        snapshot.set(relative, { kind: "file", bytes });
      } else throw new Error(`Unexpected filesystem entry while snapshotting '${root}'.`);
    }
  };
  visit(root, "");
  return snapshot;
}

async function withDeadline<T>(promise: Promise<T> | undefined, deadline: number, labelText: string): Promise<T> {
  if (!promise) throw new Error(`P15C2 ${labelText} is unavailable.`);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`P15C2 deadline expired before ${labelText}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`P15C2 timed out waiting for ${labelText} after ${remaining} ms.`)), remaining); }),
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

function toError(value: unknown): Error { return value instanceof Error ? value : new Error(safeDiagnostic(value)); }
function isAlreadyExists(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

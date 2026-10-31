import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportRunDiagnostic } from "../../src/application/export-run.js";
import { runWorkflow, type ApplicationRunResult, type ProviderPort } from "../../src/application/run-workflow.js";
import { observeOwnedNativeProcesses } from "../support/owned-native-processes.js";
import { createGraphOpenCodeFixture, type GraphOpenCodeFixture } from "../support/graph-opencode-fixture.js";
import { observeReadStorage } from "../support/read-only-storage-observer.js";
import { readParallelWorkflow } from "../support/parallel-project.js";
import { cleanupProviderProject } from "../support/provider-adapter-scenarios.js";
import { writeJson } from "../support/workflow-sequence.js";

type JsonRecord = Record<string, unknown>;
type RunSettlement =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };
type FileSnapshot = Array<{ relative: string; kind: "directory" | "file"; size: number; sha256?: string }>;
type ResourceMode = "explicit-workspace" | "distinct-private";

const scenarioLimitMs = 20_000;
const cleanupLimitMs = 10_000;
const caseLimitMs = 35_000;
const fixtureLimitMs = 60_000;
const nodeOrder = ["join", "audit", "left", "right", "prepare"] as const;
const aliasOrder = [
  { name: "joined", from: "join.report", contract: "report.v1" },
  { name: "auditSummary", from: "audit.report", contract: "report.v1" },
] as const;
const callerMarker = "PAR041_PRIVATE_CALLER_VALUE";
const requestMarker = "PAR041_PRIVATE_REQUEST_TEXT";
const privateProfileMarker = "PAR041_PRIVATE_PROFILE_VALUE";
const privatePathMarker = "C:\\PAR041_PRIVATE_EXECUTABLE_PATH\\provider.exe";
const privateResourceKeys = {
  shared: "PAR041_PRIVATE_SHARED_RESOURCE_KEY",
  left: "PAR041_PRIVATE_LEFT_RESOURCE_KEY",
  right: "PAR041_PRIVATE_RIGHT_RESOURCE_KEY",
  audit: "PAR041_PRIVATE_AUDIT_RESOURCE_KEY",
} as const;

describe("PAR041 portable graph export", () => {
  it("exports an executed fork/join graph, actual repair lineage, and opaque resource relationships deterministically", async () => {
    await executeGraphJourney("explicit-workspace", (state) => assertIntactGraphExport(state));
  }, caseLimitMs);

  it("sanitizes malformed captured fields and rejects foreign-node repair ancestry without writing", async () => {
    await executeGraphJourney("distinct-private", async (state) => {
      await exerciseMalformedPrivacyProjection(state);
      await restoreEventsAndDefinitions(state);
      await exerciseForeignRepairParent(state);
      await restoreEventsAndDefinitions(state);
      expect(readFileSync(state.eventsPath, "utf8")).toBe(state.originalEventsText);
      expect(readFileSync(state.definitionsPath, "utf8")).toBe(state.originalDefinitionsText);
    });
  }, caseLimitMs);
});

type JourneyState = {
  fixture: GraphOpenCodeFixture;
  native: ReturnType<typeof observeOwnedNativeProcesses>;
  runPromise: Promise<ApplicationRunResult>;
  runSettlement: Promise<RunSettlement>;
  runId: string;
  runDirectory: string;
  validatorLog: string;
  providerCounts: ProviderCounts;
  scenarioDeadline: number;
  eventsPath: string;
  definitionsPath: string;
  originalEventsText: string;
  originalDefinitionsText: string;
  accepted: AcceptedEvidence;
  pendingWork: Set<Promise<void>>;
};

type ProviderCounts = {
  isAvailable: number;
  invoke: number;
  repairResponse: number;
  usageForLastCall: number;
  telemetryForCall: number;
  launchForCall: number;
};

type ActivitySnapshot = {
  calls: string;
  operations: string;
  providerCounts: ProviderCounts;
  validatorBytes: string;
  native: string;
  nativeFailure: boolean;
};

type AcceptedEvidence = {
  byNode: Map<string, JsonRecord>;
  events: JsonRecord[];
  runTree: FileSnapshot;
  fixtureTree: FileSnapshot;
  validatorBytes: string;
};

async function executeGraphJourney(mode: ResourceMode, assertions: (state: JourneyState) => Promise<void> | void): Promise<void> {
  const fixtureDeadline = Date.now() + fixtureLimitMs;
  const scenarioDeadline = Math.min(Date.now() + scenarioLimitMs, fixtureDeadline);
  let fixture: GraphOpenCodeFixture | undefined;
  let native: ReturnType<typeof observeOwnedNativeProcesses> | undefined;
  let runPromise: Promise<ApplicationRunResult> | undefined;
  let runSettlement: Promise<RunSettlement> | undefined;
  let runIsSettled = false;
  let validatorLog: string | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const pendingWork = new Set<Promise<void>>();

  try {
    const configurations = fixtureConfigurations();
    fixture = await createGraphOpenCodeFixture(configurations, { deliveryWave: false });
    configureWorkflowAndNodes(fixture, mode, validatorLogPath(fixture.project));
    validatorLog = validatorLogPath(fixture.project);

    const providerCounts: ProviderCounts = {
      isAvailable: 0,
      invoke: 0,
      repairResponse: 0,
      usageForLastCall: 0,
      telemetryForCall: 0,
      launchForCall: 0,
    };
    const provider = observeProvider(fixture.provider, providerCounts);
    native = observeOwnedNativeProcesses();

    runPromise = runWorkflow({
      projectRoot: fixture.project,
      cwd: fixture.project,
      workflow: "example",
      sources: [{ kind: "inline", text: requestMarker }],
      callerInputs: { goal: callerMarker },
    }, provider);
    runSettlement = runPromise.then<RunSettlement, RunSettlement>(
      (result) => { runIsSettled = true; return { kind: "result", result }; },
      (error: unknown) => { runIsSettled = true; return { kind: "rejection", error }; },
    );

    const initialStarts = [waitForStarted(fixture, runSettlement, pendingWork, "prepare", "build", 1, scenarioDeadline)];
    if (mode === "explicit-workspace") initialStarts.push(waitForStarted(fixture, runSettlement, pendingWork, "audit", "build", 1, scenarioDeadline));
    await Promise.all(initialStarts);
    await releaseAndAccept(fixture, runSettlement, pendingWork, "prepare", scenarioDeadline);

    if (mode === "explicit-workspace") {
      expect(fixture.hasStarted("left", "build")).toBe(false);
      expect(fixture.hasStarted("right", "build")).toBe(false);
      const blockedByWorkspace = readCheckpoint(fixture.project, runIdFor(fixture));
      expect(nodePhase(blockedByWorkspace, "left")).toBe("not_started");
      expect(nodePhase(blockedByWorkspace, "right")).toBe("not_started");
      fixture.release("audit", "build", 1);
      await waitForFinished(fixture, runSettlement, pendingWork, "audit", "build", 1, scenarioDeadline);
      await waitForAccepted(fixture, runSettlement, pendingWork, "audit", scenarioDeadline);
    }

    await waitForStarted(fixture, runSettlement, pendingWork, "left", "build", 1, scenarioDeadline);
    expect(fixture.hasStarted("right", "build")).toBe(false);
    const beforeLeftRelease = readCheckpoint(fixture.project, runIdFor(fixture));
    expect(nodePhase(beforeLeftRelease, "right")).toBe("not_started");
    fixture.release("left", "build", 1);
    await waitForFinished(fixture, runSettlement, pendingWork, "left", "build", 1, scenarioDeadline);
    await waitForStarted(fixture, runSettlement, pendingWork, "left", "repair", 1, scenarioDeadline);
    expect(fixture.hasStarted("right", "build")).toBe(false);
    const duringLeftRepair = readCheckpoint(fixture.project, runIdFor(fixture));
    expect(nodePhase(duringLeftRepair, "right")).toBe("not_started");
    fixture.release("left", "repair", 1);
    await waitForFinished(fixture, runSettlement, pendingWork, "left", "repair", 1, scenarioDeadline);
    await waitForAccepted(fixture, runSettlement, pendingWork, "left", scenarioDeadline);

    if (mode === "distinct-private") {
      await Promise.all([
        waitForStarted(fixture, runSettlement, pendingWork, "right", "build", 1, scenarioDeadline),
        waitForStarted(fixture, runSettlement, pendingWork, "audit", "build", 1, scenarioDeadline),
      ]);
      const privateKeysPermitBranch = readCheckpoint(fixture.project, runIdFor(fixture));
      expect(nodePhase(privateKeysPermitBranch, "audit")).toBe("active");
      expect(nodePhase(privateKeysPermitBranch, "right")).toBe("active");
    } else {
      await waitForStarted(fixture, runSettlement, pendingWork, "right", "build", 1, scenarioDeadline);
    }
    fixture.release("right", "build", 1);
    await waitForFinished(fixture, runSettlement, pendingWork, "right", "build", 1, scenarioDeadline);
    await waitForAccepted(fixture, runSettlement, pendingWork, "right", scenarioDeadline);

    if (mode === "distinct-private") {
      expect(fixture.hasStarted("join", "build")).toBe(false);
      const joinBlockedByDefaultWorkspace = readCheckpoint(fixture.project, runIdFor(fixture));
      expect(nodePhase(joinBlockedByDefaultWorkspace, "audit")).toBe("active");
      expect(nodePhase(joinBlockedByDefaultWorkspace, "join")).toBe("not_started");
      fixture.release("audit", "build", 1);
      await waitForFinished(fixture, runSettlement, pendingWork, "audit", "build", 1, scenarioDeadline);
      await waitForAccepted(fixture, runSettlement, pendingWork, "audit", scenarioDeadline);
    }

    await waitForStarted(fixture, runSettlement, pendingWork, "join", "build", 1, scenarioDeadline);
    fixture.release("join", "build", 1);
    await waitForFinished(fixture, runSettlement, pendingWork, "join", "build", 1, scenarioDeadline);
    await waitForAccepted(fixture, runSettlement, pendingWork, "join", scenarioDeadline);

    const settlement = await withinDeadline(runSettlement, scenarioDeadline, "graph workflow settlement");
    if (settlement.kind === "rejection") throw new Error(`Graph workflow rejected: ${errorSummary(settlement.error)}`, { cause: settlement.error });
    expect(settlement.result.status).toBe("success");
    expect(fixture.calls).toHaveLength(6);
    expect(fixture.calls.every((call) => call.adapterSettled)).toBe(true);
    expect(fixture.operations()).toHaveLength(6);
    fixture.validateProcessIds();

    const runId = runIdFor(fixture);
    const runDirectory = path.join(fixture.project, ".nodulus", "runs", runId);
    const validatorLogFile = validatorLog;
    if (!validatorLogFile) throw new Error("The real validator log path was not configured.");
    const validatorBytes = readFileSync(validatorLogFile, "utf8");
    const validatorRecords = parseJsonLines(validatorBytes, "validator log");
    expect(validatorRecords).toHaveLength(1);
    const validatorPid = validatorRecords[0].pid;
    if (typeof validatorPid !== "number" || !Number.isSafeInteger(validatorPid) || validatorPid <= 0) {
      throw new Error("The real prepare validator did not record a valid child PID.");
    }
    expect(fixture.operations().some((operation) => operation.nodeId === "prepare" && operation.operation === "build")).toBe(true);
    expect(fixture.operations().filter((operation) => operation.nodeId === "prepare").length).toBe(1);
    expect(native.observationFailure).toBe(false);
    const nativeRecords = native.diagnostics;
    const directSpawnCount = nativeRecords.filter((record) => record.stages.includes("spawn")).length;
    expect(directSpawnCount).toBeGreaterThanOrEqual(fixture.calls.length + 1);
    expect(nativeRecords.every((record) => record.stages.includes("spawn") && record.stages.includes("close"))).toBe(true);
    expect(nativeRecords.some((record) => record.pid === validatorPid && record.stages.includes("spawn") && record.stages.includes("close"))).toBe(true);

    const accepted = captureAcceptedEvidence(fixture, runDirectory, validatorBytes);
    const resultObject = asRecord(settlement.result.result, "graph result");
    const resultArtifacts = asArray(resultObject.artifacts, "run result artifacts").map((item) => asRecord(item, "run result alias"));
    expect(resultArtifacts.map((item) => item.name)).toEqual(aliasOrder.map(({ name }) => name));
    for (const alias of aliasOrder) {
      const artifact = resultArtifacts.find((item) => item.name === alias.name);
      expect(artifact?.contract).toBe(alias.contract);
      expect(asRecord(artifact?.data, `run result data '${alias.name}'`)).toHaveProperty("text");
    }

    const state: JourneyState = {
      fixture,
      native,
      runPromise,
      runSettlement,
      runId,
      runDirectory,
      validatorLog: validatorLogFile,
      providerCounts,
      scenarioDeadline,
      eventsPath: path.join(runDirectory, "events.jsonl"),
      definitionsPath: path.join(runDirectory, "context", "definitions.json"),
      originalEventsText: readFileSync(path.join(runDirectory, "events.jsonl"), "utf8"),
      originalDefinitionsText: readFileSync(path.join(runDirectory, "context", "definitions.json"), "utf8"),
      accepted,
      pendingWork,
    };
    assertSuccessfulSavedGraph(state);
    expect(Date.now()).toBeLessThan(scenarioDeadline);
    await assertions(state);
    expect(Date.now()).toBeLessThan(scenarioDeadline);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  let cleanupSafe = true;
  const cleanupDeadline = Date.now() + cleanupLimitMs;
  if (fixture) {
    try { fixture.releaseAll(); } catch (error) { cleanupSafe = false; cleanupErrors.push(error); }
    if (runSettlement && !runIsSettled) {
      try {
        await withinDeadline(runSettlement, cleanupDeadline, "public run settlement during cleanup");
      } catch (error) {
        cleanupSafe = false;
        cleanupErrors.push(error);
      }
    }
    if (fixture.calls.some((call) => !call.adapterSettled)) {
      try { await fixture.drain(remainingMs(cleanupDeadline, "provider drain")); }
      catch (error) { cleanupSafe = false; cleanupErrors.push(error); }
    }
    try { fixture.validateProcessIds(); }
    catch (error) { cleanupSafe = false; cleanupErrors.push(error); }
    if (pendingWork.size > 0) {
      try { await withinDeadline(Promise.all([...pendingWork]), cleanupDeadline, "pending marker/export work during cleanup"); }
      catch (error) { cleanupSafe = false; cleanupErrors.push(error); }
    }
  }
  if (native) {
    try { await native.drain(cleanupDeadline); }
    catch (error) { cleanupSafe = false; cleanupErrors.push(error); }
  }
  if (fixture && !hasPrimaryError && cleanupSafe && cleanupErrors.length === 0) {
    try { cleanupProviderProject(fixture.project); }
    catch (error) { cleanupErrors.push(error); }
  }

  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], `PAR041 failed; project retained at ${fixture?.project ?? "unavailable"}.`);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `PAR041 cleanup failed; project retained at ${fixture?.project ?? "unavailable"}.`);
}

async function assertIntactGraphExport(state: JourneyState): Promise<void> {
  const first = await assertStableExportPair(state, "intact graph export");

  expect(first.schemaVersion).toBe(1);
  expect(asRecord(first.run, "export run")).toMatchObject({ runId: state.runId, status: "success", phase: "completed" });
  expect(first.diagnostics).toEqual([]);
  const definitions = asRecord(first.definitions, "portable definitions");
  assertWorkflowProjection(definitions, "explicit-workspace");
  assertProjectedArtifacts(first, state);
  assertPortableLifecycle(first, state);
  assertPortableRepairLineage(first, state);
  assertNoPrivateValues(JSON.stringify(first));
}

async function assertStableExportPair(state: JourneyState, label: string): Promise<JsonRecord> {
  const runTree = snapshotTree(state.runDirectory);
  const fixtureTree = snapshotTree(path.join(state.fixture.project, ".nodulus", "fixtures"));
  const activity = snapshotActivity(state.fixture, state.providerCounts, state.validatorLog, state.native);
  let first: JsonRecord | undefined;
  let firstSerialized: string | undefined;
  for (let index = 0; index < 2; index += 1) {
    const observer = observeReadStorage();
    const query = trackRead(exportRunDiagnostic(state.fixture.project, state.runId, observer.storage), state);
    const exported = asRecord(await withinDeadline(query, state.scenarioDeadline, `${label} read ${index + 1}`), `${label} read ${index + 1}`);
    expect(observer.mutations).toEqual({ createRun: 0, writeRunFiles: 0, acquireRunLock: 0, releaseRunLock: 0 });
    expect(snapshotTree(state.runDirectory)).toEqual(runTree);
    expect(snapshotTree(path.join(state.fixture.project, ".nodulus", "fixtures"))).toEqual(fixtureTree);
    expect(snapshotActivity(state.fixture, state.providerCounts, state.validatorLog, state.native)).toEqual(activity);
    const serialized = JSON.stringify(exported);
    if (first === undefined) {
      first = exported;
      firstSerialized = serialized;
    } else {
      expect(serialized).toBe(firstSerialized);
    }
  }
  if (!first) throw new Error(`No ${label} export was returned.`);
  return first;
}

function assertSuccessfulSavedGraph(state: JourneyState): void {
  const checkpoint = readCheckpoint(state.fixture.project, state.runId);
  expect(checkpoint.status).toBe("success");
  expect(checkpoint.phase).toBe("completed");
  expect(asArray(checkpoint.completedNodes, "completed nodes")).toEqual(expect.arrayContaining([...nodeOrder]));
  expect(asArray(checkpoint.completedNodes, "completed nodes")).toHaveLength(nodeOrder.length);
  const graph = asRecord(checkpoint.graph, "checkpoint graph");
  const nodes = asRecord(graph.nodes, "checkpoint nodes");
  const acceptedByNode = new Map<string, JsonRecord>();
  for (const nodeId of nodeOrder) {
    const node = asRecord(nodes[nodeId], `checkpoint node '${nodeId}'`);
    expect(node.phase).toBe("accepted");
    const accepted = asRecord(node.accepted, `accepted manifest '${nodeId}'`);
    expect(accepted.attempt).toBe(nodeId === "left" ? 2 : 1);
    expect(typeof accepted.callId).toBe("string");
    const artifactRows = asArray(accepted.artifacts, `accepted artifacts '${nodeId}'`).map((item) => asRecord(item, "accepted artifact"));
    expect(artifactRows.map((item) => [item.name, item.contract])).toEqual([["report", "report.v1"]]);
    for (const artifact of artifactRows) assertSavedHash(state.runDirectory, artifact.ref, artifact.sha256);
    assertSavedHash(state.runDirectory, accepted.resultRef, accepted.resultSha256);
    assertSavedHash(state.runDirectory, accepted.validationRef, accepted.validationSha256);
    assertSavedHash(state.runDirectory, accepted.responseRef, accepted.responseSha256);
    acceptedByNode.set(nodeId, accepted);
  }
  state.accepted.byNode = acceptedByNode;
  const eventRows = parseJsonLines(readFileSync(state.eventsPath, "utf8"), "run events");
  const eventSequence = eventRows.map((event) => event.sequence);
  expect(eventSequence.every((sequence) => Number.isSafeInteger(sequence))).toBe(true);
  expect(new Set(eventSequence).size).toBe(eventRows.length);
  for (let index = 1; index < eventSequence.length; index += 1) {
    expect(eventSequence[index]).toBe((eventSequence[index - 1] as number) + 1);
  }
  const acceptedEvents = eventRows.filter((event) => event.event === "node.accepted");
  expect(acceptedEvents).toHaveLength(nodeOrder.length);
  for (const nodeId of nodeOrder) {
    const accepted = acceptedByNode.get(nodeId);
    if (!accepted || typeof accepted.callId !== "string") throw new Error(`Missing accepted call for '${nodeId}'.`);
    const acceptedRows = acceptedEvents.filter((event) => event.nodeId === nodeId && event.callId === accepted.callId);
    expect(acceptedRows).toHaveLength(1);
  }
  for (const call of state.fixture.calls) {
    const starts = eventRows.filter((event) => event.event === "provider.call.started" && event.callId === call.callId);
    const completions = eventRows.filter((event) => event.event === "provider.call.completed" && event.callId === call.callId);
    expect(starts).toHaveLength(1);
    expect(completions).toHaveLength(1);
    expect(starts[0]).toMatchObject({ nodeId: call.nodeId, attempt: call.callAttempt, callId: call.callId, operation: call.method });
    expect(completions[0]).toMatchObject({ nodeId: call.nodeId, attempt: call.callAttempt, callId: call.callId, operation: call.method });
    expect(typeof completions[0].launched === "boolean" || completions[0].launched === null).toBe(true);
    expect(starts[0].sequence).toBeLessThan(completions[0].sequence as number);

    const attemptPath = `nodes/${call.nodeId}/attempt-${String(call.callAttempt).padStart(3, "0")}/invocation.json`;
    const invocation = parseJsonFile(path.join(state.runDirectory, attemptPath));
    expect(invocation).toMatchObject({
      callId: call.callId,
      nodeId: call.nodeId,
      attempt: call.callAttempt,
      invocationAttempt: call.invocationAttempt,
      operation: call.method,
      runId: state.runId,
    });
    expect(invocation.parentCallId ?? null).toBe(call.parentCallId);
    const request = parseJsonFile(path.join(state.runDirectory, "calls", call.callId, "request.json"));
    expect(request).toMatchObject({
      callId: call.callId,
      nodeId: call.nodeId,
      attempt: call.callAttempt,
      operation: call.method,
      parentCallId: call.parentCallId,
      runId: state.runId,
    });

    const accepted = acceptedByNode.get(call.nodeId);
    if (accepted?.callId === call.callId) {
      const nodeAccepted = acceptedEvents.find((event) => event.nodeId === call.nodeId && event.callId === call.callId);
      if (!nodeAccepted) throw new Error(`Accepted event is missing for '${call.nodeId}'.`);
      expect(completions[0].sequence).toBeLessThan(nodeAccepted.sequence as number);
    }
  }
  const invocationCounts = new Map<string, number>();
  for (const call of state.fixture.calls) invocationCounts.set(call.nodeId, (invocationCounts.get(call.nodeId) ?? 0) + 1);
  expect([...invocationCounts.keys()].sort((left, right) => left.localeCompare(right))).toEqual([...nodeOrder].sort((left, right) => left.localeCompare(right)));
  expect(invocationCounts.get("left")).toBe(2);
  expect([...invocationCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(6);
  const leftBuild = state.fixture.calls.find((call) => call.nodeId === "left" && call.method === "invoke");
  const leftRepair = state.fixture.calls.find((call) => call.nodeId === "left" && call.method === "repair_response");
  if (!leftBuild || !leftRepair) throw new Error("Actual same-node repair call lineage is missing.");
  expect(leftBuild.callAttempt).toBe(1);
  expect(leftRepair.callAttempt).toBe(2);
  expect(leftRepair.invocationAttempt).toBe(1);
  expect(leftRepair.parentCallId).toBe(leftBuild.callId);
  const leftBuildOperation = state.fixture.operation("left", "build", 1);
  const leftRepairOperation = state.fixture.operation("left", "repair", 1);
  expect(leftBuildOperation.sessionID).toBe("par041_left_session");
  expect(leftRepairOperation.sessionID).toBe(leftBuildOperation.sessionID);
  expect(leftRepairOperation.argv).toContain("--agent");
  const repairAgentIndex = leftRepairOperation.argv.indexOf("--agent");
  expect(leftRepairOperation.argv[repairAgentIndex + 1]).toBe("nodulus-response");
  expect(leftRepairOperation.argv).toContain("--session");
  const repairSessionIndex = leftRepairOperation.argv.indexOf("--session");
  expect(leftRepairOperation.argv[repairSessionIndex + 1]).toBe(leftBuildOperation.sessionID);
  if (typeof leftBuild.raw !== "string") throw new Error("The original left response was not captured.");
  expect(leftRepairOperation.stdin).toContain(leftBuild.raw);
  const leftInvocation = parseJsonFile(path.join(state.runDirectory, "nodes", "left", "attempt-002", "invocation.json"));
  expect(asRecord(leftInvocation.inputs, "repair mapped inputs").report).toEqual({ text: "prepared" });
  const auditCall = state.fixture.calls.find((call) => call.nodeId === "audit" && call.method === "invoke");
  if (!auditCall) throw new Error("Actual audit provider invocation is missing.");
  const auditInvocation = parseJsonFile(path.join(state.runDirectory, "nodes", "audit", "attempt-001", "invocation.json"));
  expect(asRecord(auditInvocation.inputs, "caller mapped inputs").request).toBe(callerMarker);
  expect(auditCall.adapterSettled).toBe(true);
}

function assertWorkflowProjection(definitions: JsonRecord, mode: ResourceMode): void {
  const workflow = asRecord(definitions.workflow, "portable workflow");
  expect(workflow).toMatchObject({ schemaVersion: 2, id: "example", nodes: [...nodeOrder] });
  expect(workflow.inputs).toEqual({ goal: { contract: "request.v1" } });
  const execution = asRecord(workflow.execution, "portable execution");
  expect(execution.kind).toBe("dag");
  expect(execution.maxConcurrency).toBe(3);
  const dependencies = asRecord(execution.dependsOn, "portable dependencies");
  expect(dependencies).toEqual({
    prepare: [],
    audit: mode === "explicit-workspace" ? [] : ["left"],
    left: ["prepare"],
    right: ["prepare"],
    join: ["left", "right"],
  });
  expect(workflow.outputs).toEqual(aliasOrder);

  const nodes = asArray(definitions.nodes, "portable node definitions").map((item) => asRecord(item, "portable node"));
  expect(nodes.map((node) => node.id)).toEqual([...nodeOrder]);
  const nodesById = new Map<string, JsonRecord>();
  for (const node of nodes) if (typeof node.id === "string") nodesById.set(node.id, node);
  expect(asRecord(asRecord(nodesById.get("audit"), "audit node").inputs, "audit mappings")).toEqual({
    request: { from: "caller.goal", contract: "request.v1" },
  });
  expect(asRecord(asRecord(nodesById.get("join"), "join node").inputs, "join mappings")).toEqual({
    left: { from: "left.report", contract: "report.v1" },
    right: { from: "right.report", contract: "report.v1" },
  });

  const resources = asRecord(execution.resources, "portable resource declarations");
  expect(Object.hasOwn(resources, "join")).toBe(false);
  expect(resources.prepare).toEqual([]);
  const leftResources = asArray(resources.left, "left resources");
  const rightResources = asArray(resources.right, "right resources");
  expect(leftResources).toHaveLength(2);
  expect(rightResources).toHaveLength(2);
  expect(leftResources.every((value) => typeof value === "string")).toBe(true);
  expect(rightResources.every((value) => typeof value === "string")).toBe(true);
  expect(leftResources[0]).toBe(rightResources[0]);
  expect(leftResources[1]).not.toBe(rightResources[1]);
  expect(leftResources).not.toContain(privateResourceKeys.shared);
  expect(rightResources).not.toContain(privateResourceKeys.shared);
  if (mode === "explicit-workspace") {
    expect(resources.audit).toEqual(["workspace"]);
  } else {
    const auditResources = asArray(resources.audit, "audit resources");
    expect(auditResources).toHaveLength(1);
    expect(auditResources[0]).not.toBe("workspace");
    expect(auditResources[0]).not.toBe(leftResources[0]);
  }
  const reportContract = asRecord(asRecord(definitions.contracts, "portable contracts")["report.v1"], "report contract summary");
  expect(reportContract).toMatchObject({ type: "object", propertyCount: 1, requiredCount: 1, additionalProperties: false });
  expect(definitions.providerProfileCount).toBe(1);
}

function assertProjectedArtifacts(exported: JsonRecord, state: JourneyState): void {
  const artifacts = asArray(exported.artifacts, "portable artifacts").map((item) => asRecord(item, "portable artifact"));
  expect(artifacts.map((artifact) => artifact.nodeId)).toEqual([...nodeOrder]);
  expect(artifacts.every((artifact) => artifact.accepted === true)).toBe(true);
  expect(artifacts.map((artifact) => artifact.name)).toEqual(nodeOrder.map(() => "report"));
  expect(artifacts.every((artifact) => artifact.reference === `nodes/${String(artifact.nodeId)}/artifacts/report.json`)).toBe(true);

  const outputFile = asArray(JSON.parse(readFileSync(path.join(state.runDirectory, "outputs.json"), "utf8")) as unknown, "saved output aliases")
    .map((item) => asRecord(item, "saved output alias"));
  expect(outputFile.map((alias) => alias.name)).toEqual(aliasOrder.map(({ name }) => name));
  expect(outputFile.map((alias) => alias.contract)).toEqual(aliasOrder.map(({ contract }) => contract));
}

function assertPortableRepairLineage(exported: JsonRecord, state: JourneyState): void {
  const repair = state.fixture.calls.find((call) => call.nodeId === "left" && call.method === "repair_response");
  const build = state.fixture.calls.find((call) => call.nodeId === "left" && call.method === "invoke");
  if (!repair || !build || !repair.parentCallId) throw new Error("Real same-node repair lineage was not captured.");
  const timeline = asArray(exported.timeline, "portable timeline").map((item) => asRecord(item, "timeline item"));
  const starts = timeline.filter((event) => event.event === "provider.call.started" && event.callId === repair.callId);
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ nodeId: "left", callId: repair.callId, attempt: 2, operation: "repair_response", parentCallId: build.callId });
  expect(starts[0].parentCallId).not.toBe(state.fixture.calls.find((call) => call.nodeId === "audit")?.callId);
  const accepted = state.accepted.byNode.get("left");
  expect(accepted?.callId).toBe(repair.callId);
}

function assertPortableLifecycle(exported: JsonRecord, state: JourneyState): void {
  const timeline = asArray(exported.timeline, "portable lifecycle timeline").map((item) => asRecord(item, "portable lifecycle event"));
  const accepted = timeline.filter((event) => event.event === "node.accepted");
  expect(accepted).toHaveLength(nodeOrder.length);
  expect(accepted.map((event) => event.nodeId)).toEqual(expect.arrayContaining([...nodeOrder]));
  const completed = timeline.filter((event) => event.event === "provider.call.completed");
  expect(completed).toHaveLength(state.fixture.calls.length);
  for (const call of state.fixture.calls) {
    const starts = timeline.filter((event) => event.event === "provider.call.started" && event.callId === call.callId);
    const completions = completed.filter((event) => event.callId === call.callId);
    expect(starts).toHaveLength(1);
    expect(completions).toHaveLength(1);
    expect(typeof completions[0].launched === "boolean" || completions[0].launched === null).toBe(true);
    expect(starts[0].sequence).toBeLessThan(completions[0].sequence as number);
    const acceptedForCall = accepted.find((event) => event.nodeId === call.nodeId && event.callId === call.callId);
    if (acceptedForCall) expect(completions[0].sequence).toBeLessThan(acceptedForCall.sequence as number);
  }
}

async function exerciseMalformedPrivacyProjection(state: JourneyState): Promise<void> {
  const marker = "PAR041_PRIVATE_NESTED_SENTINEL";
  const definitions = parseJsonFile(state.definitionsPath);
  definitions.schemaVersion = { private: marker };
  definitions.engineVersion = [privatePathMarker];
  const workflow = asRecord(definitions.workflow, "saved workflow");
  workflow.schemaVersion = { private: marker };
  workflow.id = { private: marker };
  const nodes = asArray(workflow.nodes, "saved nodes");
  nodes.push({ id: marker, executable: privatePathMarker });
  const inputs = asRecord(workflow.inputs, "saved caller declarations");
  inputs.goal = { contract: "request.v1", unknown: { credential: marker, path: privatePathMarker } };
  const execution = asRecord(workflow.execution, "saved graph execution");
  execution.maxConcurrency = { private: marker };
  execution.kind = [marker];
  execution.unknownPrivateField = { marker, nested: [privatePathMarker] };
  const resources = asRecord(execution.resources, "saved graph resources");
  resources.left = [{ key: marker }, privateResourceKeys.left];
  const outputs = asArray(workflow.outputs, "saved workflow outputs");
  outputs.push({ name: { private: marker }, from: [privatePathMarker], contract: marker });
  const capturedNodes = asArray(definitions.nodes, "saved node definitions").map((node) => asRecord(node, "saved node"));
  const left = capturedNodes.find((node) => node.id === "left");
  if (!left) throw new Error("Captured left node definition is missing.");
  const leftInputs = asRecord(left.inputs, "captured left mappings");
  leftInputs.privateMapping = { from: { private: marker }, contract: [privatePathMarker] };
  const leftOutputs = asArray(left.expectedOutputs, "captured left outputs");
  leftOutputs.push({ name: { private: marker }, contract: [privatePathMarker] });
  left.schemaVersion = { private: marker };
  const contracts = asRecord(definitions.contracts, "captured contracts");
  const reportSchema = asRecord(contracts["report.v1"], "captured report schema");
  reportSchema.description = `${marker}:${privatePathMarker}`;
  const properties = asRecord(reportSchema.properties, "captured report properties");
  const textSchema = asRecord(properties.text, "captured report text schema");
  textSchema.description = marker;
  const required = asArray(reportSchema.required, "captured required fields");
  required.push({ private: marker });
  const profiles = asRecord(definitions.providerProfiles, "captured provider profiles");
  const profile = asRecord(profiles.fixture, "captured fixture profile");
  profile.model = marker;
  profile.executable = privatePathMarker;
  profile.credentials = { token: marker, nested: privatePathMarker };

  const events = parseJsonLines(state.originalEventsText, "original events");
  const buildCall = state.fixture.calls.find((call) => call.nodeId === "left" && call.method === "invoke" && call.callAttempt === 1);
  if (!buildCall || typeof buildCall.callId !== "string") throw new Error("The actual first left invoke call is missing.");
  const buildStarted = events.find((event) => event.event === "provider.call.started" && event.nodeId === "left" && event.attempt === 1 && event.operation === "invoke" && event.callId === buildCall.callId);
  const completion = events.find((event) => event.event === "provider.call.completed" && event.nodeId === "left" && event.callId === buildCall.callId);
  const acceptance = events.find((event) => event.event === "node.accepted" && event.nodeId === "left");
  const intakeEvent = events.find((event) => event.event === "run.intake.completed");
  if (!buildStarted || !completion || !acceptance || !intakeEvent) throw new Error("The actual left call and required graph evidence events are missing.");
  completion.elapsedMs = { nested: marker };
  completion.launched = { private: marker };
  completion.outcome = { details: [privatePathMarker, marker] };
  completion.validationRef = { private: privatePathMarker };
  acceptance.artifactNames = [{ private: marker }];
  buildStarted.callId = marker;
  intakeEvent.nodeId = { private: marker };
  intakeEvent.attempt = [marker];
  writeFileSync(state.definitionsPath, `${JSON.stringify(definitions, null, 2)}\n`, "utf8");
  writeEvents(state.eventsPath, events);

  const exported = await assertStableExportPair(state, "malformed-definition privacy export");
  assertNoPrivateValues(JSON.stringify(exported), marker, privatePathMarker, callerMarker, requestMarker, privateProfileMarker, ...Object.values(privateResourceKeys));
  const projectedDefinitions = asRecord(exported.definitions, "faulted portable definitions");
  const projectedWorkflow = asRecord(projectedDefinitions.workflow, "faulted portable workflow");
  expect(projectedWorkflow.nodes).toEqual([...nodeOrder]);
  expect(projectedWorkflow.inputs).toEqual({ goal: { contract: "request.v1" } });
  expect(projectedWorkflow.outputs).toEqual(aliasOrder);
  const projectedNodes = asArray(projectedDefinitions.nodes, "faulted portable nodes").map((item) => asRecord(item, "faulted portable node"));
  expect(projectedNodes.map((node) => node.id)).toEqual([...nodeOrder]);
  const projectedExecution = asRecord(projectedWorkflow.execution, "faulted portable execution");
  expect(projectedExecution.maxConcurrency).toBeUndefined();
  expect(projectedExecution.kind).toBeUndefined();
  const attempts = asArray(exported.attempts, "privacy attempt summaries").map((item) => asRecord(item, "privacy attempt summary"));
  expect(attempts.some((attempt) => asArray(attempt.callIds, "attempt call IDs").includes(marker))).toBe(false);
  expect(attempts.some((attempt) => asArray(attempt.callIds, "attempt call IDs").includes(state.accepted.byNode.get("left")?.callId))).toBe(true);
  expect(exported.artifacts).toEqual([]);
  const diagnostics = asArray(exported.diagnostics, "privacy diagnostics");
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(diagnostics.every((diagnostic) => typeof diagnostic === "string")).toBe(true);
}

async function exerciseForeignRepairParent(state: JourneyState): Promise<void> {
  const events = parseJsonLines(state.originalEventsText, "original events");
  const repair = state.fixture.calls.find((call) => call.nodeId === "left" && call.method === "repair_response");
  const foreign = state.fixture.calls.find((call) => call.nodeId === "audit" && call.method === "invoke");
  if (!repair || !foreign) throw new Error("Actual left repair or foreign audit call is missing.");
  const linked = events.filter((event) =>
    (event.event === "provider.call.started" || event.event === "provider.call.completed") && event.callId === repair.callId,
  );
  expect(linked).toHaveLength(2);
  for (const event of linked) event.parentCallId = foreign.callId;
  writeEvents(state.eventsPath, events);

  const exported = await assertStableExportPair(state, "foreign-parent export");
  const timeline = asArray(exported.timeline, "foreign-parent timeline").map((item) => asRecord(item, "foreign-parent timeline item"));
  const repairRows = timeline.filter((event) => event.callId === repair.callId);
  expect(repairRows.some((event) => event.parentCallId === foreign.callId)).toBe(false);
  const artifacts = asArray(exported.artifacts, "foreign-parent artifacts").map((item) => asRecord(item, "foreign-parent artifact"));
  expect(artifacts.some((artifact) => artifact.nodeId === "left" && artifact.accepted === true)).toBe(false);
  for (const independentlyAccepted of ["prepare", "audit", "right"]) {
    expect(artifacts.some((artifact) => artifact.nodeId === independentlyAccepted && artifact.accepted === true)).toBe(true);
  }
  const diagnostics = asArray(exported.diagnostics, "foreign-parent diagnostics");
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(diagnostics.every((diagnostic) => typeof diagnostic === "string")).toBe(true);
  assertNoPrivateValues(JSON.stringify(diagnostics));
}

async function restoreEventsAndDefinitions(state: JourneyState): Promise<void> {
  writeFileSync(state.eventsPath, state.originalEventsText, "utf8");
  writeFileSync(state.definitionsPath, state.originalDefinitionsText, "utf8");
  expect(readFileSync(state.eventsPath, "utf8")).toBe(state.originalEventsText);
  expect(readFileSync(state.definitionsPath, "utf8")).toBe(state.originalDefinitionsText);
}

function configureWorkflowAndNodes(fixture: GraphOpenCodeFixture, mode: ResourceMode, validatorLog: string): void {
  const workflow = readParallelWorkflow(fixture.project) as ReturnType<typeof readParallelWorkflow> & JsonRecord;
  workflow.nodes = [...nodeOrder];
  workflow.inputs = { goal: { contract: "request.v1" } };
  workflow.execution = {
    kind: "dag",
    maxConcurrency: 3,
    dependsOn: {
      prepare: [],
      audit: mode === "explicit-workspace" ? [] : ["left"],
      left: ["prepare"],
      right: ["prepare"],
      join: ["left", "right"],
    },
    resources: mode === "explicit-workspace"
      ? {
        prepare: [],
        audit: ["workspace"],
        left: [privateResourceKeys.shared, privateResourceKeys.left],
        right: [privateResourceKeys.shared, privateResourceKeys.right],
      }
      : {
        prepare: [],
        audit: [privateResourceKeys.audit],
        left: [privateResourceKeys.shared, privateResourceKeys.left],
        right: [privateResourceKeys.shared, privateResourceKeys.right],
      },
  };
  workflow.outputs = aliasOrder.map((alias) => ({ ...alias }));
  writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);

  const mappings: Record<string, Record<string, unknown>> = {
    prepare: { request: { from: "request", contract: "request.v1" } },
    audit: { request: { from: "caller.goal", contract: "request.v1" } },
    left: { report: { from: "prepare.report", contract: "report.v1" } },
    right: { report: { from: "prepare.report", contract: "report.v1" } },
    join: {
      left: { from: "left.report", contract: "report.v1" },
      right: { from: "right.report", contract: "report.v1" },
    },
  };
  for (const nodeId of nodeOrder) {
    const node = readProjectJson(fixture.project, `.nodulus/nodes/${nodeId}.json`) as JsonRecord;
    node.inputs = mappings[nodeId];
    if (nodeId !== "prepare") node.expectedOutputs = [{ name: "report", contract: "report.v1" }];
    writeJson(fixture.project, `.nodulus/nodes/${nodeId}.json`, node);
  }
  const validatorPath = path.join(fixture.project, ".nodulus", "validators", "prepare.mjs");
  writeFileSync(validatorPath, validatorSource(validatorLog), "utf8");
}

function fixtureConfigurations(): Parameters<typeof createGraphOpenCodeFixture>[0] {
  const raw = (text: string) => JSON.stringify({
    status: "success",
    artifacts: [{ name: "report", contract: "report.v1", data: { text } }],
  });
  return {
    prepare: { sessionId: "par041_prepare_session", buildRaw: raw("prepared"), repairRaw: [] },
    audit: { sessionId: "par041_audit_session", buildRaw: raw("audited"), repairRaw: [] },
    left: {
      sessionId: "par041_left_session",
      buildRaw: raw(""),
      repairRaw: [raw("left repaired")],
    },
    right: { sessionId: "par041_right_session", buildRaw: raw("right branch"), repairRaw: [] },
    join: { sessionId: "par041_join_session", buildRaw: raw("joined"), repairRaw: [] },
  };
}

function validatorSource(logPath: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    'let input = "";',
    'for await (const chunk of process.stdin) input += chunk;',
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ pid: process.pid, bytes: Buffer.byteLength(input, "utf8") }) + String.fromCharCode(10), "utf8");`,
    'process.stdout.write(JSON.stringify({ valid: true, errors: [] }));',
    "",
  ].join("\n");
}

function validatorLogPath(project: string): string {
  return path.join(project, ".nodulus", "fixtures", "par041-validator-runs.jsonl");
}

function observeProvider(actual: ProviderPort, counts: ProviderCounts): ProviderPort {
  return {
    isAvailable(profile, options) {
      counts.isAvailable += 1;
      return actual.isAvailable?.(profile, options) ?? true;
    },
    invoke(invocation) {
      counts.invoke += 1;
      return actual.invoke(invocation);
    },
    repairResponse(invocation, previousRawResponse, validationErrors) {
      counts.repairResponse += 1;
      if (!actual.repairResponse) return Promise.reject(new Error("Actual default OpenCode adapter has no repair method."));
      return actual.repairResponse(invocation, previousRawResponse, validationErrors);
    },
    usageForLastCall() {
      counts.usageForLastCall += 1;
      return actual.usageForLastCall?.() ?? null;
    },
    telemetryForCall(callId) {
      counts.telemetryForCall += 1;
      return actual.telemetryForCall?.(callId) ?? null;
    },
    launchForCall(callId) {
      counts.launchForCall += 1;
      return actual.launchForCall?.(callId) ?? null;
    },
  };
}

function captureAcceptedEvidence(fixture: GraphOpenCodeFixture, runDirectory: string, validatorBytes: string): AcceptedEvidence {
  const checkpoint = readCheckpoint(fixture.project, runIdFor(fixture));
  const graph = asRecord(checkpoint.graph, "captured checkpoint graph");
  const nodes = asRecord(graph.nodes, "captured checkpoint nodes");
  const byNode = new Map<string, JsonRecord>();
  for (const nodeId of nodeOrder) {
    const node = asRecord(nodes[nodeId], `captured node '${nodeId}'`);
    byNode.set(nodeId, asRecord(node.accepted, `captured acceptance '${nodeId}'`));
  }
  return {
    byNode,
    events: parseJsonLines(readFileSync(path.join(runDirectory, "events.jsonl"), "utf8"), "captured events"),
    runTree: snapshotTree(runDirectory),
    fixtureTree: snapshotTree(path.join(fixture.project, ".nodulus", "fixtures")),
    validatorBytes,
  };
}

function snapshotActivity(fixture: GraphOpenCodeFixture, providerCounts: ProviderCounts, validatorLog: string, native: ReturnType<typeof observeOwnedNativeProcesses>): ActivitySnapshot {
  return {
    calls: JSON.stringify(fixture.calls),
    operations: JSON.stringify(fixture.operations()),
    providerCounts: { ...providerCounts },
    validatorBytes: existsSync(validatorLog) ? readFileSync(validatorLog, "utf8") : "",
    native: JSON.stringify(native.diagnostics),
    nativeFailure: native.observationFailure,
  };
}

function snapshotTree(root: string): FileSnapshot {
  const output: FileSnapshot = [];
  let totalBytes = 0;
  const maxEntries = 2_048;
  const maxBytes = 8 * 1024 * 1024;
  const visit = (absolute: string, relative: string): void => {
    if (output.length >= maxEntries) throw new Error(`Snapshot entry limit exceeded at '${relative}'.`);
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) throw new Error(`Snapshot refuses symbolic link '${relative}'.`);
    if (stats.isDirectory()) {
      output.push({ relative, kind: "directory", size: 0 });
      for (const child of readdirSync(absolute).sort((left, right) => left.localeCompare(right))) {
        visit(path.join(absolute, child), relative ? path.join(relative, child) : child);
      }
      return;
    }
    if (!stats.isFile()) throw new Error(`Snapshot refuses unsupported filesystem entry '${relative}'.`);
    totalBytes += stats.size;
    if (totalBytes > maxBytes) throw new Error(`Snapshot byte limit exceeded at '${relative}'.`);
    const bytes = readFileSync(absolute);
    if (bytes.byteLength !== stats.size) throw new Error(`Snapshot observed an unstable file size at '${relative}'.`);
    output.push({ relative, kind: "file", size: stats.size, sha256: createHash("sha256").update(bytes).digest("hex") });
  };
  visit(root, "");
  return output;
}

function readCheckpoint(project: string, runId: string): JsonRecord {
  return parseJsonFile(path.join(project, ".nodulus", "runs", runId, "run.json"));
}

function nodePhase(checkpoint: JsonRecord, nodeId: string): unknown {
  const graph = asRecord(checkpoint.graph, "graph checkpoint");
  return asRecord(asRecord(graph.nodes, "graph nodes")[nodeId], `graph node '${nodeId}'`).phase;
}

function assertSavedHash(runDirectory: string, referenceValue: unknown, hashValue: unknown): void {
  if (typeof referenceValue !== "string" || typeof hashValue !== "string") throw new Error("Saved acceptance reference or hash is malformed.");
  const absolute = path.resolve(runDirectory, referenceValue);
  const relative = path.relative(runDirectory, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Acceptance reference escapes run directory: '${referenceValue}'.`);
  const bytes = readFileSync(absolute);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(hashValue);
}

function readProjectJson(project: string, relative: string): unknown {
  return JSON.parse(readFileSync(path.join(project, relative), "utf8")) as unknown;
}

function parseJsonFile(file: string): JsonRecord {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return asRecord(value, `JSON file '${file}'`);
}

function parseJsonLines(text: string, label: string): JsonRecord[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.map((line, index) => asRecord(JSON.parse(line) as unknown, `${label} line ${index + 1}`));
}

function writeEvents(file: string, events: JsonRecord[]): void {
  writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function runIdFor(fixture: GraphOpenCodeFixture): string {
  const first = fixture.calls[0];
  const runId = first?.checkpointAtEntry.runId;
  if (typeof runId !== "string") throw new Error("Actual provider invocation did not capture the run ID.");
  return runId;
}

async function releaseAndAccept(fixture: GraphOpenCodeFixture, settlement: Promise<RunSettlement>, pending: Set<Promise<void>>, nodeId: string, deadline: number): Promise<void> {
  await waitForStarted(fixture, settlement, pending, nodeId, "build", 1, deadline);
  fixture.release(nodeId, "build", 1);
  await waitForFinished(fixture, settlement, pending, nodeId, "build", 1, deadline);
  await waitForAccepted(fixture, settlement, pending, nodeId, deadline);
}

async function waitForStarted(fixture: GraphOpenCodeFixture, settlement: Promise<RunSettlement>, pending: Set<Promise<void>>, nodeId: string, operation: "build" | "repair", index: number, deadline: number): Promise<void> {
  await waitForMarker(fixture, settlement, pending, nodeId, operation, index, "started", deadline);
}

async function waitForFinished(fixture: GraphOpenCodeFixture, settlement: Promise<RunSettlement>, pending: Set<Promise<void>>, nodeId: string, operation: "build" | "repair", index: number, deadline: number): Promise<void> {
  await waitForMarker(fixture, settlement, pending, nodeId, operation, index, "finished", deadline);
}

async function waitForMarker(fixture: GraphOpenCodeFixture, settlement: Promise<RunSettlement>, pending: Set<Promise<void>>, nodeId: string, operation: "build" | "repair", index: number, kind: "started" | "finished", deadline: number): Promise<void> {
  const exists = () => kind === "started" ? fixture.hasStarted(nodeId, operation, index) : fixture.hasFinished(nodeId, operation, index);
  while (true) {
    if (exists()) return;
    const polling = trackPending(delay(Math.min(10, remainingMs(deadline, `${nodeId}/${operation} ${kind} marker`))), pending);
    const state = await Promise.race([
      polling.then(() => ({ kind: "pending" as const })),
      settlement.then((value) => ({ kind: "settled" as const, value })),
    ]);
    if (state.kind === "settled") {
      if (exists()) return;
      throw new Error(`Run settled before ${nodeId}/${operation} ${kind} marker: ${describeSettlement(state.value)}.`);
    }
  }
}

async function waitForAccepted(fixture: GraphOpenCodeFixture, settlement: Promise<RunSettlement>, pending: Set<Promise<void>>, nodeId: string, deadline: number): Promise<void> {
  while (true) {
    const checkpoint = readCheckpoint(fixture.project, runIdFor(fixture));
    if (nodePhase(checkpoint, nodeId) === "accepted") return;
    const polling = trackPending(delay(Math.min(20, remainingMs(deadline, `${nodeId} acceptance`))), pending);
    const state = await Promise.race([
      polling.then(() => ({ kind: "pending" as const })),
      settlement.then((value) => ({ kind: "settled" as const, value })),
    ]);
    if (state.kind === "settled") {
      const finalCheckpoint = readCheckpoint(fixture.project, runIdFor(fixture));
      if (nodePhase(finalCheckpoint, nodeId) === "accepted") return;
      throw new Error(`Run settled before '${nodeId}' was accepted: ${describeSettlement(state.value)}.`);
    }
  }
}

function trackPending(operation: Promise<void>, pending: Set<Promise<void>>): Promise<void> {
  let settled: Promise<void>;
  settled = operation.then(() => undefined, () => undefined).then(() => { pending.delete(settled); });
  pending.add(settled);
  return operation;
}

function trackRead<T>(operation: Promise<T>, state: JourneyState): Promise<T> {
  trackPending(operation.then(() => undefined, () => undefined), state.pendingWork);
  return operation;
}

async function withinDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  const remaining = remainingMs(deadline, label);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its fixed deadline.`)), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function remainingMs(deadline: number, label: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} exceeded its fixed deadline.`);
  return remaining;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object.`);
  return value as JsonRecord;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array.`);
  return value;
}

function assertNoPrivateValues(text: string, ...markers: string[]): void {
  const values = [callerMarker, requestMarker, privateProfileMarker, privatePathMarker, ...Object.values(privateResourceKeys), ...markers];
  for (const value of new Set(values)) {
    const serializedValue = JSON.stringify(value).slice(1, -1);
    expect(text).not.toContain(serializedValue);
  }
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? String(error.code) : "unknown";
    return `${code}: ${error.message.slice(0, 600)}`;
  }
  return "non-Error rejection";
}

function describeSettlement(settlement: RunSettlement): string {
  if (settlement.kind === "rejection") return errorSummary(settlement.error);
  if (settlement.result.status !== "error") return `result status ${settlement.result.status}`;
  const result = isJsonRecord(settlement.result.result) ? settlement.result.result : {};
  const error = isJsonRecord(result.error) ? result.error : {};
  const code = typeof error.code === "string" ? error.code.slice(0, 100) : "unknown";
  const nodeId = typeof error.nodeId === "string" ? error.nodeId.slice(0, 100) : "unknown";
  const message = typeof error.message === "string" ? error.message.slice(0, 500) : "no string error message";
  return `result status error (${code}, node ${nodeId}): ${message}`;
}

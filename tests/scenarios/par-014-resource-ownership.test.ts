import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { inspectWorkflow, runWorkflow, type ApplicationRunResult } from "../../src/index.js";
import { createGraphProcessProvider, type GraphProcessProviderFixture } from "../support/graph-process-provider.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";
import type { GraphProviderInvocationRecord } from "../support/graph-process-provider.js";

type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };

const testWatchdogMs = 30_000;
const validatorWatchdogMs = 10_000;
const validatorExitWatchdogMs = 12_000;
const graphValidatorSource = fileURLToPath(new URL("../fixtures/par-graph-validator.mjs", import.meta.url));
const graphValidatorRelative = ".nodulus/fixtures/par-graph-validator.mjs";

type ResourceNode = { id: string; inputs?: Record<string, unknown>; validator?: boolean };

function configureConstructorResourceGraph(project: string): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["constructor", "sibling"];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { constructor: [], sibling: [] };
  workflow.execution.resources = { sibling: ["disk"] };
  workflow.outputs = [
    { name: "constructorOutput", from: "constructor.report", contract: "report.v1" },
    { name: "siblingOutput", from: "sibling.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  for (const id of workflow.nodes) {
    const node = readProjectJson(project, `.nodulus/nodes/${id === "constructor" ? "audit" : "right"}.json`) as Record<string, unknown>;
    node.id = id;
    node.instructions = [`.nodulus/instructions/${id}.md`];
    node.inputs = { request: { from: "request", contract: "request.v1" } };
    node.expectedOutputs = [{ name: "report", contract: "report.v1" }];
    writeJson(project, `.nodulus/nodes/${id}.json`, node);
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
  }
}

function runRequest(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Verify workspace-default resource ownership." }],
  };
}

function startRun(project: string, fixture: GraphProcessProviderFixture): Promise<RunOutcome> {
  return runWorkflow(runRequest(project), fixture.provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

function describeOutcome(outcome: RunOutcome): string {
  if (outcome.kind === "rejection") return `run rejected: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;
  const error = (outcome.result.result as { error?: { code?: string; message?: string } } | undefined)?.error;
  return `run returned ${outcome.result.status}: ${error?.code ?? "no error code"} ${error?.message ?? ""}`.trim();
}

async function waitForConstructorOrSettled(fixture: GraphProcessProviderFixture, settled: Promise<RunOutcome>): Promise<void> {
  const controller = new AbortController();
  try {
    const observed = await Promise.race([
      fixture.waitForStarted(["constructor"], controller.signal).then(() => ({ kind: "started" as const })),
      settled.then((outcome) => ({ kind: "settled" as const, outcome })),
    ]);
    expect(observed.kind, observed.kind === "settled" ? describeOutcome(observed.outcome) : "").toBe("started");
  } finally {
    controller.abort();
  }
}

function assertOwnedProject(project: string): void {
  const absolute = path.resolve(project);
  const tempRoot = path.resolve(os.tmpdir());
  if (!absolute.startsWith(`${tempRoot}${path.sep}`) || !path.basename(absolute).startsWith("nodulus-par-014-resource-ownership-")) {
    throw new Error(`Refusing cleanup outside the generated P14A project: '${absolute}'.`);
  }
}

test("PAR-014 defaults an omitted constructor resource entry to the workspace wildcard", async () => {
  const project = createInitializedProject("par-014-resource-ownership");
  assertOwnedProject(project);
  configureParallelProject(project);
  configureConstructorResourceGraph(project);
  const inspection = await inspectWorkflow(project, "example");
  expect(inspection.workflow).toMatchObject({
    nodes: ["constructor", "sibling"],
    execution: {
      maxConcurrency: 2,
      dependsOn: { constructor: [], sibling: [] },
      resources: { sibling: ["disk"] },
    },
  });

  const fixture = createGraphProcessProvider(project, ["constructor", "sibling"]);
  const settled = startRun(project, fixture);
  let testError: unknown;
  try {
    await waitForConstructorOrSettled(fixture, settled);
    expect(fixture.hasStarted("sibling")).toBe(false);
    expect(fixture.activeNodeIds()).toEqual(["constructor"]);

    fixture.release("constructor");
    await fixture.waitForFinished(["constructor"]);
    await fixture.waitForStarted(["sibling"]);
    const siblingAdmission = fixture.invocations.find(({ nodeId }) => nodeId === "sibling");
    const entryGraph = siblingAdmission?.checkpointAtEntry.graph as { nodes?: Record<string, { phase?: unknown }> } | undefined;
    expect(entryGraph?.nodes?.constructor?.phase).toBe("accepted");
    expect(fixture.activeNodeIds()).toEqual(["sibling"]);

    fixture.release("sibling");
    await fixture.waitForFinished(["sibling"]);
    const outcome = await settled;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("success");
    expect(outcome.result.result).toEqual({ artifacts: [
      { name: "constructorOutput", contract: "report.v1", data: { text: "done:constructor" } },
      { name: "siblingOutput", contract: "report.v1", data: { text: "done:sibling" } },
    ] });
    expect(fixture.invocations.map(({ nodeId }) => nodeId)).toEqual(["constructor", "sibling"]);
    expect(new Set(fixture.invocations.map(({ callId }) => callId)).size).toBe(2);
    expect(fixture.peakActiveCalls()).toBe(1);
    expect(fixture.invocations.every(({ attempt }) => attempt === 1)).toBe(true);
  } catch (error) {
    testError = error;
  }

  const cleanupErrors: unknown[] = [];
  let processSafe = true;
  try { fixture.releaseAll(); }
  catch (error) { cleanupErrors.push(error); processSafe = false; }
  try { await settled; }
  catch (error) { cleanupErrors.push(error); processSafe = false; }
  try { await fixture.drain(); }
  catch (error) { cleanupErrors.push(error); processSafe = false; }
  if (processSafe) {
    try {
      assertOwnedProject(project);
      rmSync(project, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
  } else cleanupErrors.push(new Error(`P14A provider fixture did not drain safely; retaining '${project}'. ${fixture.diagnostics()}`));
  if (testError !== undefined && cleanupErrors.length > 0) throw new AggregateError([testError, ...cleanupErrors], "P14A assertion and cleanup both failed.");
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "P14A fixture cleanup failed.");
  if (testError !== undefined) throw testError;
}, testWatchdogMs);

function configureResourceGraph(
  project: string,
  nodes: ResourceNode[],
  dependsOn: Record<string, string[]>,
  maxConcurrency: number,
  resources?: Record<string, string[]>,
): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = nodes.map(({ id }) => id);
  workflow.execution.maxConcurrency = maxConcurrency;
  workflow.execution.dependsOn = dependsOn;
  if (resources === undefined) delete workflow.execution.resources;
  else workflow.execution.resources = resources;
  workflow.outputs = nodes.map(({ id }) => ({ name: `${id}Output`, from: `${id}.report`, contract: "report.v1" }));
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  for (const node of nodes) {
    writeJson(project, `.nodulus/nodes/${node.id}.json`, {
      schemaVersion: 1,
      id: node.id,
      providerProfile: "fixture",
      instructions: [`.nodulus/instructions/${node.id}.md`],
      inputs: node.inputs ?? { request: { from: "request", contract: "request.v1" } },
      expectedOutputs: [{
        name: "report",
        contract: "report.v1",
        ...(node.validator ? { validator: graphValidatorRelative, validatorTimeoutMs: 12_000 } : {}),
      }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${node.id}.md`), `Instructions for ${node.id}.\n`, "utf8");
  }
  if (nodes.some(({ validator }) => validator)) {
    const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
    const validatorStateDirectory = path.join(fixtureDirectory, "validator-process-state");
    mkdirSync(validatorStateDirectory, { recursive: true });
    copyFileSync(graphValidatorSource, path.join(project, graphValidatorRelative));
  }
}

function makeResourceScenario(label: string, nodes: ResourceNode[], dependsOn: Record<string, string[]>, maxConcurrency: number, resources?: Record<string, string[]>) {
  const project = createInitializedProject(`par-014-resource-${label}`);
  configureParallelProject(project);
  configureResourceGraph(project, nodes, dependsOn, maxConcurrency, resources);
  const fixture = createGraphProcessProvider(project, nodes.map(({ id }) => id));
  return { project, fixture, settled: runWorkflow(runRequest(project), fixture.provider).then(
    (result) => ({ kind: "result" as const, result }),
    (error: unknown) => ({ kind: "rejection" as const, error }),
  ) };
}

function expectedResourceAliases(nodeIds: string[]): Array<{ name: string; contract: string; data: { text: string } }> {
  return nodeIds.map((nodeId) => ({ name: `${nodeId}Output`, contract: "report.v1", data: { text: `done:${nodeId}` } }));
}

function readResourceCheckpoint(project: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, any>;
}

function resourceInvocation(fixture: GraphProcessProviderFixture, nodeId: string): GraphProviderInvocationRecord {
  const invocation = fixture.invocations.find((item) => item.nodeId === nodeId);
  if (!invocation) throw new Error(`Missing resource scenario invocation for '${nodeId}'. ${fixture.diagnostics()}`);
  return invocation;
}

function expectResourceSuccess(outcome: RunOutcome, fixture: GraphProcessProviderFixture, nodeIds: string[]): ApplicationRunResult {
  expect(outcome.kind).toBe("result");
  if (outcome.kind !== "result") throw outcome.error;
  expect(outcome.result.status).toBe("success");
  expect(outcome.result.result).toEqual({ artifacts: expectedResourceAliases(nodeIds) });
  expect(fixture.invocations).toHaveLength(nodeIds.length);
  expect(new Set(fixture.invocations.map(({ callId }) => callId)).size).toBe(nodeIds.length);
  expect(fixture.invocations.every(({ attempt }) => attempt === 1)).toBe(true);
  return outcome.result;
}

async function waitForFirstStarts(fixture: GraphProcessProviderFixture, nodeIds: string[], settled: Promise<RunOutcome>): Promise<void> {
  const controller = new AbortController();
  try {
    const observed = await Promise.race([
      fixture.waitForStarted(nodeIds, controller.signal).then(() => ({ kind: "started" as const })),
      settled.then((outcome) => ({ kind: "settled" as const, outcome })),
    ]);
    if (observed.kind === "settled") throw new Error(`Run settled before starting ${nodeIds.join(", ")}: ${describeOutcome(observed.outcome)}. ${fixture.diagnostics()}`);
  } finally { controller.abort(); }
}

async function waitForResourceNodePhase(project: string, runId: string, nodeId: string, phase: string, fixture: GraphProcessProviderFixture): Promise<void> {
  const deadline = Date.now() + validatorWatchdogMs;
  while (readResourceCheckpoint(project, runId).graph.nodes[nodeId]?.phase !== phase) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${nodeId} phase ${phase}. ${fixture.diagnostics()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function validatorStateDirectory(project: string): string {
  return path.join(project, ".nodulus", "fixtures", "validator-process-state");
}

async function waitForValidatorStarted(project: string, nodeId: string, fixture: GraphProcessProviderFixture): Promise<void> {
  const marker = path.join(validatorStateDirectory(project), `started-${nodeId}.json`);
  const deadline = Date.now() + validatorWatchdogMs;
  while (!existsSync(marker)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${nodeId} validator marker. ${fixture.diagnostics()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const record = JSON.parse(readFileSync(marker, "utf8")) as { nodeId?: unknown; pid?: unknown };
  if (record.nodeId !== nodeId || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new Error(`Validator marker for '${nodeId}' has an invalid process identity.`);
  }
}

function releaseValidators(project: string, nodeIds: string[]): void {
  for (const nodeId of nodeIds) writeFileSync(path.join(validatorStateDirectory(project), `release-${nodeId}`), "release\n", "utf8");
}

async function waitForValidatorProcessesExit(project: string, nodeIds: string[]): Promise<void> {
  const processes = nodeIds.flatMap((nodeId) => {
    const marker = path.join(validatorStateDirectory(project), `started-${nodeId}.json`);
    if (!existsSync(marker)) return [];
    const record = JSON.parse(readFileSync(marker, "utf8")) as { nodeId?: unknown; pid?: unknown };
    if (record.nodeId !== nodeId || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
      throw new Error(`Validator marker for '${nodeId}' has an invalid process identity; retaining its project.`);
    }
    return [{ nodeId, pid: record.pid }];
  });
  const deadline = Date.now() + validatorExitWatchdogMs;
  while (processes.some(({ pid }) => isProcessAlive(pid))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for validator PIDs ${JSON.stringify(processes)} to exit.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function withResourceFixture(
  project: string,
  fixture: GraphProcessProviderFixture,
  settled: Promise<RunOutcome>,
  validators: string[],
  body: () => Promise<void>,
): Promise<void> {
  let testError: unknown;
  try { await body(); }
  catch (error) { testError = error; }

  const cleanupErrors: unknown[] = [];
  let safeToRemove = true;
  try { fixture.releaseAll(); }
  catch (error) { cleanupErrors.push(error); safeToRemove = false; }
  try { releaseValidators(project, validators); }
  catch (error) { cleanupErrors.push(error); safeToRemove = false; }
  try { await settled; }
  catch (error) { cleanupErrors.push(error); safeToRemove = false; }
  try { await fixture.drain(); }
  catch (error) { cleanupErrors.push(error); safeToRemove = false; }
  try { await waitForValidatorProcessesExit(project, validators); }
  catch (error) { cleanupErrors.push(error); safeToRemove = false; }
  if (safeToRemove) {
    try {
      assertOwnedProject(project);
      rmSync(project, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
  } else cleanupErrors.push(new Error(`Resource fixture processes did not drain safely; retaining '${project}'. ${fixture.diagnostics()}`));

  if (testError !== undefined && cleanupErrors.length > 0) throw new AggregateError([testError, ...cleanupErrors], "Resource assertion and cleanup both failed.");
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Resource fixture cleanup failed.");
  if (testError !== undefined) throw testError;
}

async function assertSerialResourcePair(
  project: string,
  fixture: GraphProcessProviderFixture,
  settled: Promise<RunOutcome>,
  orderedNodes: [string, string],
): Promise<void> {
  const [first, second] = orderedNodes;
  await waitForFirstStarts(fixture, [first], settled);
  expect(fixture.hasStarted(second)).toBe(false);
  expect(fixture.activeNodeIds()).toEqual([first]);
  fixture.release(first);
  await fixture.waitForFinished([first]);
  await fixture.waitForStarted([second]);
  const secondAdmission = resourceInvocation(fixture, second);
  const secondEntry = secondAdmission.checkpointAtEntry.graph as { nodes?: Record<string, { phase?: unknown }> };
  expect(secondEntry.nodes?.[first]?.phase).toBe("accepted");
  expect(fixture.activeNodeIds()).toEqual([second]);
  expect(fixture.peakActiveCalls()).toBe(1);
  fixture.release(second);
  await fixture.waitForFinished([second]);
  expectResourceSuccess(await settled, fixture, orderedNodes);
  expect(fixture.invocations.map(({ nodeId }) => nodeId)).toEqual(orderedNodes);
  const state = readResourceCheckpoint(project, secondAdmission.runId);
  expect(state.completedNodes).toEqual(orderedNodes);
}

async function assertOverlappingResourcePair(fixture: GraphProcessProviderFixture, settled: Promise<RunOutcome>, nodeIds: [string, string]): Promise<void> {
  await waitForFirstStarts(fixture, nodeIds, settled);
  expect(fixture.activeNodeIds().sort()).toEqual([...nodeIds].sort());
  expect(fixture.peakActiveCalls()).toBe(2);
  fixture.release(nodeIds[0]);
  fixture.release(nodeIds[1]);
  await fixture.waitForFinished(nodeIds);
  expectResourceSuccess(await settled, fixture, nodeIds);
}

test("PAR-014 serializes roots when the whole resource map is omitted", async () => {
  const nodeIds: [string, string] = ["alpha", "beta"];
  const scenario = makeResourceScenario("ownership-whole-map-default", nodeIds.map((id) => ({ id })), { alpha: [], beta: [] }, 2);
  await withResourceFixture(scenario.project, scenario.fixture, scenario.settled, [], async () => {
    await assertSerialResourcePair(scenario.project, scenario.fixture, scenario.settled, nodeIds);
  });
}, testWatchdogMs);

test("PAR-014 workspace conflicts with a differently named resource", async () => {
  const nodeIds: [string, string] = ["workspaceOwner", "diskUser"];
  const scenario = makeResourceScenario("ownership-workspace-named", nodeIds.map((id) => ({ id })), { workspaceOwner: [], diskUser: [] }, 2, {
    workspaceOwner: ["workspace"],
    diskUser: ["disk"],
  });
  await withResourceFixture(scenario.project, scenario.fixture, scenario.settled, [], async () => {
    await assertSerialResourcePair(scenario.project, scenario.fixture, scenario.settled, nodeIds);
  });
}, testWatchdogMs);

test("PAR-014 workspace overlaps with an explicitly empty resource set", async () => {
  const nodeIds: [string, string] = ["workspaceOwner", "independent"];
  const scenario = makeResourceScenario("ownership-workspace-empty", nodeIds.map((id) => ({ id })), { workspaceOwner: [], independent: [] }, 2, {
    workspaceOwner: ["workspace"],
    independent: [],
  });
  await withResourceFixture(scenario.project, scenario.fixture, scenario.settled, [], async () => {
    await assertOverlappingResourcePair(scenario.fixture, scenario.settled, nodeIds);
  });
}, testWatchdogMs);

test("PAR-014 disjoint ordinary multi-key sets overlap", async () => {
  const nodeIds: [string, string] = ["holder", "other"];
  const scenario = makeResourceScenario("ownership-disjoint-sets", nodeIds.map((id) => ({ id })), { holder: [], other: [] }, 2, {
    holder: ["disk", "cache"],
    other: ["gpu", "network"],
  });
  await withResourceFixture(scenario.project, scenario.fixture, scenario.settled, [], async () => {
    await assertOverlappingResourcePair(scenario.fixture, scenario.settled, nodeIds);
  });
}, testWatchdogMs);

test("PAR-014 intersecting ordinary multi-key sets serialize through accepted publication", async () => {
  const nodeIds: [string, string] = ["alpha", "beta"];
  const scenario = makeResourceScenario("ownership-intersecting-sets", nodeIds.map((id) => ({ id })), { alpha: [], beta: [] }, 2, {
    alpha: ["disk", "cache"],
    beta: ["cache", "gpu"],
  });
  await withResourceFixture(scenario.project, scenario.fixture, scenario.settled, [], async () => {
    await assertSerialResourcePair(scenario.project, scenario.fixture, scenario.settled, nodeIds);
  });
}, testWatchdogMs);

test("PAR-014 skips an atomically blocked key set without taking a slot or a partial reservation", async () => {
  const nodeIds = ["holder", "blocked", "independent", "other", "afterHolder"];
  const scenario = makeResourceScenario("ownership-atomic-skip", [
    { id: "holder" },
    { id: "blocked" },
    { id: "independent" },
    { id: "other" },
    { id: "afterHolder", inputs: { prior: { from: "holder.report", contract: "report.v1" } } },
  ], { holder: [], blocked: [], independent: [], other: [], afterHolder: ["holder"] }, 3, {
    holder: ["a"], blocked: ["a", "b"], independent: ["b"], other: ["c"], afterHolder: ["a"],
  });
  await withResourceFixture(scenario.project, scenario.fixture, scenario.settled, [], async () => {
    await waitForFirstStarts(scenario.fixture, ["holder", "independent", "other"], scenario.settled);
    expect(scenario.fixture.hasStarted("blocked")).toBe(false);
    expect(scenario.fixture.activeNodeIds().sort()).toEqual(["holder", "independent", "other"]);
    expect(scenario.fixture.peakActiveCalls()).toBe(3);
    const runId = resourceInvocation(scenario.fixture, "holder").runId;

    scenario.fixture.release("holder");
    await scenario.fixture.waitForFinished(["holder"]);
    await scenario.fixture.waitForStarted(["afterHolder"]);
    const afterHolder = resourceInvocation(scenario.fixture, "afterHolder");
    const afterEntry = afterHolder.checkpointAtEntry.graph as { nodes?: Record<string, { phase?: unknown }> };
    expect(afterEntry.nodes?.holder?.phase).toBe("accepted");
    expect(afterEntry.nodes?.independent?.phase).toBe("active");
    expect(scenario.fixture.hasStarted("blocked")).toBe(false);
    expect(scenario.fixture.activeNodeIds().sort()).toEqual(["afterHolder", "independent", "other"]);

    scenario.fixture.release("afterHolder");
    await scenario.fixture.waitForFinished(["afterHolder"]);
    await waitForResourceNodePhase(scenario.project, runId, "afterHolder", "accepted", scenario.fixture);
    expect(scenario.fixture.hasStarted("blocked")).toBe(false);

    scenario.fixture.release("independent");
    await scenario.fixture.waitForFinished(["independent"]);
    await scenario.fixture.waitForStarted(["blocked"]);
    const blockedEntry = resourceInvocation(scenario.fixture, "blocked").checkpointAtEntry.graph as { nodes?: Record<string, { phase?: unknown }> };
    expect(blockedEntry.nodes?.holder?.phase).toBe("accepted");
    expect(blockedEntry.nodes?.afterHolder?.phase).toBe("accepted");
    expect(blockedEntry.nodes?.independent?.phase).toBe("accepted");
    expect(scenario.fixture.peakActiveCalls()).toBeLessThanOrEqual(3);

    scenario.fixture.release("blocked");
    scenario.fixture.release("other");
    await scenario.fixture.waitForFinished(["blocked", "other"]);
    const result = expectResourceSuccess(await scenario.settled, scenario.fixture, nodeIds);
    expect(readResourceCheckpoint(scenario.project, result.runId).completedNodes).toEqual(nodeIds);
  });
}, testWatchdogMs);

async function waitForValidatorDone(project: string, nodeId: string, fixture: GraphProcessProviderFixture): Promise<void> {
  const marker = path.join(validatorStateDirectory(project), `finished-${nodeId}.json`);
  const deadline = Date.now() + validatorWatchdogMs;
  while (!existsSync(marker)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${nodeId} validator completion. ${fixture.diagnostics()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("PAR-014 holds resource ownership through real executable validation", async () => {
  const nodeIds = ["owner", "blocked", "independent", "observer"];
  const scenario = makeResourceScenario("ownership-validator", [
    { id: "owner", validator: true },
    { id: "blocked" },
    { id: "independent" },
    { id: "observer" },
  ], { owner: [], blocked: [], independent: [], observer: [] }, 2, {
    owner: ["disk"], blocked: ["disk"], independent: [], observer: [],
  });
  await withResourceFixture(scenario.project, scenario.fixture, scenario.settled, ["owner"], async () => {
    await waitForFirstStarts(scenario.fixture, ["owner", "independent"], scenario.settled);
    scenario.fixture.release("owner");
    await scenario.fixture.waitForFinished(["owner"]);
    await waitForValidatorStarted(scenario.project, "owner", scenario.fixture);
    const runId = resourceInvocation(scenario.fixture, "owner").runId;
    expect(readResourceCheckpoint(scenario.project, runId).graph.nodes.owner.phase).toBe("active");
    expect(scenario.fixture.hasStarted("blocked")).toBe(false);

    scenario.fixture.release("independent");
    await scenario.fixture.waitForFinished(["independent"]);
    await scenario.fixture.waitForStarted(["observer"]);
    const observerEntry = resourceInvocation(scenario.fixture, "observer").checkpointAtEntry.graph as { nodes?: Record<string, { phase?: unknown }> };
    expect(observerEntry.nodes?.owner?.phase).toBe("active");
    expect(observerEntry.nodes?.independent?.phase).toBe("accepted");
    expect(observerEntry.nodes?.blocked?.phase).toBe("not_started");
    expect(existsSync(path.join(validatorStateDirectory(scenario.project), "finished-owner.json"))).toBe(false);
    expect(scenario.fixture.hasStarted("blocked")).toBe(false);

    scenario.fixture.release("observer");
    await scenario.fixture.waitForFinished(["observer"]);
    await waitForResourceNodePhase(scenario.project, runId, "observer", "accepted", scenario.fixture);
    expect(scenario.fixture.hasStarted("blocked")).toBe(false);

    releaseValidators(scenario.project, ["owner"]);
    await waitForValidatorDone(scenario.project, "owner", scenario.fixture);
    await scenario.fixture.waitForStarted(["blocked"]);
    const blockedEntry = resourceInvocation(scenario.fixture, "blocked").checkpointAtEntry.graph as { nodes?: Record<string, { phase?: unknown }> };
    expect(blockedEntry.nodes?.owner?.phase).toBe("accepted");
    expect(readResourceCheckpoint(scenario.project, runId).graph.nodes.owner.phase).toBe("accepted");
    scenario.fixture.release("blocked");
    await scenario.fixture.waitForFinished(["blocked"]);

    const result = expectResourceSuccess(await scenario.settled, scenario.fixture, nodeIds);
    expect(readResourceCheckpoint(scenario.project, result.runId).completedNodes).toEqual(nodeIds);
  });
}, testWatchdogMs);

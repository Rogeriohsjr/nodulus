import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runWorkflow, type ApplicationRunResult } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { createGraphProcessProvider, type GraphProcessProviderFixture } from "../support/graph-process-provider.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { writeJson } from "../support/workflow-sequence.js";

type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };
type TestNode = { id: string; inputs: Record<string, unknown>; validator?: boolean };
type EntrySnapshot = { graph: { nodes: Record<string, { phase: string }> } };

const validatorSource = fileURLToPath(new URL("../fixtures/par-graph-validator.mjs", import.meta.url));
const validatorRelative = ".nodulus/fixtures/par-graph-validator.mjs";
const testWatchdogMs = 30_000;
const markerWatchdogMs = 10_000;

function configureGraph(
  project: string,
  nodes: TestNode[],
  dependsOn: Record<string, string[]>,
  maxConcurrency: number,
): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = nodes.map(({ id }) => id);
  workflow.execution.maxConcurrency = maxConcurrency;
  workflow.execution.dependsOn = dependsOn;
  workflow.execution.resources = Object.fromEntries(nodes.map(({ id }) => [id, []]));
  workflow.outputs = nodes.map(({ id }) => ({ name: `${id}Output`, from: `${id}.report`, contract: "report.v1" }));
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  for (const node of nodes) {
    writeJson(project, `.nodulus/nodes/${node.id}.json`, {
      schemaVersion: 1,
      id: node.id,
      providerProfile: "fixture",
      instructions: [`.nodulus/instructions/${node.id}.md`],
      inputs: node.inputs,
      expectedOutputs: [{ name: "report", contract: "report.v1", ...(node.validator ? { validator: validatorRelative, validatorTimeoutMs: 12_000 } : {}) }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${node.id}.md`), `Instructions for ${node.id}.\n`, "utf8");
  }
  const validatorDirectory = path.join(project, path.dirname(validatorRelative));
  mkdirSync(validatorDirectory, { recursive: true });
  copyFileSync(validatorSource, path.join(project, validatorRelative));
  mkdirSync(path.join(validatorDirectory, "validator-process-state"), { recursive: true });
}

function request(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Run the graph validation fixture." }],
  };
}

function startRun(project: string, fixture: GraphProcessProviderFixture): Promise<RunOutcome> {
  return runWorkflow(request(project), fixture.provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

function readCheckpoint(project: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, any>;
}

function validatorStateDirectory(project: string): string {
  return path.join(project, ".nodulus", "fixtures", "validator-process-state");
}

async function waitForValidatorMarker(
  project: string,
  nodeId: string,
  marker: "started" | "finished",
  provider: GraphProcessProviderFixture,
): Promise<void> {
  const markerPath = path.join(validatorStateDirectory(project), `${marker}-${nodeId}.json`);
  const deadline = Date.now() + markerWatchdogMs;
  while (!existsSync(markerPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${marker} validator marker for ${nodeId}. Validator markers: ${JSON.stringify(readValidatorMarkers(project))}. ${provider.diagnostics()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForNodePhase(
  project: string,
  runId: string,
  nodeId: string,
  phase: string,
  provider: GraphProcessProviderFixture,
): Promise<void> {
  const deadline = Date.now() + markerWatchdogMs;
  while (readCheckpoint(project, runId).graph.nodes[nodeId]?.phase !== phase) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for node '${nodeId}' phase '${phase}'. ${provider.diagnostics()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function readValidatorMarkers(project: string): { started: string[]; finished: string[]; readError?: string } {
  const directory = validatorStateDirectory(project);
  try {
    const entries = requireDirectoryEntries(directory);
    return {
      started: entries.filter((entry) => entry.startsWith("started-")).map((entry) => entry.slice("started-".length, -".json".length)),
      finished: entries.filter((entry) => entry.startsWith("finished-")).map((entry) => entry.slice("finished-".length, -".json".length)),
    };
  } catch (error) {
    return { started: [], finished: [], readError: error instanceof Error ? error.message : String(error) };
  }
}

function requireDirectoryEntries(directory: string): string[] {
  // Use the real fixture directory to make timeout diagnostics useful on Windows too.
  return readdirSync(directory);
}

function releaseValidator(project: string, nodeId: string): void {
  writeFileSync(path.join(validatorStateDirectory(project), `release-${nodeId}`), "release\n", "utf8");
}

function releaseAllValidators(project: string, nodeIds: string[]): void {
  for (const nodeId of nodeIds) releaseValidator(project, nodeId);
}

async function waitForValidatorProcessesExit(project: string, nodeIds: string[], provider: GraphProcessProviderFixture): Promise<void> {
  const processes = nodeIds.flatMap((nodeId) => {
    const marker = path.join(validatorStateDirectory(project), `started-${nodeId}.json`);
    if (!existsSync(marker)) return [];
    try {
      const value = JSON.parse(readFileSync(marker, "utf8")) as { pid?: unknown };
      if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
        throw new Error(`Validator started marker '${marker}' has an invalid process ID.`);
      }
      return [{ nodeId, pid: value.pid }];
    } catch (error) {
      throw new Error(`Could not safely read validator process identity from '${marker}': ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const deadline = Date.now() + 12_000;
  while (processes.some(({ pid }) => isProcessAlive(pid))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for validator processes to exit: ${JSON.stringify(processes)}. ${provider.diagnostics()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function logNonSuccessOutcome(scenario: string, outcome: RunOutcome): void {
  if (outcome.kind === "rejection") {
    process.stderr.write(`[${scenario}] workflow rejected: ${String(outcome.error)}\n`);
  } else if (outcome.result.status !== "success") {
    process.stderr.write(`[${scenario}] workflow ${outcome.result.status}: ${JSON.stringify(outcome.result.result)}\n`);
  }
}

function invocation(fixture: GraphProcessProviderFixture, nodeId: string) {
  const record = fixture.invocations.find((item) => item.nodeId === nodeId);
  if (!record) throw new Error(`Missing provider invocation record for '${nodeId}'. ${fixture.diagnostics()}`);
  return record;
}

function expectSuccess(outcome: RunOutcome, nodeIds: string[]): ApplicationRunResult {
  expect(outcome.kind).toBe("result");
  if (outcome.kind !== "result") throw outcome.error;
  expect(outcome.result.status).toBe("success");
  expect(outcome.result.result).toMatchObject({
    artifacts: nodeIds.map((nodeId) => ({ name: `${nodeId}Output`, contract: "report.v1", data: { text: `done:${nodeId}` } })),
  });
  return outcome.result;
}

function expectNodeAccepted(project: string, runId: string, fixture: GraphProcessProviderFixture, nodeId: string): void {
  const state = readCheckpoint(project, runId);
  const record = invocation(fixture, nodeId);
  expect(state.graph.nodes[nodeId]).toMatchObject({ phase: "accepted", attempt: 1, accepted: { callId: record.callId } });
  expect(state.completedNodes).toContain(nodeId);
}

test("PAR-011 concurrency one holds its slot through executable validation", async () => {
  const project = createInitializedProject("par-011 validation slot one café");
  configureParallelProject(project);
  const nodes: TestNode[] = [
    { id: "alpha", inputs: { request: { from: "request", contract: "request.v1" } }, validator: true },
    { id: "beta", inputs: { request: { from: "request", contract: "request.v1" } } },
  ];
  configureGraph(project, nodes, { alpha: [], beta: [] }, 1);
  const fixture = createGraphProcessProvider(project, nodes.map(({ id }) => id));
  const settled = startRun(project, fixture);
  try {
    await fixture.waitForStarted(["alpha"]);
    fixture.release("alpha");
    await fixture.waitForFinished(["alpha"]);
    await waitForValidatorMarker(project, "alpha", "started", fixture);
    const runId = invocation(fixture, "alpha").runId;
    const validating = readCheckpoint(project, runId);
    expect(validating.graph.nodes.alpha.phase).toBe("active");
    expect(validating.graph.nodes.beta.phase).toBe("not_started");
    expect(fixture.hasStarted("beta")).toBe(false);

    releaseValidator(project, "alpha");
    await waitForValidatorMarker(project, "alpha", "finished", fixture);
    await fixture.waitForStarted(["beta"]);
    const betaAtEntry = invocation(fixture, "beta").checkpointAtEntry as EntrySnapshot;
    expect(betaAtEntry.graph.nodes.alpha.phase).toBe("accepted");
    expect(fixture.invocations.find(({ nodeId }) => nodeId === "beta")?.inputs).toEqual({ request: "Run the graph validation fixture." });
    expect(fixture.peakActiveCalls()).toBe(1);
    expectNodeAccepted(project, runId, fixture, "alpha");

    fixture.release("beta");
    await fixture.waitForFinished(["beta"]);
    const result = expectSuccess(await settled, ["alpha", "beta"]);
    expectNodeAccepted(project, result.runId, fixture, "beta");
    expect(new Set(fixture.invocations.map(({ callId }) => callId)).size).toBe(2);
  } finally {
    fixture.releaseAll();
    releaseAllValidators(project, ["alpha"]);
    try {
      logNonSuccessOutcome("PAR-011 concurrency-one", await settled);
      await fixture.drain();
    } finally {
      await waitForValidatorProcessesExit(project, ["alpha"], fixture);
      rmSync(project, { recursive: true, force: true });
    }
  }
}, testWatchdogMs);

test("PAR-011 progresses an independent chain while another node validates", async () => {
  const project = createInitializedProject("par-011 parallel validation slot café");
  configureParallelProject(project);
  const nodes: TestNode[] = [
    { id: "afterSlow", inputs: { slow: { from: "slow.report", contract: "report.v1" } } },
    { id: "otherSuccessor", inputs: { independent: { from: "independent.report", contract: "report.v1" } } },
    { id: "slow", inputs: { request: { from: "request", contract: "request.v1" } }, validator: true },
    { id: "independent", inputs: { request: { from: "request", contract: "request.v1" } } },
  ];
  configureGraph(project, nodes, {
    afterSlow: ["slow"],
    otherSuccessor: ["independent"],
    slow: [],
    independent: [],
  }, 2);
  const fixture = createGraphProcessProvider(project, nodes.map(({ id }) => id));
  const settled = startRun(project, fixture);
  try {
    await fixture.waitForStarted(["slow", "independent"]);
    fixture.release("slow");
    await fixture.waitForFinished(["slow"]);
    await waitForValidatorMarker(project, "slow", "started", fixture);
    const runId = invocation(fixture, "slow").runId;
    expect(readCheckpoint(project, runId).graph.nodes.slow.phase).toBe("active");

    fixture.release("independent");
    await fixture.waitForFinished(["independent"]);
    await fixture.waitForStarted(["otherSuccessor"]);
    const successorInvocation = invocation(fixture, "otherSuccessor");
    const successorEntry = successorInvocation.checkpointAtEntry as EntrySnapshot;
    expect(successorEntry.graph.nodes.independent.phase).toBe("accepted");
    expect(successorEntry.graph.nodes.slow.phase).toBe("active");
    expect(successorInvocation.inputs).toEqual({ independent: { text: "done:independent" } });
    expect(fixture.hasStarted("afterSlow")).toBe(false);

    fixture.release("otherSuccessor");
    await fixture.waitForFinished(["otherSuccessor"]);
    await waitForNodePhase(project, runId, "otherSuccessor", "accepted", fixture);
    expectNodeAccepted(project, runId, fixture, "otherSuccessor");
    expect(fixture.hasStarted("afterSlow")).toBe(false);
    expect(readCheckpoint(project, runId).graph.nodes.slow.phase).toBe("active");

    releaseValidator(project, "slow");
    await waitForValidatorMarker(project, "slow", "finished", fixture);
    await fixture.waitForStarted(["afterSlow"]);
    const afterSlowInvocation = invocation(fixture, "afterSlow");
    const afterSlowEntry = afterSlowInvocation.checkpointAtEntry as EntrySnapshot;
    expect(afterSlowEntry.graph.nodes.slow.phase).toBe("accepted");
    expect(afterSlowInvocation.inputs).toEqual({ slow: { text: "done:slow" } });
    expectNodeAccepted(project, runId, fixture, "slow");

    fixture.release("afterSlow");
    await fixture.waitForFinished(["afterSlow"]);
    const result = expectSuccess(await settled, ["afterSlow", "otherSuccessor", "slow", "independent"]);
    for (const node of nodes) expectNodeAccepted(project, result.runId, fixture, node.id);
    expect(fixture.peakActiveCalls()).toBe(2);
  } finally {
    fixture.releaseAll();
    releaseAllValidators(project, ["slow"]);
    try {
      logNonSuccessOutcome("PAR-011 independent-chain", await settled);
      await fixture.drain();
    } finally {
      await waitForValidatorProcessesExit(project, ["slow"], fixture);
      rmSync(project, { recursive: true, force: true });
    }
  }
}, testWatchdogMs);

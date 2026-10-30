import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ApplicationRunResult } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { createGraphProcessProvider, type GraphProcessProviderFixture } from "../support/graph-process-provider.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { writeJson } from "../support/workflow-sequence.js";

type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };
type GraphNode = { id: string; inputs: Record<string, unknown> };
type CheckpointSnapshot = { graph: { nodes: Record<string, { phase: string }> } };

const testWatchdogMs = 30_000;

function configureSchedulingGraph(
  project: string,
  nodes: GraphNode[],
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
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${node.id}.md`), `Instructions for ${node.id}.\n`, "utf8");
  }
}

function request(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Run the graph fixture." }],
  };
}

function startRun(project: string, fixture: GraphProcessProviderFixture): Promise<RunOutcome> {
  return runWorkflow(request(project), fixture.provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

async function requireStartedBeforeRunSettles(
  fixture: GraphProcessProviderFixture,
  nodeIds: string[],
  settled: Promise<RunOutcome>,
): Promise<void> {
  const controller = new AbortController();
  try {
    const observed = await Promise.race([
      fixture.waitForStarted(nodeIds, controller.signal).then(() => ({ kind: "started" as const })),
      settled.then((outcome) => ({ kind: "settled" as const, outcome })),
    ]);
    if (observed.kind === "settled") {
      const detail = observed.outcome.kind === "result"
        ? `returned ${observed.outcome.result.status}: ${JSON.stringify(observed.outcome.result.result)}`
        : `rejected: ${String(observed.outcome.error)}`;
      throw new Error(`Schema-2 graph run settled before child start markers (${nodeIds.join(", ")}): ${detail}`);
    }
  } finally {
    controller.abort();
  }
}

function logNonSuccessOutcome(scenario: string, outcome: RunOutcome): void {
  if (outcome.kind === "rejection") {
    process.stderr.write(`[${scenario}] workflow rejected: ${String(outcome.error)}\n`);
  } else if (outcome.result.status !== "success") {
    process.stderr.write(`[${scenario}] workflow ${outcome.result.status}: ${JSON.stringify(outcome.result.result)}\n`);
  }
}

function readCheckpoint(project: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, any>;
}

function expectAcceptedCheckpoint(project: string, fixture: GraphProcessProviderFixture, result: ApplicationRunResult, nodeIds: string[]): void {
  const state = readCheckpoint(project, result.runId);
  expect(state.schemaVersion).toBe(2);
  expect(state.graph.nodes).toEqual(expect.objectContaining(
    Object.fromEntries(nodeIds.map((nodeId) => [nodeId, expect.objectContaining({ phase: "accepted", attempt: 1 })])),
  ));
  expect(state.completedNodes).toEqual(nodeIds);
  for (const nodeId of nodeIds) {
    const record = state.graph.nodes[nodeId];
    const invocation = fixture.invocations.find((item) => item.nodeId === nodeId);
    expect(invocation).toBeDefined();
    expect(record.accepted.callId).toBe(invocation?.callId);
    expect(existsSync(path.join(project, ".nodulus", "runs", result.runId, "calls", invocation?.callId ?? "", "request.json"))).toBe(true);
    expect(existsSync(path.join(project, ".nodulus", "runs", result.runId, "calls", invocation?.callId ?? "", "stdin.txt"))).toBe(true);
    expect(existsSync(path.join(project, ".nodulus", "runs", result.runId, "calls", invocation?.callId ?? "", "transport.json"))).toBe(true);
    expect(existsSync(path.join(project, ".nodulus", "runs", result.runId, "nodes", nodeId, "attempt-001", "invocation.json"))).toBe(true);
    expect(fixture.hasFinished(nodeId)).toBe(true);
  }
  expect(new Set(fixture.invocations.map(({ callId }) => callId)).size).toBe(nodeIds.length);
  expect(fixture.peakActiveCalls()).toBeGreaterThan(0);
}

function expectedAliases(nodeIds: string[]): Array<{ name: string; contract: string; data: { text: string } }> {
  return nodeIds.map((nodeId) => ({ name: `${nodeId}Output`, contract: "report.v1", data: { text: `done:${nodeId}` } }));
}

test("PAR-010 overlaps at most two ready process-backed nodes and preserves declared output order", async () => {
  const project = createInitializedProject("par-010 max concurrency two café");
  configureParallelProject(project);
  const nodes = ["alpha", "beta", "gamma"].map((id) => ({ id, inputs: { request: { from: "request", contract: "request.v1" } } }));
  configureSchedulingGraph(project, nodes, { alpha: [], beta: [], gamma: [] }, 2);
  const fixture = createGraphProcessProvider(project, ["alpha", "beta", "gamma"]);
  const settled = startRun(project, fixture);
  try {
    await requireStartedBeforeRunSettles(fixture, ["alpha", "beta"], settled);
    expect(fixture.hasStarted("gamma")).toBe(false);
    expect(fixture.activeNodeIds().sort()).toEqual(["alpha", "beta"]);
    expect(fixture.peakActiveCalls()).toBe(2);
    const runId = fixture.invocations[0]?.runId;
    expect(runId).toBeDefined();
    const initial = readCheckpoint(project, runId as string);
    expect(initial.graph.nodes).toEqual(expect.objectContaining({
      alpha: expect.objectContaining({ phase: "active", attempt: 1 }),
      beta: expect.objectContaining({ phase: "active", attempt: 1 }),
      gamma: expect.objectContaining({ phase: "not_started", attempt: 0 }),
    }));

    fixture.release("beta");
    await fixture.waitForFinished(["beta"]);
    await fixture.waitForStarted(["gamma"]);
    const afterSlotRelease = readCheckpoint(project, runId as string);
    expect(afterSlotRelease.graph.nodes.beta.phase).toBe("accepted");
    expect(afterSlotRelease.graph.nodes.gamma.phase).toBe("active");
    const gammaAdmission = fixture.invocations.find(({ nodeId }) => nodeId === "gamma")?.checkpointAtEntry as CheckpointSnapshot | undefined;
    expect(gammaAdmission?.graph.nodes.beta.phase).toBe("accepted");
    expect(gammaAdmission?.graph.nodes.gamma.phase).toBe("active");
    expect(fixture.activeNodeIds().sort()).toEqual(["alpha", "gamma"]);
    expect(fixture.peakActiveCalls()).toBeLessThanOrEqual(2);

    fixture.release("gamma");
    await fixture.waitForFinished(["gamma"]);
    fixture.release("alpha");
    const outcome = await settled;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("success");
    expect(outcome.result.result).toMatchObject({ artifacts: expectedAliases(["alpha", "beta", "gamma"]) });
    expectAcceptedCheckpoint(project, fixture, outcome.result, ["alpha", "beta", "gamma"]);
  } finally {
    fixture.releaseAll();
    try {
      logNonSuccessOutcome("PAR-010 concurrency-two", await settled);
      await fixture.drain();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
}, testWatchdogMs);

test("PAR-010 maxConcurrency one admits each ready node only after the previous acceptance", async () => {
  const project = createInitializedProject("par-010 max concurrency one café");
  configureParallelProject(project);
  const nodes = ["alpha", "beta", "gamma"].map((id) => ({ id, inputs: { request: { from: "request", contract: "request.v1" } } }));
  configureSchedulingGraph(project, nodes, { alpha: [], beta: [], gamma: [] }, 1);
  const fixture = createGraphProcessProvider(project, ["alpha", "beta", "gamma"]);
  const settled = startRun(project, fixture);
  try {
    await requireStartedBeforeRunSettles(fixture, ["alpha"], settled);
    expect(fixture.hasStarted("beta")).toBe(false);
    expect(fixture.hasStarted("gamma")).toBe(false);
    const runId = fixture.invocations[0]?.runId;
    expect(runId).toBeDefined();
    for (const [index, nodeId] of ["alpha", "beta", "gamma"].entries()) {
      await fixture.waitForStarted([nodeId]);
      expect(fixture.activeNodeIds()).toEqual([nodeId]);
      expect(fixture.peakActiveCalls()).toBe(1);
      fixture.release(nodeId);
      await fixture.waitForFinished([nodeId]);
      if (index < 2) {
        const nextNode = ["beta", "gamma"][index];
        if (nextNode === undefined) throw new Error("Expected a next graph node.");
        await fixture.waitForStarted([nextNode]);
        const state = readCheckpoint(project, runId as string);
        expect(state.graph.nodes[nodeId].phase).toBe("accepted");
        expect(fixture.activeNodeIds()).toEqual([nextNode]);
      }
    }
    const outcome = await settled;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("success");
    expect(outcome.result.result).toMatchObject({ artifacts: expectedAliases(["alpha", "beta", "gamma"]) });
    expectAcceptedCheckpoint(project, fixture, outcome.result, ["alpha", "beta", "gamma"]);
  } finally {
    fixture.releaseAll();
    try {
      logNonSuccessOutcome("PAR-010 concurrency-one", await settled);
      await fixture.drain();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
}, testWatchdogMs);

test("PAR-011 accepts ancestors before launching a non-topologically declared successor", async () => {
  const project = createInitializedProject("par-010 non-topological chain café");
  configureParallelProject(project);
  const nodes = [
    { id: "successor", inputs: { prepared: { from: "middle.report", contract: "report.v1" } } },
    { id: "middle", inputs: { source: { from: "source.report", contract: "report.v1" } } },
    { id: "source", inputs: { request: { from: "request", contract: "request.v1" } } },
  ];
  configureSchedulingGraph(project, nodes, { successor: ["middle"], middle: ["source"], source: [] }, 2);
  const fixture = createGraphProcessProvider(project, ["successor", "middle", "source"]);
  const settled = startRun(project, fixture);
  try {
    await requireStartedBeforeRunSettles(fixture, ["source"], settled);
    expect(fixture.hasStarted("middle")).toBe(false);
    expect(fixture.hasStarted("successor")).toBe(false);
    const runId = fixture.invocations[0]?.runId;
    expect(runId).toBeDefined();
    expect(fixture.invocations[0]?.inputs).toEqual({ request: "Run the graph fixture." });

    fixture.release("source");
    await fixture.waitForFinished(["source"]);
    await fixture.waitForStarted(["middle"]);
    expect(readCheckpoint(project, runId as string).graph.nodes.source.phase).toBe("accepted");
    const middleAdmission = fixture.invocations.find(({ nodeId }) => nodeId === "middle")?.checkpointAtEntry as CheckpointSnapshot | undefined;
    expect(middleAdmission?.graph.nodes.source.phase).toBe("accepted");
    expect(fixture.hasStarted("successor")).toBe(false);
    expect(fixture.invocations.find(({ nodeId }) => nodeId === "middle")?.inputs).toEqual({ source: { text: "done:source" } });

    fixture.release("middle");
    await fixture.waitForFinished(["middle"]);
    await fixture.waitForStarted(["successor"]);
    expect(readCheckpoint(project, runId as string).graph.nodes.middle.phase).toBe("accepted");
    const successorAdmission = fixture.invocations.find(({ nodeId }) => nodeId === "successor")?.checkpointAtEntry as CheckpointSnapshot | undefined;
    expect(successorAdmission?.graph.nodes.middle.phase).toBe("accepted");
    expect(fixture.invocations.find(({ nodeId }) => nodeId === "successor")?.inputs).toEqual({ prepared: { text: "done:middle" } });

    fixture.release("successor");
    const outcome = await settled;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("success");
    expect(outcome.result.result).toMatchObject({ artifacts: expectedAliases(["successor", "middle", "source"]) });
    expectAcceptedCheckpoint(project, fixture, outcome.result, ["successor", "middle", "source"]);
  } finally {
    fixture.releaseAll();
    try {
      logNonSuccessOutcome("PAR-011 non-topological-chain", await settled);
      await fixture.drain();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
}, testWatchdogMs);

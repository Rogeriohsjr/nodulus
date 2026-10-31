import { createHash } from "node:crypto";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ApplicationRunResult, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { createGraphProcessProvider, type GraphProcessProviderFixture } from "../support/graph-process-provider.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };
type AcceptedArtifact = { name: string; contract: string; ref: string; sha256: string };
type AcceptedRecord = { attempt: number; callId: string; artifacts: AcceptedArtifact[] };
type GraphCheckpoint = {
  completedNodes: string[];
  graph: { nodes: Record<string, { phase?: string; accepted?: AcceptedRecord }> };
};

const nodeDeclaration = ["join", "leaf2", "right", "leaf1", "seed", "left"];
const nodeIds = ["seed", "left", "right", "leaf1", "leaf2", "join"];
const aliases = [
  { name: "joined", source: "join" },
  { name: "leaf2", source: "leaf2" },
  { name: "seed", source: "seed" },
  { name: "leaf1", source: "leaf1" },
];
const scenarioBudgetMs = 30_000;
const sharedCleanupBudgetMs = 8_000;
const testCeilingMs = 45_000;

test("PAR-021 nested subset join waits for every declared node and preserves output alias order", async () => {
  const project = createInitializedProject("par-021-nested-outputs-café");
  const canonicalProject = assertOwnedProject(project);
  let fixture: GraphProcessProviderFixture | undefined;
  let settled: Promise<RunOutcome> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];
  let safeToRemove = true;

  try {
    configureParallelProject(project);
    configureNestedOutputGraph(project);
    fixture = createGraphProcessProvider(project, nodeIds);
    const readinessCounts: Record<string, number> = {};
    const provider: ProviderPort = {
      async isAvailable(profile, options) {
        const model = typeof profile.model === "string" ? profile.model : "unknown";
        readinessCounts[model] = (readinessCounts[model] ?? 0) + 1;
        return await fixture?.provider.isAvailable?.(profile, options) ?? true;
      },
      invoke(invocation) { return fixture!.provider.invoke(invocation); },
      telemetryForCall(callId) { return fixture?.provider.telemetryForCall?.(callId) ?? null; },
      launchForCall(callId) { return fixture?.provider.launchForCall?.(callId) ?? null; },
    };
    const scenarioDeadline = Date.now() + scenarioBudgetMs;
    settled = startRun(project, provider);

    await waitForStarted(fixture, ["seed"], settled, scenarioDeadline);
    const seedRunId = fixture.invocations.find(({ nodeId }) => nodeId === "seed")?.runId;
    expect(seedRunId).toBeDefined();
    if (!seedRunId) throw new Error(`Seed process did not capture a run ID. ${fixture.diagnostics()}`);
    expect(fixture.activeNodeIds()).toEqual(["seed"]);

    fixture.release("seed");
    await waitForFinished(fixture, ["seed"], settled, scenarioDeadline);
    await waitForStarted(fixture, ["left", "right"], settled, scenarioDeadline);
    expect(fixture.activeNodeIds().sort((left, right) => left.localeCompare(right))).toEqual(["left", "right"]);
    for (const nodeId of ["left", "right"]) {
      const invocation = invocationFor(fixture, nodeId);
      expect(invocation.inputs).toEqual({ seed: { text: "done:seed" } });
      const entry = invocation.checkpointAtEntry as unknown as GraphCheckpoint;
      expect(entry.graph.nodes.seed?.phase).toBe("accepted");
      expectAcceptedSource(project, seedRunId, entry, "seed");
    }

    fixture.release("left");
    await waitForFinished(fixture, ["left"], settled, scenarioDeadline);
    await waitForStarted(fixture, ["leaf1", "leaf2"], settled, scenarioDeadline);
    expect(fixture.activeNodeIds().sort((left, right) => left.localeCompare(right))).toEqual(["leaf1", "leaf2", "right"]);
    for (const nodeId of ["leaf1", "leaf2"]) {
      const invocation = invocationFor(fixture, nodeId);
      expect(invocation.inputs).toEqual({ left: { text: "done:left" } });
      const entry = invocation.checkpointAtEntry as unknown as GraphCheckpoint;
      expect(entry.graph.nodes.left?.phase).toBe("accepted");
      expect(entry.graph.nodes.right?.phase).toBe("active");
      expectAcceptedSource(project, seedRunId, entry, "left");
    }

    fixture.release("leaf1");
    fixture.release("leaf2");
    await waitForFinished(fixture, ["leaf1", "leaf2"], settled, scenarioDeadline);
    await waitForStarted(fixture, ["join"], settled, scenarioDeadline);
    const joinInvocation = invocationFor(fixture, "join");
    expect(joinInvocation.inputs).toEqual({
      leaf1: { text: "done:leaf1" },
      leaf2: { text: "done:leaf2" },
      seed: { text: "done:seed" },
    });
    const joinEntry = joinInvocation.checkpointAtEntry as unknown as GraphCheckpoint;
    expect(joinEntry.graph.nodes.right?.phase).toBe("active");
    for (const sourceId of ["seed", "leaf1", "leaf2"]) {
      expect(joinEntry.graph.nodes[sourceId]?.phase).toBe("accepted");
      expectAcceptedSource(project, seedRunId, joinEntry, sourceId);
    }

    fixture.release("join");
    await waitForFinished(fixture, ["join"], settled, scenarioDeadline);
    const acceptedWhileRightActive = await waitForCheckpoint(
      project,
      seedRunId,
      (checkpoint) => checkpoint.graph.nodes.join?.phase === "accepted" && checkpoint.graph.nodes.right?.phase === "active",
      settled,
      scenarioDeadline,
      fixture,
    );
    expect(acceptedWhileRightActive.graph.nodes.join?.accepted).toBeDefined();

    const eventLoopObservation = await Promise.race([
      settled.then((outcome) => ({ kind: "settled" as const, outcome })),
      new Promise<{ kind: "turn" }>((resolve) => setImmediate(() => resolve({ kind: "turn" }))),
    ]);
    expect(eventLoopObservation.kind, eventLoopObservation.kind === "settled" ? describeOutcome(eventLoopObservation.outcome) : "")
      .toBe("turn");
    expect(fixture.hasFinished("right")).toBe(false);
    expect(fixture.activeNodeIds()).toContain("right");

    fixture.release("right");
    await waitForFinished(fixture, ["right"], settled, scenarioDeadline);
    const outcome = await withDeadline(settled, scenarioDeadline, "P3B public workflow completion");
    expect(outcome.kind, outcome.kind === "rejection" ? describeOutcome(outcome) : "").toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("success");

    const finalCheckpoint = readCheckpoint(project, seedRunId);
    expect(finalCheckpoint.completedNodes).toEqual(nodeDeclaration);
    expect(Object.keys(finalCheckpoint.graph.nodes)).toEqual(expect.arrayContaining(nodeDeclaration));
    for (const nodeId of nodeIds) {
      expect(finalCheckpoint.graph.nodes[nodeId]?.phase).toBe("accepted");
      expectAcceptedSource(project, seedRunId, finalCheckpoint, nodeId);
    }

    const invocations = fixture.invocations;
    expect(invocations.map(({ nodeId }) => nodeId).sort((left, right) => left.localeCompare(right)))
      .toEqual([...nodeIds].sort((left, right) => left.localeCompare(right)));
    expect(invocations.every(({ attempt }) => attempt === 1)).toBe(true);
    expect(new Set(invocations.map(({ callId }) => callId)).size).toBe(nodeIds.length);
    expect(readinessCounts).toEqual(Object.fromEntries(nodeIds.map((nodeId) => [`profile-${nodeId}`, 1])));

    const expectedArtifacts = aliases.map(({ name, source }) => {
      const artifact = acceptedArtifact(finalCheckpoint, source);
      const saved = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", seedRunId, artifact.ref), "utf8")) as { name: string; contract: string; data: unknown };
      return { name, contract: saved.contract, data: saved.data };
    });
    expect(outcome.result.result).toEqual({ artifacts: expectedArtifacts });
    const outputsBytes = readFileSync(path.join(project, ".nodulus", "runs", seedRunId, "outputs.json"));
    expect(JSON.parse(outputsBytes.toString("utf8"))).toEqual(expectedArtifacts);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    const cleanupDeadline = Date.now() + sharedCleanupBudgetMs;
    if (fixture) {
      try { fixture.releaseAll(); }
      catch (error) { cleanupErrors.push(toError(error)); safeToRemove = false; }
    }
    if (settled) {
      try { await withDeadline(settled, cleanupDeadline, "P3B public workflow drain"); }
      catch (error) { cleanupErrors.push(toError(error)); safeToRemove = false; }
    }
    if (fixture) {
      try { await fixture.drain(Math.max(1, cleanupDeadline - Date.now())); }
      catch (error) { cleanupErrors.push(toError(error)); safeToRemove = false; }
      if (!fixture.invocations.every(({ nodeId }) => fixture!.hasFinished(nodeId))) {
        cleanupErrors.push(new Error(`A P3B provider process lacks its finished marker. ${fixture.diagnostics()}`));
        safeToRemove = false;
      }
    }
    if (safeToRemove) {
      try {
        if (assertOwnedProject(project) !== canonicalProject) {
          cleanupErrors.push(new Error("P3B project identity changed before cleanup."));
          safeToRemove = false;
        } else rmSync(canonicalProject, { recursive: true, force: true });
      } catch (error) { cleanupErrors.push(toError(error)); }
    }
  }

  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([toError(primaryError), ...cleanupErrors], "P3B scenario and cleanup both failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P3B cleanup failed.");
}, testCeilingMs);

function configureNestedOutputGraph(project: string): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = [...nodeDeclaration];
  workflow.execution.maxConcurrency = 3;
  workflow.execution.dependsOn = {
    seed: [],
    left: ["seed"],
    right: ["seed"],
    leaf1: ["left"],
    leaf2: ["left"],
    join: ["leaf1", "leaf2"],
  };
  workflow.execution.resources = Object.fromEntries(nodeIds.map((nodeId) => [nodeId, []]));
  workflow.outputs = aliases.map(({ name, source }) => ({ name, from: `${source}.report`, contract: "report.v1" }));
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  const settings = readProjectJson(project, ".nodulus/settings.json") as { providerProfiles: Record<string, Record<string, unknown>> };
  const baseProfile = settings.providerProfiles.fixture;
  if (!baseProfile) throw new Error("P3B initialized project has no fixture provider profile.");
  for (const nodeId of nodeIds) {
    const profileId = `profile-${nodeId}`;
    settings.providerProfiles[profileId] = { ...baseProfile, model: profileId };
  }
  writeJson(project, ".nodulus/settings.json", settings);

  const mappings: Record<string, Record<string, unknown>> = {
    seed: { request: { from: "request", contract: "request.v1" } },
    left: { seed: { from: "seed.report", contract: "report.v1" } },
    right: { seed: { from: "seed.report", contract: "report.v1" } },
    leaf1: { left: { from: "left.report", contract: "report.v1" } },
    leaf2: { left: { from: "left.report", contract: "report.v1" } },
    join: {
      leaf1: { from: "leaf1.report", contract: "report.v1" },
      leaf2: { from: "leaf2.report", contract: "report.v1" },
      seed: { from: "seed.report", contract: "report.v1" },
    },
  };
  for (const nodeId of nodeIds) {
    writeJson(project, `.nodulus/nodes/${nodeId}.json`, {
      schemaVersion: 1,
      id: nodeId,
      providerProfile: `profile-${nodeId}`,
      instructions: [`.nodulus/instructions/${nodeId}.md`],
      inputs: mappings[nodeId],
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${nodeId}.md`), `Instructions for ${nodeId}.\n`, "utf8");
  }
}

function request(project: string) {
  return { projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline" as const, text: "Exercise nested graph joins and declared outputs." }] };
}

function startRun(project: string, provider: ProviderPort): Promise<RunOutcome> {
  return runWorkflow(request(project), provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

function invocationFor(fixture: GraphProcessProviderFixture, nodeId: string) {
  const invocation = fixture.invocations.find((item) => item.nodeId === nodeId);
  if (!invocation) throw new Error(`P3B is missing the actual child invocation for '${nodeId}'. ${fixture.diagnostics()}`);
  return invocation;
}

function acceptedArtifact(checkpoint: GraphCheckpoint, nodeId: string): AcceptedArtifact {
  const accepted = checkpoint.graph.nodes[nodeId]?.accepted;
  if (!accepted) throw new Error(`P3B checkpoint has no accepted source record for '${nodeId}'.`);
  const artifact = accepted.artifacts.find(({ name }) => name === "report");
  if (!artifact) throw new Error(`P3B accepted record for '${nodeId}' has no report artifact.`);
  return artifact;
}

function expectAcceptedSource(project: string, runId: string, checkpoint: GraphCheckpoint, nodeId: string): void {
  const artifact = acceptedArtifact(checkpoint, nodeId);
  const bytes = readFileSync(path.join(project, ".nodulus", "runs", runId, artifact.ref));
  expect(sha256(bytes)).toBe(artifact.sha256);
  expect(JSON.parse(bytes.toString("utf8"))).toEqual({
    name: "report",
    contract: "report.v1",
    data: { text: `done:${nodeId}` },
  });
}

function readCheckpoint(project: string, runId: string): GraphCheckpoint {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as GraphCheckpoint;
}

async function waitForStarted(fixture: GraphProcessProviderFixture, nodeIdsToWait: string[], settled: Promise<RunOutcome>, deadline: number): Promise<void> {
  const controller = new AbortController();
  try {
    const observed = await withDeadline(Promise.race([
      fixture.waitForStarted(nodeIdsToWait, controller.signal).then(() => ({ kind: "started" as const })),
      settled.then((outcome) => ({ kind: "settled" as const, outcome })),
    ]), deadline, `P3B child start: ${nodeIdsToWait.join(", ")}`);
    if (observed.kind === "settled") throw new Error(`P3B workflow settled before child start (${nodeIdsToWait.join(", ")}): ${describeOutcome(observed.outcome)}.`);
  } finally { controller.abort(); }
}

async function waitForFinished(fixture: GraphProcessProviderFixture, nodeIdsToWait: string[], settled: Promise<RunOutcome>, deadline: number): Promise<void> {
  const controller = new AbortController();
  try {
    const observed = await withDeadline(Promise.race([
      fixture.waitForFinished(nodeIdsToWait, controller.signal).then(() => ({ kind: "finished" as const })),
      settled.then((outcome) => ({ kind: "settled" as const, outcome })),
    ]), deadline, `P3B child finish: ${nodeIdsToWait.join(", ")}`);
    if (observed.kind === "settled") {
      if (nodeIdsToWait.every((nodeId) => fixture.hasFinished(nodeId))) return;
      throw new Error(`P3B workflow settled before child finish (${nodeIdsToWait.join(", ")}): ${describeOutcome(observed.outcome)}.`);
    }
  } finally { controller.abort(); }
}

async function waitForCheckpoint(
  project: string,
  runId: string,
  predicate: (checkpoint: GraphCheckpoint) => boolean,
  settled: Promise<RunOutcome>,
  deadline: number,
  fixture: GraphProcessProviderFixture,
): Promise<GraphCheckpoint> {
  while (Date.now() < deadline) {
    const checkpoint = readCheckpoint(project, runId);
    if (predicate(checkpoint)) return checkpoint;
    const observation = await Promise.race([
      settled.then((outcome) => ({ kind: "settled" as const, outcome })),
      new Promise<{ kind: "poll" }>((resolve) => setTimeout(() => resolve({ kind: "poll" }), 10)),
    ]);
    if (observation.kind === "settled") throw new Error(`P3B workflow settled before the checkpoint boundary: ${describeOutcome(observation.outcome)}. ${fixture.diagnostics()}`);
  }
  throw new Error(`P3B checkpoint boundary exceeded its scenario deadline. ${fixture.diagnostics()}`);
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${description} exceeded its absolute deadline.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} exceeded its absolute deadline.`)), remaining); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function assertOwnedProject(project: string): string {
  const absolute = path.resolve(project);
  const canonical = realpathSync.native(absolute);
  const canonicalTemp = realpathSync.native(os.tmpdir());
  if (path.dirname(canonical) !== canonicalTemp || !path.basename(canonical).startsWith("nodulus-par-021-nested-outputs-café-")) {
    throw new Error(`Refusing cleanup outside the generated P3B temporary project: '${canonical}'.`);
  }
  return canonical;
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function describeOutcome(outcome: RunOutcome): string {
  if (outcome.kind === "rejection") return `run rejected: ${outcome.error instanceof Error ? outcome.error.message : "Non-Error rejection."}`;
  return `run returned ${outcome.result.status}`;
}
function toError(error: unknown): Error { return error instanceof Error ? error : new Error("P3B cleanup failed with a non-Error value."); }

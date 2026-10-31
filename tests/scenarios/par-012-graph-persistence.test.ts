import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { resumeWorkflow, runWorkflow, type ApplicationRunResult, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { createGraphProcessProvider, type GraphProcessProviderFixture } from "../support/graph-process-provider.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { writeJson } from "../support/workflow-sequence.js";

type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };
type GraphTestNode = { id: string; inputs: Record<string, unknown>; validator?: boolean };
type AcceptedEvidence = {
  attempt: number;
  callId: string;
  resultRef: string;
  resultSha256: string;
  validationRef: string;
  validationSha256: string;
  responseRef: string;
  responseSha256: string;
  artifacts: Array<{ name: string; contract: string; ref: string; sha256: string }>;
};

const testWatchdogMs = 35_000;
const barrierValidatorSource = fileURLToPath(new URL("../fixtures/par-graph-validator.mjs", import.meta.url));
const barrierValidatorRelative = ".nodulus/fixtures/par-graph-validator.mjs";

function configureGraph(project: string, nodes: GraphTestNode[], dependsOn: Record<string, string[]>, maxConcurrency: number): void {
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
      expectedOutputs: [{ name: "report", contract: "report.v1", ...(node.validator ? { validator: barrierValidatorRelative, validatorTimeoutMs: 12_000 } : {}) }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${node.id}.md`), `Instructions for ${node.id}.\n`, "utf8");
  }
  if (nodes.some(({ validator }) => validator)) {
    const validatorDirectory = path.join(project, ".nodulus", "fixtures");
    copyFileSync(barrierValidatorSource, path.join(validatorDirectory, "par-graph-validator.mjs"));
    mkdirSync(path.join(validatorDirectory, "validator-process-state"), { recursive: true });
  }
}

function request(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Run the persistence graph fixture." }],
  };
}

function startRun(project: string, provider: ProviderPort): Promise<RunOutcome> {
  return runWorkflow(request(project), provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

function providerWithObserver(
  fixture: GraphProcessProviderFixture,
  observer: (invocation: ProviderInvocation) => void,
): ProviderPort {
  return {
    isAvailable: (profile, options) => fixture.provider.isAvailable?.(profile, options) ?? true,
    invoke(invocation) {
      observer(invocation);
      return fixture.provider.invoke(invocation);
    },
    telemetryForCall: (callId) => fixture.provider.telemetryForCall?.(callId) ?? null,
    launchForCall: (callId) => fixture.provider.launchForCall?.(callId) ?? null,
  };
}

function providerWithCounters(fixture: GraphProcessProviderFixture): { provider: ProviderPort; counters: { probes: number; invocations: number } } {
  const counters = { probes: 0, invocations: 0 };
  return {
    counters,
    provider: {
      isAvailable(profile, options) {
        counters.probes += 1;
        return fixture.provider.isAvailable?.(profile, options) ?? true;
      },
      invoke(invocation) {
        counters.invocations += 1;
        return fixture.provider.invoke(invocation);
      },
      telemetryForCall: (callId) => fixture.provider.telemetryForCall?.(callId) ?? null,
      launchForCall: (callId) => fixture.provider.launchForCall?.(callId) ?? null,
    },
  };
}

function readCheckpoint(project: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, any>;
}

function readRunFile(project: string, runId: string, relative: string): Buffer {
  return readFileSync(path.join(project, ".nodulus", "runs", runId, ...relative.split("/")));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function invocationFor(fixture: GraphProcessProviderFixture, nodeId: string) {
  const invocation = fixture.invocations.find((candidate) => candidate.nodeId === nodeId);
  if (!invocation) throw new Error(`No invocation evidence for '${nodeId}'. ${fixture.diagnostics()}`);
  return invocation;
}

function logNonSuccessOutcome(scenario: string, outcome: RunOutcome): void {
  if (outcome.kind === "rejection") {
    process.stderr.write(`[${scenario}] workflow rejected: ${String(outcome.error)}\n`);
  } else if (outcome.result.status !== "success") {
    process.stderr.write(`[${scenario}] workflow ${outcome.result.status}: ${JSON.stringify(outcome.result.result)}\n`);
  }
}

function expectSuccess(outcome: RunOutcome): ApplicationRunResult {
  expect(outcome.kind).toBe("result");
  if (outcome.kind !== "result") throw outcome.error;
  expect(outcome.result.status).toBe("success");
  return outcome.result;
}

function expectAliases(result: ApplicationRunResult, nodeIds: string[]): void {
  expect(result.result).toMatchObject({
    artifacts: nodeIds.map((nodeId) => ({ name: `${nodeId}Output`, contract: "report.v1", data: { text: `done:${nodeId}` } })),
  });
}

function verifyAcceptedEvidence(project: string, runId: string, nodeId: string, accepted: AcceptedEvidence): void {
  const invocationBytes = readRunFile(project, runId, `nodes/${nodeId}/attempt-${String(accepted.attempt).padStart(3, "0")}/invocation.json`);
  const invocation = JSON.parse(invocationBytes.toString("utf8")) as Record<string, unknown>;
  expect(invocation).toMatchObject({ nodeId, attempt: accepted.attempt, callId: accepted.callId });

  const resultBytes = readRunFile(project, runId, accepted.resultRef);
  expect(sha256(resultBytes)).toBe(accepted.resultSha256);
  const result = JSON.parse(resultBytes.toString("utf8")) as { status?: unknown; artifacts?: unknown[] };
  expect(result.status).toBe("success");
  expect(result.artifacts).toEqual([{ name: "report", contract: "report.v1", data: { text: `done:${nodeId}` } }]);

  const validationBytes = readRunFile(project, runId, accepted.validationRef);
  expect(sha256(validationBytes)).toBe(accepted.validationSha256);
  expect(JSON.parse(validationBytes.toString("utf8"))).toMatchObject({ valid: true, outcome: "success" });

  const responseBytes = readRunFile(project, runId, accepted.responseRef);
  expect(sha256(responseBytes)).toBe(accepted.responseSha256);
  const response = JSON.parse(responseBytes.toString("utf8")) as { status?: unknown; artifacts?: Array<Record<string, unknown>> };
  expect(response.status).toBe("success");
  expect(response.artifacts?.[0]).toMatchObject({ name: "report", contract: "report.v1", data: { text: `done:${nodeId}` } });

  expect(accepted.artifacts).toHaveLength(1);
  const artifactRecord = accepted.artifacts[0];
  if (!artifactRecord) throw new Error(`Node '${nodeId}' has no accepted artifact reference.`);
  expect(artifactRecord).toMatchObject({ name: "report", contract: "report.v1" });
  const artifactBytes = readRunFile(project, runId, artifactRecord.ref);
  expect(sha256(artifactBytes)).toBe(artifactRecord.sha256);
  expect(JSON.parse(artifactBytes.toString("utf8"))).toMatchObject({ name: "report", contract: "report.v1", data: { text: `done:${nodeId}` } });

  const callBytes = readRunFile(project, runId, `calls/${accepted.callId}/request.json`);
  expect(JSON.parse(callBytes.toString("utf8"))).toMatchObject({ callId: accepted.callId, nodeId, attempt: accepted.attempt });
}

function verifyAcceptedEvidenceAtInvocation(project: string, invocation: ProviderInvocation, parentNodeIds: string[]): Record<string, unknown> {
  const checkpoint = readCheckpoint(project, invocation.runId);
  const parents: Record<string, unknown> = {};
  for (const nodeId of parentNodeIds) {
    const nodeState = checkpoint.graph.nodes[nodeId] as { phase?: string; accepted?: AcceptedEvidence };
    expect(nodeState.phase).toBe("accepted");
    const accepted = nodeState.accepted;
    if (!accepted) throw new Error(`Parent '${nodeId}' has no accepted evidence in the provider-entry checkpoint.`);
    verifyAcceptedEvidence(project, invocation.runId, nodeId, accepted);
    parents[nodeId] = { phase: nodeState.phase, callId: accepted.callId, accepted };
  }
  return {
    parents,
    nextEventSequence: checkpoint.graph.nextEventSequence,
  };
}

async function waitForNodePhase(project: string, runId: string, nodeId: string, phase: string, fixture: GraphProcessProviderFixture): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (readCheckpoint(project, runId).graph.nodes[nodeId]?.phase !== phase) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for '${nodeId}' phase '${phase}'. ${fixture.diagnostics()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function snapshotDirectory(root: string): string {
  const files: Array<[string, string]> = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push([relative, readFileSync(absolute).toString("base64")]);
    }
  };
  visit(root, "");
  files.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(files);
}

function configureFaultGraph(project: string): string[] {
  const nodes = [
    { id: "alpha", inputs: { request: { from: "request", contract: "request.v1" } }, validator: true },
    { id: "beta", inputs: { request: { from: "request", contract: "request.v1" } } },
  ];
  configureGraph(project, nodes, { alpha: [], beta: [] }, 1);
  return nodes.map(({ id }) => id);
}

function barrierValidatorDirectory(project: string): string {
  return path.join(project, ".nodulus", "fixtures", "validator-process-state");
}

async function waitForBarrierValidator(project: string, nodeId: string, fixture: GraphProcessProviderFixture): Promise<void> {
  const marker = path.join(barrierValidatorDirectory(project), `started-${nodeId}.json`);
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the ${nodeId} barrier validator. ${fixture.diagnostics()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function releaseBarrierValidator(project: string, nodeId: string): void {
  writeFileSync(path.join(barrierValidatorDirectory(project), `release-${nodeId}`), "release\n", "utf8");
}

function expectCallCompletionCommitted(project: string, runId: string, nodeId: string): void {
  const runRoot = path.join(project, ".nodulus", "runs", runId);
  const events = readFileSync(path.join(runRoot, "events.jsonl"), "utf8").trim().split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const completed = events.find((event) => event.event === "provider.call.completed" && event.nodeId === nodeId);
  expect(completed).toBeDefined();
  const sequence = completed?.sequence;
  expect(typeof sequence).toBe("number");
  expect(readCheckpoint(project, runId).graph.nextEventSequence).toBeGreaterThan(sequence as number);
}

async function waitForBarrierValidatorExit(project: string, nodeId: string, fixture: GraphProcessProviderFixture): Promise<void> {
  const marker = path.join(barrierValidatorDirectory(project), `started-${nodeId}.json`);
  if (!existsSync(marker)) return;
  let pid: number;
  try {
    const value = JSON.parse(readFileSync(marker, "utf8")) as { pid?: unknown };
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) throw new Error("invalid process ID");
    pid = value.pid;
  } catch (error) {
    throw new Error(`Could not safely read barrier validator process identity from '${marker}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const deadline = Date.now() + 12_000;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for barrier validator PID ${pid} to exit. ${fixture.diagnostics()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function cleanupRun(project: string, fixture: GraphProcessProviderFixture, settled: Promise<RunOutcome>): Promise<void> {
  fixture.releaseAll();
  let outcome: RunOutcome;
  try {
    outcome = await settled;
    logNonSuccessOutcome("PAR-012", outcome);
  } finally {
    await fixture.drain();
    rmSync(project, { recursive: true, force: true });
  }
}

test("PAR-012 serializes concurrent event, metric and accepted evidence publications", async () => {
  const project = createInitializedProject("par-012 concurrent persistence café");
  configureParallelProject(project);
  const nodeIds = ["alpha", "beta", "gamma", "delta"];
  configureGraph(project, nodeIds.map((id) => ({ id, inputs: { request: { from: "request", contract: "request.v1" } } })),
    { alpha: [], beta: [], gamma: [], delta: [] }, 2);
  const fixture = createGraphProcessProvider(project, nodeIds);
  const settled = startRun(project, fixture.provider);
  try {
    await fixture.waitForStarted(["alpha", "beta"]);
    fixture.release("beta");
    await fixture.waitForFinished(["beta"]);
    await fixture.waitForStarted(["gamma"]);
    fixture.release("gamma");
    await fixture.waitForFinished(["gamma"]);
    await fixture.waitForStarted(["delta"]);
    fixture.release("delta");
    await fixture.waitForFinished(["delta"]);
    const runId = invocationFor(fixture, "delta").runId;
    await waitForNodePhase(project, runId, "delta", "accepted", fixture);
    fixture.release("alpha");
    await fixture.waitForFinished(["alpha"]);

    const result = expectSuccess(await settled);
    expectAliases(result, nodeIds);
    expect(fixture.peakActiveCalls()).toBeLessThanOrEqual(2);
    expect(fixture.invocations).toHaveLength(nodeIds.length);
    expect(new Set(fixture.invocations.map(({ nodeId }) => nodeId))).toEqual(new Set(nodeIds));
    expect(new Set(fixture.invocations.map(({ callId }) => callId)).size).toBe(nodeIds.length);

    const runRoot = path.join(project, ".nodulus", "runs", result.runId);
    const checkpoint = readCheckpoint(project, result.runId);
    const events = readFileSync(path.join(runRoot, "events.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    const sequences = events.map((event) => event.sequence as number);
    expect(sequences).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
    expect(checkpoint.graph.nextEventSequence).toBe(events.length + 1);
    expect(events.filter((event) => event.event === "node.started").map((event) => event.nodeId)).toEqual(nodeIds);
    expect(events.filter((event) => event.event === "node.accepted").map((event) => event.nodeId)).toEqual(["beta", "gamma", "delta", "alpha"]);
    expect(events.filter((event) => event.event === "node.accepted")).toHaveLength(nodeIds.length);
    expect(checkpoint.completedNodes).toEqual(nodeIds);
    expect(Object.values(checkpoint.graph.nodes).every((node: any) => node.phase === "accepted")).toBe(true);

    const metrics = JSON.parse(readFileSync(path.join(runRoot, "metrics.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(metrics).toHaveLength(nodeIds.length);
    expect(new Set(metrics.map((metric) => metric.callId)).size).toBe(nodeIds.length);
    expect(new Set(metrics.map((metric) => metric.nodeId))).toEqual(new Set(nodeIds));
    expect(metrics.every((metric) => metric.attempt === 1 && metric.operation === "invoke")).toBe(true);
    for (const nodeId of nodeIds) {
      const accepted = checkpoint.graph.nodes[nodeId]?.accepted as AcceptedEvidence | undefined;
      expect(checkpoint.graph.nodes[nodeId]).toMatchObject({ phase: "accepted", attempt: 1 });
      if (!accepted) throw new Error(`Accepted node '${nodeId}' is missing its evidence record.`);
      verifyAcceptedEvidence(project, result.runId, nodeId, accepted);
    }
    expect(checkpoint.graph.pendingRequests).toEqual({});
  } finally {
    await cleanupRun(project, fixture, settled);
  }
}, testWatchdogMs);

test("PAR-012 verifies predecessor checkpoint and hashes before launching its successor", async () => {
  const project = createInitializedProject("par-012 evidence before successor café");
  configureParallelProject(project);
  const nodeIds = ["successor", "alpha", "beta"];
  configureGraph(project, [
    { id: "successor", inputs: {
      alpha: { from: "alpha.report", contract: "report.v1" },
      beta: { from: "beta.report", contract: "report.v1" },
    } },
    { id: "alpha", inputs: { request: { from: "request", contract: "request.v1" } } },
    { id: "beta", inputs: { request: { from: "request", contract: "request.v1" } } },
  ], { successor: ["alpha", "beta"], alpha: [], beta: [] }, 2);
  const fixture = createGraphProcessProvider(project, nodeIds);
  const observations: Array<Record<string, unknown>> = [];
  const provider = providerWithObserver(fixture, (invocation) => {
    if (invocation.nodeId === "successor") observations.push(verifyAcceptedEvidenceAtInvocation(project, invocation, ["alpha", "beta"]));
  });
  const settled = startRun(project, provider);
  try {
    await fixture.waitForStarted(["alpha", "beta"]);
    const runId = invocationFor(fixture, "alpha").runId;
    fixture.release("alpha");
    await fixture.waitForFinished(["alpha"]);
    await waitForNodePhase(project, runId, "alpha", "accepted", fixture);
    expect(fixture.hasStarted("successor")).toBe(false);
    expect(readCheckpoint(project, runId).graph.nodes.beta.phase).toBe("active");
    fixture.release("beta");
    await fixture.waitForFinished(["beta"]);
    await fixture.waitForStarted(["successor"]);
    const successorInvocation = invocationFor(fixture, "successor");
    expect(successorInvocation.inputs).toEqual({ alpha: { text: "done:alpha" }, beta: { text: "done:beta" } });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ parents: { alpha: { phase: "accepted" }, beta: { phase: "accepted" } } });
    fixture.release("successor");
    await fixture.waitForFinished(["successor"]);
    const result = expectSuccess(await settled);
    expectAliases(result, nodeIds);
  } finally {
    await cleanupRun(project, fixture, settled);
  }
}, testWatchdogMs);

test("PAR-012 fails closed when required checkpoint replacement fails on disk", async () => {
  const project = createInitializedProject("par-012 checkpoint promotion failure café");
  configureParallelProject(project);
  const nodeIds = configureFaultGraph(project);
  const fixture = createGraphProcessProvider(project, nodeIds);
  const counted = providerWithCounters(fixture);
  const settled = startRun(project, counted.provider);
  let runRoot = "";
  let checkpointPath = "";
  let savedCheckpoint: Buffer | undefined;
  let restored = false;
  try {
    await fixture.waitForStarted(["alpha"]);
    const runId = invocationFor(fixture, "alpha").runId;
    runRoot = path.join(project, ".nodulus", "runs", runId);
    checkpointPath = path.join(runRoot, "run.json");
    fixture.release("alpha");
    await fixture.waitForFinished(["alpha"]);
    await waitForBarrierValidator(project, "alpha", fixture);
    expectCallCompletionCommitted(project, runId, "alpha");
    savedCheckpoint = readFileSync(checkpointPath);
    const resultPath = path.join(runRoot, "nodes", "alpha", "attempt-001", "result.json");
    expect(existsSync(resultPath)).toBe(false);
    unlinkSync(checkpointPath);
    mkdirSync(checkpointPath);

    releaseBarrierValidator(project, "alpha");
    const outcome = await settled;
    logNonSuccessOutcome("PAR-012 checkpoint-promotion-failure", outcome);
    await fixture.drain();
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("error");
    expect((outcome.result.result as any).error.code).toBe("RUN_STORAGE_FAILED");
    expect(fixture.hasStarted("beta")).toBe(false);
    expect(fixture.invocations.map(({ nodeId }) => nodeId)).toEqual(["alpha"]);
    expect(statSync(checkpointPath).isDirectory()).toBe(true);
    expect(existsSync(resultPath)).toBe(true);

    rmSync(checkpointPath, { recursive: true, force: true });
    writeFileSync(checkpointPath, savedCheckpoint);
    restored = true;
    expect(readFileSync(checkpointPath).equals(savedCheckpoint)).toBe(true);
    const checkpointBeforeResume = snapshotDirectory(runRoot);
    const countsBeforeResume = { ...counted.counters };
    await expect(resumeWorkflow({ projectRoot: project, runId, requestId: "unused", answers: {} }, counted.provider))
      .rejects.toMatchObject({ code: "RUN_RECOVERY_REQUIRED" });
    expect(counted.counters).toEqual(countsBeforeResume);
    expect(snapshotDirectory(runRoot)).toBe(checkpointBeforeResume);
    expect(readCheckpoint(project, runId).completedNodes).toEqual([]);
    expect(readCheckpoint(project, runId).graph.nodes.alpha.phase).toBe("active");
  } finally {
    fixture.releaseAll();
    releaseBarrierValidator(project, "alpha");
    const outcome = await settled;
    logNonSuccessOutcome("PAR-012 checkpoint-promotion-cleanup", outcome);
    await fixture.drain();
    await waitForBarrierValidatorExit(project, "alpha", fixture);
    if (checkpointPath && existsSync(checkpointPath) && statSync(checkpointPath).isDirectory()) {
      rmSync(checkpointPath, { recursive: true, force: true });
    }
    if (!restored && checkpointPath && savedCheckpoint) writeFileSync(checkpointPath, savedCheckpoint);
    rmSync(project, { recursive: true, force: true });
  }
}, testWatchdogMs);

test("PAR-012 classifies required node-result persistence failure and prevents later admission", async () => {
  const project = createInitializedProject("par-012 node evidence failure café");
  configureParallelProject(project);
  const nodeIds = configureFaultGraph(project);
  const fixture = createGraphProcessProvider(project, nodeIds);
  const settled = startRun(project, fixture.provider);
  try {
    await fixture.waitForStarted(["alpha"]);
    const invocation = invocationFor(fixture, "alpha");
    const runRoot = path.join(project, ".nodulus", "runs", invocation.runId);
    const checkpointPath = path.join(runRoot, "run.json");
    fixture.release("alpha");
    await fixture.waitForFinished(["alpha"]);
    await waitForBarrierValidator(project, "alpha", fixture);
    expectCallCompletionCommitted(project, invocation.runId, "alpha");
    const checkpointBefore = readFileSync(checkpointPath, "utf8");
    const resultPath = path.join(runRoot, "nodes", "alpha", "attempt-001", "result.json");
    expect(existsSync(path.dirname(resultPath))).toBe(true);
    expect(existsSync(resultPath)).toBe(false);
    mkdirSync(resultPath);

    releaseBarrierValidator(project, "alpha");
    const outcome = await settled;
    logNonSuccessOutcome("PAR-012 required-node-evidence-failure", outcome);
    await fixture.drain();
    await waitForBarrierValidatorExit(project, "alpha", fixture);
    expect(fixture.hasStarted("beta")).toBe(false);
    expect(fixture.invocations.map(({ nodeId }) => nodeId)).toEqual(["alpha"]);
    expect.soft(readFileSync(checkpointPath, "utf8")).toBe(checkpointBefore);
    expect(statSync(resultPath).isDirectory()).toBe(true);
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("error");
    expect.soft((outcome.result.result as any).error.code).toBe("RUN_STORAGE_FAILED");
  } finally {
    fixture.releaseAll();
    releaseBarrierValidator(project, "alpha");
    const outcome = await settled;
    logNonSuccessOutcome("PAR-012 required-node-evidence-cleanup", outcome);
    await fixture.drain();
    await waitForBarrierValidatorExit(project, "alpha", fixture);
    rmSync(project, { recursive: true, force: true });
  }
}, testWatchdogMs);

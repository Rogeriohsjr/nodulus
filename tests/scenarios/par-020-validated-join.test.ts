import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runWorkflow, type ApplicationRunResult, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { createGraphProcessProvider, type GraphProcessProviderFixture } from "../support/graph-process-provider.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };
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

const nodeIds = ["slow", "fast", "join", "witness"];
const scenarioBudgetMs = 35_000;
const cleanupBudgetMs = 10_000;
const testWatchdogMs = 50_000;
const validatorSource = fileURLToPath(new URL("../fixtures/par-graph-validator.mjs", import.meta.url));
const validatorRelative = ".nodulus/fixtures/par-graph-validator.mjs";

function configureJoinGraph(project: string): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = [...nodeIds];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { slow: [], fast: [], join: ["slow", "fast"], witness: [] };
  workflow.execution.resources = Object.fromEntries(nodeIds.map((nodeId) => [nodeId, []]));
  workflow.outputs = [
    { name: "joined", from: "join.report", contract: "report.v1" },
    { name: "fastReport", from: "fast.report", contract: "report.v1" },
    { name: "slowReport", from: "slow.report", contract: "report.v1" },
    { name: "witnessReport", from: "witness.report", contract: "report.v1" },
  ];

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  const baseProfile = profiles.fixture;
  if (!baseProfile) throw new Error("The initialized graph project has no fixture provider profile.");
  for (const nodeId of nodeIds) {
    const profileId = `profile-${nodeId}`;
    profiles[profileId] = { ...baseProfile, model: `par-020-${nodeId}` };
    const isSlow = nodeId === "slow";
    const inputs = nodeId === "join"
      ? { slow: { from: "slow.report", contract: "report.v1" }, fast: { from: "fast.report", contract: "report.v1" } }
      : { request: { from: "request", contract: "request.v1" } };
    writeJson(project, `.nodulus/nodes/${nodeId}.json`, {
      schemaVersion: 1,
      id: nodeId,
      providerProfile: profileId,
      instructions: [`.nodulus/instructions/${nodeId}.md`],
      inputs,
      expectedOutputs: [{ name: "report", contract: "report.v1", ...(isSlow ? { validator: validatorRelative, validatorTimeoutMs: 12_000 } : {}) }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${nodeId}.md`), `Instructions for ${nodeId}.\n`, "utf8");
  }
  writeJson(project, ".nodulus/settings.json", settings);
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  const validatorDirectory = path.join(project, ".nodulus", "fixtures");
  copyFileSync(validatorSource, path.join(validatorDirectory, "par-graph-validator.mjs"));
  mkdirSync(path.join(validatorDirectory, "validator-process-state"), { recursive: true });
}

function runRequest(projectRoot: string) {
  return {
    projectRoot,
    cwd: projectRoot,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Produce reports and verify a joined result." }],
  };
}

function startRun(project: string, provider: ProviderPort): Promise<RunOutcome> {
  return runWorkflow(runRequest(project), provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readCheckpoint(project: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, any>;
}

function readRunFile(project: string, runId: string, relative: string): Buffer {
  return readFileSync(path.join(project, ".nodulus", "runs", runId, ...relative.split("/")));
}

function verifyAcceptedEvidence(project: string, runId: string, nodeId: string, accepted: AcceptedEvidence): void {
  const attemptRoot = `nodes/${nodeId}/attempt-${String(accepted.attempt).padStart(3, "0")}`;
  const invocation = JSON.parse(readRunFile(project, runId, `${attemptRoot}/invocation.json`).toString("utf8")) as Record<string, unknown>;
  expect(invocation).toMatchObject({ nodeId, attempt: accepted.attempt, callId: accepted.callId });

  const resultBytes = readRunFile(project, runId, accepted.resultRef);
  expect(sha256(resultBytes)).toBe(accepted.resultSha256);
  expect(JSON.parse(resultBytes.toString("utf8"))).toEqual({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: `done:${nodeId}` } }] });

  const validationBytes = readRunFile(project, runId, accepted.validationRef);
  expect(sha256(validationBytes)).toBe(accepted.validationSha256);
  const validation = JSON.parse(validationBytes.toString("utf8")) as { valid?: unknown; outcome?: unknown; validators?: unknown };
  expect(validation).toMatchObject({ valid: true, outcome: "success" });
  if (nodeId === "slow") expect(validation.validators).toEqual([{ name: "report", valid: true, errors: [] }]);

  const responseBytes = readRunFile(project, runId, accepted.responseRef);
  expect(sha256(responseBytes)).toBe(accepted.responseSha256);
  expect(JSON.parse(responseBytes.toString("utf8"))).toMatchObject({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: `done:${nodeId}` } }] });

  expect(accepted.artifacts).toHaveLength(1);
  const artifact = accepted.artifacts[0];
  if (!artifact) throw new Error(`Accepted node '${nodeId}' has no artifact reference.`);
  expect(artifact).toMatchObject({ name: "report", contract: "report.v1" });
  const artifactBytes = readRunFile(project, runId, artifact.ref);
  expect(sha256(artifactBytes)).toBe(artifact.sha256);
  expect(JSON.parse(artifactBytes.toString("utf8"))).toEqual({ name: "report", contract: "report.v1", data: { text: `done:${nodeId}` } });
  expect(JSON.parse(readRunFile(project, runId, `calls/${accepted.callId}/request.json`).toString("utf8"))).toMatchObject({ callId: accepted.callId, nodeId, attempt: accepted.attempt });
}

function verifyAcceptedAtJoin(project: string, invocation: ProviderInvocation): Record<string, unknown> {
  const checkpoint = readCheckpoint(project, invocation.runId);
  const parents: Record<string, unknown> = {};
  for (const nodeId of ["slow", "fast"]) {
    const state = checkpoint.graph.nodes[nodeId] as { phase?: string; accepted?: AcceptedEvidence };
    expect(state.phase).toBe("accepted");
    if (!state.accepted) throw new Error(`Join entered without durable accepted evidence for '${nodeId}'.`);
    verifyAcceptedEvidence(project, invocation.runId, nodeId, state.accepted);
    parents[nodeId] = { phase: state.phase, callId: state.accepted.callId, accepted: state.accepted };
  }
  return { parents, nextEventSequence: checkpoint.graph.nextEventSequence };
}

async function waitFor(check: () => boolean, deadline: number, signal: AbortSignal, description: string): Promise<void> {
  while (!check()) {
    if (signal.aborted) throw new Error(`Scenario deadline reached while waiting for ${description}.`);
    if (Date.now() >= deadline) throw new Error(`Scenario deadline reached while waiting for ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForValidator(project: string, deadline: number, signal: AbortSignal): Promise<{ pid: number }> {
  const startedPath = path.join(project, ".nodulus", "fixtures", "validator-process-state", "started-slow.json");
  await waitFor(() => existsSync(startedPath), deadline, signal, "slow validator start");
  const started = JSON.parse(readFileSync(startedPath, "utf8")) as { nodeId?: unknown; artifact?: unknown; pid?: unknown };
  if (started.nodeId !== "slow" || !Number.isInteger(started.pid) || (started.pid as number) <= 0) {
    throw new Error(`Slow validator marker has invalid process evidence: ${JSON.stringify(started)}`);
  }
  expect(started.artifact).toEqual({ text: "done:slow" });
  return { pid: started.pid as number };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, deadline: number): Promise<void> {
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Validator PID ${pid} did not exit before the shared cleanup deadline.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function awaitBefore<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Shared cleanup deadline elapsed before ${description}.`);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Shared cleanup deadline elapsed while waiting for ${description}.`)), remaining);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertOwnedProject(project: string): string {
  const canonicalProject = realpathSync.native(project);
  const canonicalTemp = realpathSync.native(tmpdir());
  const expectedPrefix = "nodulus-par-020-validated-join-café-";
  if (!canonicalProject.startsWith(`${canonicalTemp}${path.sep}`) || !path.basename(canonicalProject).startsWith(expectedPrefix)) {
    throw new Error(`Refusing to clean a project outside the owned native temp prefix: ${canonicalProject}`);
  }
  return canonicalProject;
}

test("PAR-020 waits for validated acceptance at a full join while independent work uses the freed slot", async () => {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const project = createInitializedProject("par-020-validated-join-café");
  const scenarioAbort = new AbortController();
  const scenarioTimer = setTimeout(() => scenarioAbort.abort(new Error("PAR-020 scenario deadline reached.")), Math.max(0, scenarioDeadline - Date.now()));
  let fixture: GraphProcessProviderFixture | undefined;
  let settled: Promise<RunOutcome> | undefined;
  let validatorPid: number | undefined;
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    const sentinels = configureParallelProject(project);
    configureJoinGraph(project);
    fixture = createGraphProcessProvider(project, nodeIds);
    const probeModels: string[] = [];
    const joinObservations: Array<Record<string, unknown>> = [];
    const provider: ProviderPort = {
      isAvailable(profile, options) {
        probeModels.push(String(profile.model));
        return fixture?.provider.isAvailable?.(profile, options) ?? true;
      },
      invoke(invocation) {
        if (invocation.nodeId === "join") joinObservations.push(verifyAcceptedAtJoin(project, invocation));
        return fixture!.provider.invoke(invocation);
      },
      telemetryForCall: (callId) => fixture?.provider.telemetryForCall?.(callId) ?? null,
      launchForCall: (callId) => fixture?.provider.launchForCall?.(callId) ?? null,
    };
    settled = startRun(project, provider);

    await fixture.waitForStarted(["slow", "fast"], scenarioAbort.signal);
    const runId = fixture.invocations[0]?.runId;
    if (!runId) throw new Error(`No graph invocation was captured. ${fixture.diagnostics()}`);
    expect(fixture.hasStarted("join")).toBe(false);
    fixture.release("slow");
    await fixture.waitForFinished(["slow"], scenarioAbort.signal);
    const validator = await waitForValidator(project, scenarioDeadline, scenarioAbort.signal);
    validatorPid = validator.pid;
    expect(fixture.hasFinished("slow")).toBe(true);
    expect(processAlive(validatorPid)).toBe(true);
    expect(readCheckpoint(project, runId).graph.nodes.slow.phase).toBe("active");
    expect(fixture.hasStarted("join")).toBe(false);
    expect(fixture.invocations.some((invocation) => invocation.nodeId === "join")).toBe(false);

    fixture.release("fast");
    await fixture.waitForFinished(["fast"], scenarioAbort.signal);
    await waitFor(() => readCheckpoint(project, runId).graph.nodes.fast?.phase === "accepted", scenarioDeadline, scenarioAbort.signal, "fast durable acceptance");
    await fixture.waitForStarted(["witness"], scenarioAbort.signal);
    const witnessInvocation = fixture.invocations.find((invocation) => invocation.nodeId === "witness");
    if (!witnessInvocation) throw new Error(`Witness invocation was not captured. ${fixture.diagnostics()}`);
    const witnessEntry = witnessInvocation.checkpointAtEntry as { graph?: { nodes?: Record<string, { phase?: string }> } };
    expect(witnessEntry.graph?.nodes).toMatchObject({
      slow: { phase: "active" },
      fast: { phase: "accepted" },
      join: { phase: "not_started" },
      witness: { phase: "active" },
    });
    expect(fixture.hasStarted("join")).toBe(false);
    expect(fixture.invocations.some((invocation) => invocation.nodeId === "join")).toBe(false);
    expect(probeModels).not.toContain("par-020-join");

    fixture.release("witness");
    await fixture.waitForFinished(["witness"], scenarioAbort.signal);
    await waitFor(() => readCheckpoint(project, runId).graph.nodes.witness?.phase === "accepted", scenarioDeadline, scenarioAbort.signal, "witness durable acceptance");
    expect(readCheckpoint(project, runId).graph.nodes.slow.phase).toBe("active");
    expect(readCheckpoint(project, runId).graph.nodes.join.phase).toBe("not_started");
    expect(fixture.hasStarted("join")).toBe(false);
    expect(fixture.invocations.some((invocation) => invocation.nodeId === "join")).toBe(false);
    expect(probeModels).not.toContain("par-020-join");

    writeFileSync(path.join(project, ".nodulus", "fixtures", "validator-process-state", "release-slow"), "release\n", "utf8");
    await waitFor(() => existsSync(path.join(project, ".nodulus", "fixtures", "validator-process-state", "finished-slow.json")), scenarioDeadline, scenarioAbort.signal, "slow validator completion");
    const validatorFinished = JSON.parse(readFileSync(path.join(project, ".nodulus", "fixtures", "validator-process-state", "finished-slow.json"), "utf8")) as { nodeId?: unknown; pid?: unknown };
    expect(validatorFinished).toMatchObject({ nodeId: "slow", pid: validatorPid });
    await waitForProcessExit(validatorPid, scenarioDeadline);
    await waitFor(() => readCheckpoint(project, runId).graph.nodes.slow?.phase === "accepted", scenarioDeadline, scenarioAbort.signal, "slow validated acceptance");
    await fixture.waitForStarted(["join"], scenarioAbort.signal);
    expect(joinObservations).toHaveLength(1);
    expect(joinObservations[0]).toMatchObject({ parents: { slow: { phase: "accepted" }, fast: { phase: "accepted" } } });
    const joinInvocation = fixture.invocations.find((invocation) => invocation.nodeId === "join");
    if (!joinInvocation) throw new Error(`Join invocation was not captured. ${fixture.diagnostics()}`);
    expect(joinInvocation.inputs).toEqual({ slow: { text: "done:slow" }, fast: { text: "done:fast" } });
    expect(probeModels.filter((model) => model === "par-020-join")).toHaveLength(1);

    fixture.release("join");
    await fixture.waitForFinished(["join"], scenarioAbort.signal);
    const outcome = await awaitBefore(settled, scenarioDeadline, "graph workflow completion");
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("success");
    expect(outcome.result.result).toMatchObject({
      artifacts: [
        { name: "joined", contract: "report.v1", data: { text: "done:join" } },
        { name: "fastReport", contract: "report.v1", data: { text: "done:fast" } },
        { name: "slowReport", contract: "report.v1", data: { text: "done:slow" } },
        { name: "witnessReport", contract: "report.v1", data: { text: "done:witness" } },
      ],
    });
    const checkpoint = readCheckpoint(project, runId);
    expect(checkpoint.completedNodes).toEqual(nodeIds);
    expect(Object.values(checkpoint.graph.nodes).every((state: any) => state.phase === "accepted")).toBe(true);
    expect(fixture.invocations.map(({ nodeId }) => nodeId).sort((left, right) => left.localeCompare(right))).toEqual([...nodeIds].sort((left, right) => left.localeCompare(right)));
    expect(fixture.invocations).toHaveLength(nodeIds.length);
    const expectedProbeModels = nodeIds.map((nodeId) => `par-020-${nodeId}`).sort((left, right) => left.localeCompare(right));
    expect(probeModels).toHaveLength(nodeIds.length);
    expect([...probeModels].sort((left, right) => left.localeCompare(right))).toEqual(expectedProbeModels);
    expect(fixture.hasStarted("join")).toBe(true);
    expect(fixture.hasFinished("join")).toBe(true);
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);
    for (const nodeId of nodeIds) {
      const accepted = checkpoint.graph.nodes[nodeId].accepted as AcceptedEvidence | undefined;
      if (!accepted) throw new Error(`Node '${nodeId}' is not represented by accepted evidence.`);
      verifyAcceptedEvidence(project, runId, nodeId, accepted);
    }
  } catch (error) {
    primaryError = error;
    primaryFailed = true;
  }

  let cleanupError: unknown;
  try {
    const cleanupDeadline = Date.now() + cleanupBudgetMs;
    scenarioAbort.abort(new Error("PAR-020 cleanup started."));
    clearTimeout(scenarioTimer);
    const cleanupErrors: unknown[] = [];
    if (fixture) {
      for (const nodeId of nodeIds) {
        try { fixture.release(nodeId); }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    const validatorStateDirectory = path.join(project, ".nodulus", "fixtures", "validator-process-state");
    const ownedValidatorMarker = path.join(validatorStateDirectory, "started-slow.json");
    if (existsSync(validatorStateDirectory)) {
      try { writeFileSync(path.join(validatorStateDirectory, "release-slow"), "release\n", "utf8"); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (settled) {
      try { await awaitBefore(settled, cleanupDeadline, "workflow/provider settlement"); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (fixture) {
      try { await fixture.drain(Math.max(1, cleanupDeadline - Date.now())); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (validatorPid === undefined && existsSync(ownedValidatorMarker)) {
      try {
        const marker = JSON.parse(readFileSync(ownedValidatorMarker, "utf8")) as { pid?: unknown };
        if (!Number.isInteger(marker.pid) || (marker.pid as number) <= 0) throw new Error("Refusing cleanup because the slow validator PID marker is invalid.");
        validatorPid = marker.pid as number;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (validatorPid !== undefined) {
      try { await waitForProcessExit(validatorPid, cleanupDeadline); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-020 cleanup could not confirm all owned processes settled.");
    const canonicalProject = assertOwnedProject(project);
    rmSync(canonicalProject, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (primaryFailed) {
    if (cleanupError) throw new AggregateError([primaryError, cleanupError], "PAR-020 scenario failed and cleanup also reported an error.");
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
}, testWatchdogMs);

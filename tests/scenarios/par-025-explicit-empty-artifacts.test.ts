import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runWorkflow, type ApplicationRunResult, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { runCapturedProcess } from "../../src/adapters/providers/captured-process.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type CaseId = "empty" | "unavailable" | "missing" | "invalid";
type ScenarioCase = { id: CaseId; label: string; positive: boolean };
type Outcome = { kind: "result"; result: ApplicationRunResult } | { kind: "rejection"; error: unknown };
type ArtifactReference = { name: string; contract: string; ref: string; sha256: string };
type AcceptedRecord = {
  resultRef: string;
  resultSha256: string;
  validationRef: string;
  validationSha256: string;
  responseRef: string;
  responseSha256: string;
  artifacts: ArtifactReference[];
};
type Checkpoint = {
  status: string;
  completedNodes: string[];
  graph: { nodes: Record<string, { phase?: string; accepted?: AcceptedRecord }> };
};
type ProcessRecord = { pid: number; nodeId: string; callId: string; inputs?: Record<string, unknown> };
type CapturedResult = Awaited<ReturnType<typeof runCapturedProcess>>;
type ProviderCapture = { invocation: ProviderInvocation; result: CapturedResult; process: ProcessRecord; finished: ProcessRecord; transportBytes: Buffer; entryCheckpoint: Checkpoint };

const fixturePath = fileURLToPath(new URL("../fixtures/par-025-artifact-provider.mjs", import.meta.url));
const scenarioBudgetMs = 20_000;
const sharedCleanupBudgetMs = 8_000;
const testCeilingMs = 35_000;
const scenarios: ScenarioCase[] = [
  { id: "empty", label: "explicit empty data", positive: true },
  { id: "unavailable", label: "explicit unavailable data", positive: true },
  { id: "missing", label: "missing declared artifact", positive: false },
  { id: "invalid", label: "schema-invalid artifact data", positive: false },
];

test.each(scenarios)("PAR-025 preserves $label through real graph execution", async (scenario) => {
  await runScenario(scenario);
}, testCeilingMs);

async function runScenario(scenario: ScenarioCase): Promise<void> {
  const project = createInitializedProject(`par-025-${scenario.id}-café`);
  const canonicalProject = assertOwnedProject(project);
  let outcomePromise: Promise<Outcome> | undefined;
  let provider: FixtureProvider | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];
  let safeToRemove = true;

  try {
    configureParallelProject(project);
    configureProject(project);
    provider = createFixtureProvider(project, scenario.id);
    const scenarioDeadline = Date.now() + scenarioBudgetMs;
    outcomePromise = runWorkflow(request(project), provider.provider).then(
      (result) => ({ kind: "result", result }),
      (error: unknown) => ({ kind: "rejection", error }),
    );
    const outcome = await withDeadline(outcomePromise, scenarioDeadline, `P3C ${scenario.id} workflow`);
    expect(outcome.kind, outcome.kind === "rejection" ? describeOutcome(outcome) : "").toBe("result");
    if (outcome.kind !== "result") throw outcome.error;

    const runId = outcome.result.runId;
    const runRoot = path.join(project, ".nodulus", "runs", runId);
    const checkpoint = readCheckpoint(runRoot);
    const producerCapture = provider.captures.get("producer");
    expect(producerCapture).toBeDefined();
    if (!producerCapture) throw new Error("P3C producer has no actual captured child process evidence.");
    await assertSuccessfulProcess(project, runId, "producer", producerCapture, provider.stateDirectory, scenarioDeadline);
    expect(checkpoint.graph.nodes.producer?.phase).toBe(scenario.positive ? "accepted" : "failed");
    if (scenario.positive) expect(checkpoint.graph.nodes.producer?.accepted).toBeDefined();
    else expect(checkpoint.graph.nodes.producer?.accepted).toBeUndefined();

    const producerValidationPath = path.join(runRoot, "nodes", "producer", "attempt-001", "validation.json");
    const producerResultPath = path.join(runRoot, "nodes", "producer", "attempt-001", "result.json");
    if (scenario.positive) {
      expect(checkpoint.status).toBe("success");
      expect(checkpoint.completedNodes).toEqual(["producer", "consumer"]);
      expect(checkpoint.graph.nodes.consumer?.phase).toBe("accepted");
      const producerAccepted = checkpoint.graph.nodes.producer?.accepted;
      const consumerAccepted = checkpoint.graph.nodes.consumer?.accepted;
      expect(producerAccepted).toBeDefined();
      expect(consumerAccepted).toBeDefined();
      if (!producerAccepted || !consumerAccepted) throw new Error("P3C successful graph omitted accepted producer or consumer references.");

      const producedValue = scenario.id === "empty"
        ? { kind: "empty", items: [] }
        : { kind: "unavailable", reason: "source data is unavailable" };
      const consumerText = scenario.id === "empty" ? "consumed:empty" : "consumed:unavailable";
      const producerArtifact = assertAcceptedArtifact(runRoot, producerAccepted, "artifact-state.v1", producedValue);
      expect(producerCapture.result.stdout).toContain(JSON.stringify(producedValue));
      expect(readRunReference(runRoot, producerAccepted.responseRef).toString("utf8")).toBe(producerCapture.result.stdout);

      const consumerCapture = provider.captures.get("consumer");
      expect(consumerCapture).toBeDefined();
      if (!consumerCapture) throw new Error("P3C consumer has no actual captured child process evidence.");
      await assertSuccessfulProcess(project, runId, "consumer", consumerCapture, provider.stateDirectory, scenarioDeadline);
      expect(consumerCapture.process.inputs).toEqual({ state: producedValue });
      expect(consumerCapture.entryCheckpoint.graph.nodes.producer?.phase).toBe("accepted");
      expect(consumerCapture.entryCheckpoint.graph.nodes.producer?.accepted?.artifacts).toContainEqual(producerArtifact);
      const consumerInvocation = JSON.parse(readFileSync(path.join(runRoot, "nodes", "consumer", "attempt-001", "invocation.json"), "utf8")) as {
        inputs: Record<string, unknown>;
        inputMappings: Record<string, { from?: string; contract?: string }>;
      };
      expect(consumerInvocation.inputs).toEqual({ state: producedValue });
      expect(consumerInvocation.inputMappings).toEqual({ state: { from: "producer.report", contract: "artifact-state.v1" } });

      assertAcceptedArtifact(runRoot, consumerAccepted, "report.v1", { text: consumerText });
      expect(readRunReference(runRoot, consumerAccepted.responseRef).toString("utf8")).toBe(consumerCapture.result.stdout);
      expect(provider.probeCounts).toEqual({ "profile-producer": 1, "profile-consumer": 1 });
      expect(provider.invokeCounts).toEqual({ producer: 1, consumer: 1 });
      const expectedOutputs = [
        { name: "state", contract: "artifact-state.v1", data: producedValue },
        { name: "consumerResult", contract: "report.v1", data: { text: consumerText } },
      ];
      expect(outcome.result.result).toEqual({ artifacts: expectedOutputs });
      const outputsBytes = readFileSync(path.join(runRoot, "outputs.json"));
      expect(JSON.parse(outputsBytes.toString("utf8"))).toEqual(expectedOutputs);
    } else {
      const publicError = (outcome.result.result as { error?: { code?: string; message?: string } }).error;
      expect(outcome.result.status).toBe("error");
      expect(publicError?.code).toBe("RESPONSE_REPAIR_UNAVAILABLE");
      expect(checkpoint.status).toBe("error");
      expect(checkpoint.completedNodes).toEqual([]);
      expect(checkpoint.graph.nodes.producer?.accepted).toBeUndefined();
      expect(checkpoint.graph.nodes.consumer?.phase).toBe("not_started");
      expect(provider.probeCounts).toEqual({ "profile-producer": 1 });
      expect(provider.invokeCounts).toEqual({ producer: 1 });
      expect(provider.captures.has("consumer")).toBe(false);
      expect(existsSync(path.join(provider.stateDirectory, "started-consumer.json"))).toBe(false);
      expect(existsSync(path.join(provider.stateDirectory, "finished-consumer.json"))).toBe(false);
      expect(existsSync(path.join(runRoot, "nodes", "producer", "artifacts", "report.json"))).toBe(false);
      expect(existsSync(path.join(runRoot, "outputs.json"))).toBe(false);
      expect(existsSync(producerValidationPath)).toBe(true);
      expect(existsSync(producerResultPath)).toBe(true);
      const validation = JSON.parse(readFileSync(producerValidationPath, "utf8")) as { valid?: boolean; code?: string; errors?: string[] };
      const attemptResult = JSON.parse(readFileSync(producerResultPath, "utf8")) as { status?: string; error?: { code?: string; message?: string } };
      expect(validation.valid).toBe(false);
      expect(validation.code).toBe("ARTIFACT_VALIDATION_FAILED");
      expect(attemptResult).toMatchObject({ status: "error", error: { code: "ARTIFACT_VALIDATION_FAILED" } });
      const validationCause = scenario.id === "missing" ? "Expected artifact 'report' is missing." : "violates artifact-state.v1";
      expect(validation.errors?.join("; ")).toContain(validationCause);
      expect(attemptResult.error?.message).toContain(validationCause);
      expect(publicError?.message).toContain("Safe response-only repair is unavailable");
    }
    expect(provider.captures.size).toBe(scenario.positive ? 2 : 1);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    const cleanupDeadline = Date.now() + sharedCleanupBudgetMs;
    if (outcomePromise) {
      try { await withDeadline(outcomePromise, cleanupDeadline, `P3C ${scenario.id} workflow drain`); }
      catch (error) { cleanupErrors.push(toError(error)); safeToRemove = false; }
    }
    if (provider) {
      try { await provider.drain(Math.max(1, cleanupDeadline - Date.now())); }
      catch (error) { cleanupErrors.push(toError(error)); safeToRemove = false; }
      for (const [nodeId, capture] of provider.captures) {
        if (!pidExited(capture.process.pid)) {
          cleanupErrors.push(new Error(`P3C child PID ${capture.process.pid} for '${nodeId}' is still alive.`));
          safeToRemove = false;
        }
      }
    }
    if (safeToRemove) {
      try {
        if (assertOwnedProject(project) !== canonicalProject) {
          cleanupErrors.push(new Error("P3C project identity changed before cleanup."));
          safeToRemove = false;
        } else rmSync(canonicalProject, { recursive: true, force: true });
      } catch (error) { cleanupErrors.push(toError(error)); }
    }
  }

  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([toError(primaryError), ...cleanupErrors], "P3C scenario and cleanup both failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P3C cleanup failed.");
}

type FixtureProvider = {
  provider: ProviderPort;
  stateDirectory: string;
  probeCounts: Record<string, number>;
  invokeCounts: Record<string, number>;
  captures: Map<string, ProviderCapture>;
  drain(timeoutMs: number): Promise<void>;
};

function createFixtureProvider(project: string, caseId: CaseId): FixtureProvider {
  const stateDirectory = path.join(project, ".nodulus", "fixtures", `par-025-${caseId}-state`);
  const probeCounts: Record<string, number> = {};
  const invokeCounts: Record<string, number> = {};
  const captures = new Map<string, ProviderCapture>();
  const launchByCall = new Map<string, boolean>();
  const inFlight = new Set<Promise<void>>();

  const invokeActualChild = async (invocation: ProviderInvocation): Promise<string> => {
    const nodeId = invocation.nodeId;
    if (nodeId !== "producer" && nodeId !== "consumer") throw new Error(`P3C provider received unexpected node '${nodeId}'.`);
    invokeCounts[nodeId] = (invokeCounts[nodeId] ?? 0) + 1;
    if (invokeCounts[nodeId] !== 1) throw new Error(`P3C provider action for '${nodeId}' was repeated.`);
    const callId = invocation.call?.callId;
    if (!callId) throw new Error(`P3C '${nodeId}' invocation has no public call ID.`);
    const runRoot = path.join(project, ".nodulus", "runs", invocation.runId);
    const entryCheckpoint = JSON.parse(readFileSync(path.join(runRoot, "run.json"), "utf8")) as Checkpoint;
    const result = await runCapturedProcess(process.execPath, [fixturePath], {
      cwd: project,
      stdin: JSON.stringify({ caseId, nodeId, callId, inputs: invocation.inputs, stateDirectory }),
      timeoutMs: 8_000,
      ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
    }, invocation, "invoke", null);
    launchByCall.set(callId, result.started);
    const processRecord = JSON.parse(readFileSync(path.join(stateDirectory, `started-${nodeId}.json`), "utf8")) as ProcessRecord;
    const finishedRecord = JSON.parse(readFileSync(path.join(stateDirectory, `finished-${nodeId}.json`), "utf8")) as ProcessRecord;
    if (processRecord.callId !== callId || finishedRecord.callId !== callId || processRecord.pid !== finishedRecord.pid) {
      throw new Error(`P3C '${nodeId}' process markers did not retain their actual call and PID identity.`);
    }
    const transportPath = path.join(runRoot, "calls", callId, "transport.json");
    const transportBytes = readFileSync(transportPath);
    captures.set(nodeId, { invocation, result, process: processRecord, finished: finishedRecord, transportBytes, entryCheckpoint });
    if (!result.started || result.exitCode !== 0 || result.timedOut || result.cancelled || result.outputLimitExceeded) {
      throw new Error(`P3C '${nodeId}' actual process did not exit successfully: ${result.stderr}`);
    }
    return result.stdout;
  };

  const provider: ProviderPort = {
    async isAvailable(profile) {
      const model = typeof profile.model === "string" ? profile.model : "unknown";
      probeCounts[model] = (probeCounts[model] ?? 0) + 1;
      return true;
    },
    invoke(invocation) {
      const operation = invokeActualChild(invocation);
      let tracked: Promise<void>;
      tracked = operation.then(() => undefined, () => undefined).finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
      return operation;
    },
    telemetryForCall() { return null; },
    launchForCall(callId) { return launchByCall.get(callId) ?? null; },
  };
  return {
    provider,
    stateDirectory,
    probeCounts,
    invokeCounts,
    captures,
    async drain(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (inFlight.size > 0) {
        if (Date.now() >= deadline) throw new Error(`P3C provider drain exceeded its shared cleanup deadline (${inFlight.size} active call(s)).`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

function configureProject(project: string): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["producer", "consumer"];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { producer: [], consumer: ["producer"] };
  workflow.execution.resources = { producer: [], consumer: [] };
  workflow.outputs = [
    { name: "state", from: "producer.report", contract: "artifact-state.v1" },
    { name: "consumerResult", from: "consumer.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  writeJson(project, ".nodulus/contracts/artifact-state.v1.schema.json", {
    oneOf: [
      {
        type: "object",
        required: ["kind", "items"],
        properties: { kind: { const: "empty" }, items: { type: "array" } },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["kind", "reason"],
        properties: { kind: { const: "unavailable" }, reason: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
    ],
  });
  const settings = readProjectJson(project, ".nodulus/settings.json") as { providerProfiles: Record<string, Record<string, unknown>> };
  const base = settings.providerProfiles.fixture;
  if (!base) throw new Error("P3C initialized project has no fixture provider profile.");
  settings.providerProfiles.producer = { ...base, model: "profile-producer" };
  settings.providerProfiles.consumer = { ...base, model: "profile-consumer" };
  writeJson(project, ".nodulus/settings.json", settings);
  writeNode(project, "producer", "producer", "artifact-state.v1", { request: { from: "request", contract: "request.v1" } });
  writeNode(project, "consumer", "consumer", "report.v1", { state: { from: "producer.report", contract: "artifact-state.v1" } });
}

function writeNode(project: string, nodeId: string, profileId: string, outputContract: string, inputs: Record<string, unknown>): void {
  writeJson(project, `.nodulus/nodes/${nodeId}.json`, {
    schemaVersion: 1,
    id: nodeId,
    providerProfile: profileId,
    instructions: [`.nodulus/instructions/${nodeId}.md`],
    inputs,
    expectedOutputs: [{ name: "report", contract: outputContract }],
  });
  writeFileSync(path.join(project, ".nodulus", "instructions", `${nodeId}.md`), `Instructions for ${nodeId}.\n`, "utf8");
}

function request(project: string) {
  return { projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline" as const, text: "Preserve explicit empty and unavailable artifact values." }] };
}

async function assertSuccessfulProcess(project: string, runId: string, nodeId: string, capture: ProviderCapture, stateDirectory: string, deadline: number): Promise<void> {
  expect(capture.process.nodeId).toBe(nodeId);
  expect(capture.process.callId).toBe(capture.invocation.call?.callId);
  expect(capture.finished).toMatchObject({ pid: capture.process.pid, nodeId, callId: capture.process.callId });
  await waitForPidExit(capture.process.pid, deadline);
  expect(capture.result).toMatchObject({ started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false });
  const callId = capture.process.callId;
  const transportPath = path.join(project, ".nodulus", "runs", runId, "calls", callId, "transport.json");
  const transportBytes = readFileSync(transportPath);
  expect(sha256(transportBytes)).toBe(sha256(capture.transportBytes));
  const transport = JSON.parse(transportBytes.toString("utf8")) as Record<string, unknown>;
  expect(transport).toMatchObject({ callId, started: true, exitCode: 0, timedOut: false, cancelled: false, outputLimitExceeded: false });
  expect(transport.stdout).toBe(capture.result.stdout);
  expect(JSON.parse(readFileSync(path.join(stateDirectory, `finished-${nodeId}.json`), "utf8"))).toEqual(capture.finished);
}

function assertAcceptedArtifact(runRoot: string, accepted: AcceptedRecord, contract: string, data: unknown): ArtifactReference {
  const resultBytes = readRunReference(runRoot, accepted.resultRef);
  expect(sha256(resultBytes)).toBe(accepted.resultSha256);
  expect(JSON.parse(resultBytes.toString("utf8"))).toEqual({ status: "success", artifacts: [{ name: "report", contract, data }] });
  const validationBytes = readRunReference(runRoot, accepted.validationRef);
  expect(sha256(validationBytes)).toBe(accepted.validationSha256);
  expect(JSON.parse(validationBytes.toString("utf8"))).toMatchObject({ valid: true, outcome: "success", errors: [] });
  const responseBytes = readRunReference(runRoot, accepted.responseRef);
  expect(sha256(responseBytes)).toBe(accepted.responseSha256);
  const artifact = accepted.artifacts.find((candidate) => candidate.name === "report");
  expect(artifact).toMatchObject({ name: "report", contract, sha256: expect.any(String) });
  if (!artifact) throw new Error("P3C accepted record omitted the report artifact reference.");
  const artifactBytes = readRunReference(runRoot, artifact.ref);
  expect(sha256(artifactBytes)).toBe(artifact.sha256);
  expect(JSON.parse(artifactBytes.toString("utf8"))).toEqual({ name: "report", contract, data });
  return artifact;
}

function readRunReference(runRoot: string, reference: string): Buffer {
  const resolvedRoot = path.resolve(runRoot);
  const resolved = path.resolve(runRoot, ...reference.split("/"));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`P3C accepted reference escaped its owned run root: '${reference}'.`);
  return readFileSync(resolved);
}

function readCheckpoint(runRoot: string): Checkpoint {
  return JSON.parse(readFileSync(path.join(runRoot, "run.json"), "utf8")) as Checkpoint;
}

function assertOwnedProject(project: string): string {
  const canonical = realpathSync.native(path.resolve(project));
  const canonicalTemp = realpathSync.native(os.tmpdir());
  if (path.dirname(canonical) !== canonicalTemp || !path.basename(canonical).startsWith("nodulus-par-025-")) {
    throw new Error(`Refusing cleanup outside the generated P3C project: '${canonical}'.`);
  }
  return canonical;
}

function pidExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function waitForPidExit(pid: number, deadline: number): Promise<void> {
  while (!pidExited(pid) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(pidExited(pid), `P3C captured child PID ${pid} remained alive after its real process result settled.`).toBe(true);
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

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function describeOutcome(outcome: Outcome): string {
  if (outcome.kind === "rejection") return `workflow rejected: ${outcome.error instanceof Error ? outcome.error.message : "Non-Error rejection."}`;
  const error = (outcome.result.result as { error?: { code?: string; message?: string } } | undefined)?.error;
  return `workflow returned ${outcome.result.status}: ${error?.code ?? "no error code"} ${error?.message ?? ""}`.trim();
}
function toError(error: unknown): Error { return error instanceof Error ? error : new Error("P3C cleanup failed with a non-Error value."); }

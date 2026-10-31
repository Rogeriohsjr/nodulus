import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runWorkflow, type ApplicationRunResult } from "../../src/index.js";
import { readParallelWorkflow } from "../support/parallel-project.js";
import { writeJson } from "../support/workflow-sequence.js";
import { createGraphOpenCodeFixture, type GraphOpenCodeFixture, type GraphOpenCodeNodeConfig } from "../support/graph-opencode-fixture.js";
import { createWindowsRenameForensicStorage, type WindowsRenameForensicStorage } from "../support/windows-rename-forensics.js";

type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };
type TestNode = { id: string; inputs: Record<string, unknown>; validator?: boolean };

const testWatchdogMs = 35_000;
const waitWatchdogMs = 10_000;
const validatorSource = fileURLToPath(new URL("../fixtures/par-repair-validator.mjs", import.meta.url));
const validatorRelative = ".nodulus/validators/par-repair-validator.mjs";
const forensicEnvironmentName = "NODULUS_TEST_WINDOWS_RENAME_FORENSICS_DIR";
type ForensicObserverState = {
  exportDirectory: string;
  observer?: WindowsRenameForensicStorage;
  startupFailure?: string;
  closeVerified: boolean;
};
const forensicObserversByProject = new Map<string, ForensicObserverState>();

function validOutcome(text: string): string {
  return JSON.stringify({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text } }] });
}

function malformedOutcome(nodeId: string, stage: string): string {
  return `{"node":"${nodeId}","stage":"${stage}","broken":`;
}

function schemaInvalidOutcome(nodeId: string): string {
  return JSON.stringify({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { unexpected: nodeId } }] });
}

function configureGraph(project: string, nodes: TestNode[], dependsOn: Record<string, string[]>, maxConcurrency: number): void {
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
  if (nodes.some(({ validator }) => validator)) {
    const validatorDirectory = path.join(project, ".nodulus", "validators");
    mkdirSync(validatorDirectory, { recursive: true });
    copyFileSync(validatorSource, path.join(project, validatorRelative));
    mkdirSync(path.join(validatorDirectory, "repair-validator-state"), { recursive: true });
  }
}

function request(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Exercise response-only graph repair." }],
  };
}

async function startRun(fixture: GraphOpenCodeFixture): Promise<RunOutcome> {
  let state: ForensicObserverState | undefined;
  const configuredExportDirectory = process.platform === "win32" ? process.env[forensicEnvironmentName] : undefined;
  if (configuredExportDirectory) {
    state = { exportDirectory: "", closeVerified: false };
    forensicObserversByProject.set(fixture.project, state);
    try {
      state.exportDirectory = resolveForensicExportDirectory(configuredExportDirectory);
      const reportDirectory = path.join(fixture.project, ".nodulus", "fixtures", "windows-rename-reports");
      state.observer = await createWindowsRenameForensicStorage(fixture.project, reportDirectory);
    } catch (error) {
      state.startupFailure = error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200);
      return { kind: "rejection", error };
    }
  }

  return runWorkflow(request(fixture.project), fixture.provider, state?.observer ? { storage: state.observer.storage } : {}).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

function readCheckpoint(project: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, any>;
}

function runRoot(project: string, runId: string): string {
  return path.join(project, ".nodulus", "runs", runId);
}

function describeOutcome(outcome: RunOutcome, fixture: GraphOpenCodeFixture): string {
  if (outcome.kind === "rejection") {
    const error = outcome.error as { name?: string; code?: string; message?: string };
    const message = typeof error?.message === "string" ? fixture.redact(error.message).slice(0, 1200) : "no error message";
    return `workflow rejected ${error?.code ?? error?.name ?? typeof outcome.error}: ${message}`;
  }
  const error = (outcome.result.result as any)?.error as { code?: string; message?: string } | undefined;
  return `workflow ${outcome.result.status} ${error?.code ?? "no error code"}: ${typeof error?.message === "string" ? fixture.redact(error.message).slice(0, 1200) : "no error message"}`;
}

function savedTerminalState(fixture: GraphOpenCodeFixture, nodeId: string): string | undefined {
  const runId = fixture.calls[0]?.checkpointAtEntry.runId as string | undefined;
  if (!runId) return undefined;
  try {
    const checkpoint = readCheckpoint(fixture.project, runId);
    const node = checkpoint.graph?.nodes?.[nodeId];
    if (checkpoint.status === "error") return `saved run status=error node=${nodeId} phase=${node?.phase ?? "unknown"} code=${node?.failure?.code ?? checkpoint.error?.code ?? "unknown"}`;
    if (node?.phase === "failed") return `saved node failure node=${nodeId} code=${node.failure?.code ?? "unknown"}`;
  } catch {
    return undefined;
  }
  return undefined;
}

async function waitForStartedOrSettled(
  fixture: GraphOpenCodeFixture,
  nodeId: string,
  operation: "build" | "repair",
  index: number,
  settled: Promise<RunOutcome>,
): Promise<void> {
  const deadline = Date.now() + waitWatchdogMs;
  while (!fixture.hasStarted(nodeId, operation, index)) {
    const terminal = savedTerminalState(fixture, nodeId);
    if (terminal) throw new Error(`Saved terminal error before ${nodeId}/${operation}/${index} started: ${terminal}. ${fixture.diagnostics()}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${nodeId}/${operation}/${index}. ${fixture.diagnostics()}`);
    const early = await Promise.race([
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)),
      settled.then((outcome) => ({ outcome })),
    ]);
    if (early) throw new Error(`Workflow settled before ${nodeId}/${operation}/${index} started: ${describeOutcome(early.outcome, fixture)}. ${fixture.diagnostics()}`);
  }
}

async function waitForNodeAcceptedOrSettled(
  fixture: GraphOpenCodeFixture,
  runId: string,
  nodeId: string,
  settled: Promise<RunOutcome>,
): Promise<void> {
  const deadline = Date.now() + waitWatchdogMs;
  while (readCheckpoint(fixture.project, runId).graph.nodes[nodeId]?.phase !== "accepted") {
    const terminal = savedTerminalState(fixture, nodeId);
    if (terminal) throw new Error(`Saved terminal error before ${nodeId} acceptance: ${terminal}. ${fixture.diagnostics()}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${nodeId} acceptance. ${fixture.diagnostics()}`);
    const early = await Promise.race([
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)),
      settled.then((outcome) => ({ outcome })),
    ]);
    if (early) throw new Error(`Workflow settled before ${nodeId} acceptance: ${describeOutcome(early.outcome, fixture)}. ${fixture.diagnostics()}`);
  }
}

function expectSuccess(outcome: RunOutcome): ApplicationRunResult {
  expect(outcome.kind).toBe("result");
  if (outcome.kind !== "result") throw outcome.error;
  expect(outcome.result.status).toBe("success");
  return outcome.result;
}

function expectAliases(result: ApplicationRunResult, nodes: string[], texts: Record<string, string>): void {
  expect(result.result).toEqual({ artifacts: nodes.map((nodeId) => ({ name: `${nodeId}Output`, contract: "report.v1", data: { text: texts[nodeId] } })) });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function acceptedEvidenceBytes(project: string, runId: string, accepted: Record<string, any>): Array<{ ref: string; sha256: string; bytes: Buffer }> {
  const refs = [accepted.resultRef, accepted.validationRef, accepted.responseRef, ...accepted.artifacts.map((artifact: Record<string, string>) => artifact.ref)] as string[];
  return refs.map((ref) => {
    const bytes = readFileSync(path.join(runRoot(project, runId), ...ref.split("/")));
    return { ref, sha256: sha256(bytes), bytes };
  });
}

function verifyPerCallMetrics(project: string, runId: string, fixture: GraphOpenCodeFixture): void {
  const runDirectory = runRoot(project, runId);
  const metrics = JSON.parse(readFileSync(path.join(runDirectory, "metrics.json"), "utf8")) as Array<Record<string, any>>;
  const events = readFileSync(path.join(runDirectory, "events.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, any>);
  expect(metrics).toHaveLength(fixture.calls.length);
  for (const call of fixture.calls) {
    const metric = metrics.find((item) => item.callId === call.callId);
    expect(metric, `metric missing call ${call.callId}`).toBeDefined();
    const operation = call.method === "invoke" ? "build" : "repair";
    const operationIndex = call.method === "invoke" ? 0 : call.callAttempt - 1;
    const fixtureOperation = fixture.operation(call.nodeId, operation, call.method === "invoke" ? 1 : operationIndex);
    const usageIndex = ["alpha", "beta", "gamma"].indexOf(call.nodeId) * 10 + operationIndex;
    const reportedInput = 101 + usageIndex;
    const reportedOutput = 31 + usageIndex;
    expect(metric).toMatchObject({
      nodeId: call.nodeId,
      callId: call.callId,
      attempt: call.callAttempt,
      operation: call.method,
      usage: {
        inputTokens: reportedInput + fixtureOperation.usage.cache.read + fixtureOperation.usage.cache.write,
        outputTokens: reportedOutput + fixtureOperation.usage.reasoning,
        cacheReadTokens: fixtureOperation.usage.cache.read,
        costUsd: fixtureOperation.usage.cost,
      },
    });
    const started = events.find((event) => event.event === "provider.call.started" && event.callId === call.callId);
    const completed = events.find((event) => event.event === "provider.call.completed" && event.callId === call.callId);
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    const savedRequest = JSON.parse(readFileSync(path.join(runDirectory, "calls", call.callId, "request.json"), "utf8")) as Record<string, unknown>;
    expect(savedRequest).toMatchObject({
      callId: call.callId,
      attempt: call.callAttempt,
      operation: call.method,
      parentCallId: call.parentCallId,
    });
  }
}

async function waitForRepairValidatorExit(project: string): Promise<void> {
  const directory = path.join(project, ".nodulus", "validators", "repair-validator-state");
  if (!existsSync(directory)) return;
  const records = readdirSync(directory).filter((name) => /^validator-\d+\.json$/.test(name)).map((name) => {
    const record = JSON.parse(readFileSync(path.join(directory, name), "utf8")) as { pid?: unknown };
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) throw new Error(`Validator record '${name}' has an invalid PID.`);
    return record.pid;
  });
  const deadline = Date.now() + 12_000;
  while (records.some(isProcessAlive)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for repair validator PIDs ${JSON.stringify(records)}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function cleanupFixture(fixture: GraphOpenCodeFixture, settled: Promise<RunOutcome>): Promise<void> {
  const cleanupErrors: unknown[] = [];
  let providersSafe = true;
  try { fixture.releaseAll(); }
  catch (error) { cleanupErrors.push(error); providersSafe = false; }
  try {
    const outcome = await settled;
    if (outcome.kind === "rejection" || outcome.result.status !== "success") process.stderr.write(`[PAR-013 cleanup] ${describeOutcome(outcome, fixture)}\n`);
  } catch (error) { cleanupErrors.push(error); providersSafe = false; }
  try { await fixture.drain(); }
  catch (error) { cleanupErrors.push(error); providersSafe = false; }
  try { fixture.validateProcessIds(); }
  catch (error) { cleanupErrors.push(error); providersSafe = false; }
  try { await fixture.waitForProcessesExit(); }
  catch (error) { cleanupErrors.push(error); providersSafe = false; }
  try { await waitForRepairValidatorExit(fixture.project); }
  catch (error) { cleanupErrors.push(error); providersSafe = false; }

  const observerState = forensicObserversByProject.get(fixture.project);
  let helperClosed = observerState === undefined;
  let exportComplete = observerState === undefined;
  if (observerState) {
    if (!observerState.observer) {
      cleanupErrors.push(new Error(`Forensic prewarm did not return a close handle; retaining project '${fixture.project}'. ${observerState.startupFailure ?? "No startup detail was recorded."}`));
    } else {
      try {
        await observerState.observer.close();
        observerState.closeVerified = true;
        helperClosed = true;
      } catch (error) {
        cleanupErrors.push(new Error(`Forensic helper close was not verified; retaining project '${fixture.project}': ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (helperClosed && observerState.closeVerified) {
      try {
        copyForensicReports(observerState, fixture);
        exportComplete = true;
      } catch (error) { cleanupErrors.push(new Error(`Forensic metadata export failed; retaining project '${fixture.project}': ${error instanceof Error ? error.message : String(error)}`)); }
    }
  }
  if (!providersSafe) cleanupErrors.push(new Error(`Provider or validator shutdown was not verified; retaining project '${fixture.project}'.`));
  if (!helperClosed) cleanupErrors.push(new Error(`Forensic helper shutdown was not verified; retaining project '${fixture.project}'.`));
  if (!exportComplete) cleanupErrors.push(new Error(`Forensic metadata export was not verified; retaining project '${fixture.project}'.`));

  if (providersSafe && helperClosed && exportComplete) {
    try {
      await fixture.cleanup();
      forensicObserversByProject.delete(fixture.project);
    } catch (error) { cleanupErrors.push(new Error(`Fixture cleanup did not complete; retain diagnostics for '${fixture.project}': ${error instanceof Error ? error.message : String(error)}`)); }
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, `P13A cleanup could not verify safe removal of '${fixture.project}'.`);
}

function resolveForensicExportDirectory(configured: string): string {
  const repositoryRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const allowedRoot = path.join(repositoryRoot, ".nodulus", "checkpoints", "parallel-phase2");
  const canonicalAllowedRoot = realpathSync(allowedRoot);
  if (!isInside(repositoryRoot, canonicalAllowedRoot)) throw new Error("Repository checkpoint root resolves outside the repository.");
  const configuredPath = path.resolve(configured);
  const canonicalConfiguredPath = realpathSync(configuredPath);
  if (!statSync(canonicalConfiguredPath).isDirectory()) throw new Error(`${forensicEnvironmentName} must name an existing directory.`);
  if (!isInside(canonicalAllowedRoot, canonicalConfiguredPath)) {
    throw new Error(`${forensicEnvironmentName} must resolve inside '${canonicalAllowedRoot}'.`);
  }
  return canonicalConfiguredPath;
}

function copyForensicReports(state: ForensicObserverState, fixture: GraphOpenCodeFixture): void {
  const capturedReports = state.observer?.reports.map((report) => ({
    runId: report.runId.slice(0, 64),
    target: report.target.slice(0, 1024),
    status: report.status,
    reason: report.reason?.slice(0, 1200),
    queryError: report.queryError?.slice(0, 1200),
    observedFailure: report.observedFailure === undefined ? undefined : {
      code: report.observedFailure.code,
      message: report.observedFailure.message.slice(0, 1200),
    },
    targetEvidence: report.targetEvidence === undefined ? undefined : {
      sha256: report.targetEvidence.sha256.slice(0, 64),
      type: report.targetEvidence.type.slice(0, 32),
      attributes: report.targetEvidence.attributes,
      size: report.targetEvidence.size,
      owner: report.targetEvidence.owner?.slice(0, 256),
      aclSha256: report.targetEvidence.aclSha256?.slice(0, 64),
    },
    deleteAccessProbe: report.deleteAccessProbe,
    restartManager: report.restartManager === undefined ? undefined : {
      processes: report.restartManager.processes.slice(0, 128).map((process) => ({
        pid: process.pid,
        applicationName: process.applicationName?.slice(0, 256),
        processStartFileTime: process.processStartFileTime?.slice(0, 64),
      })),
    },
    temporaryEvidence: report.temporaryEvidence?.slice(0, 32),
  })) ?? [];
  const payload = {
    format: "nodulus-p12f2-windows-rename-observation-v1",
    fixture: path.basename(fixture.project).slice(0, 128),
    observerProcessId: process.pid,
    probeProcessId: state.observer?.probeProcessId,
    captureTimestamp: null,
    captureTimestampNote: "The F1 probe report does not include a capture timestamp.",
    copiedAt: new Date().toISOString(),
    reports: capturedReports,
  };
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > 64 * 1024) throw new Error("Forensic metadata report exceeded the 64 KiB export bound; retaining project.");
  const outputPath = path.join(state.exportDirectory, `p12f2-${randomUUID()}.json`);
  writeFileSync(outputPath, contents, { encoding: "utf8", flag: "wx" });
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function config(sessionId: string, buildRaw: string, repairRaw: string[] = []): GraphOpenCodeNodeConfig {
  return { sessionId, buildRaw, repairRaw };
}

test("PAR-013 isolates concurrent OpenCode repairs and per-call usage across graph branches", async () => {
  const fixture = await createGraphOpenCodeFixture({
    alpha: config("alpha-session", malformedOutcome("alpha", "build"), [validOutcome("alpha-corrected")]),
    beta: config("beta-session", malformedOutcome("beta", "build"), [malformedOutcome("beta", "repair-1"), validOutcome("beta-corrected")]),
    gamma: config("gamma-session", validOutcome("gamma-final")),
  }, { deliveryWave: true });
  configureGraph(fixture.project, [
    { id: "alpha", inputs: { request: { from: "request", contract: "request.v1" } } },
    { id: "beta", inputs: { request: { from: "request", contract: "request.v1" } } },
    { id: "gamma", inputs: { request: { from: "request", contract: "request.v1" } } },
  ], { alpha: [], beta: [], gamma: [] }, 2);
  const settled = startRun(fixture);
  try {
    await waitForStartedOrSettled(fixture, "alpha", "build", 1, settled);
    await waitForStartedOrSettled(fixture, "beta", "build", 1, settled);
    fixture.release("beta", "build");
    await fixture.waitForFinished("beta", "build");
    await fixture.waitForAdapterSettled(["beta"]);
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    await fixture.waitForAdapterSettled(["alpha", "beta"]);
    fixture.releaseDeliveryWave();

    await waitForStartedOrSettled(fixture, "alpha", "repair", 1, settled);
    await waitForStartedOrSettled(fixture, "beta", "repair", 1, settled);
    fixture.release("beta", "repair", 1);
    await fixture.waitForFinished("beta", "repair", 1);
    await waitForStartedOrSettled(fixture, "beta", "repair", 2, settled);
    fixture.release("beta", "repair", 2);
    await fixture.waitForFinished("beta", "repair", 2);

    const runId = fixture.calls[0]?.checkpointAtEntry.runId as string | undefined;
    expect(runId).toBeDefined();
    await waitForNodeAcceptedOrSettled(fixture, runId as string, "beta", settled);
    await waitForStartedOrSettled(fixture, "gamma", "build", 1, settled);
    const gammaCall = fixture.calls.find((call) => call.nodeId === "gamma" && call.method === "invoke");
    expect(gammaCall?.checkpointAtEntry.graph.nodes).toMatchObject({
      alpha: { phase: "active" },
      beta: { phase: "accepted" },
      gamma: { phase: "active" },
    });
    const betaState = readCheckpoint(fixture.project, runId as string).graph.nodes.beta;
    const betaEvidence = acceptedEvidenceBytes(fixture.project, runId as string, betaState.accepted);

    fixture.release("gamma", "build");
    await fixture.waitForFinished("gamma", "build");
    fixture.release("alpha", "repair", 1);
    await fixture.waitForFinished("alpha", "repair", 1);
    const result = expectSuccess(await settled);
    expectAliases(result, ["alpha", "beta", "gamma"], { alpha: "alpha-corrected", beta: "beta-corrected", gamma: "gamma-final" });

    expect(fixture.calls).toHaveLength(6);
    expect(new Set(fixture.calls.map(({ callId }) => callId)).size).toBe(6);
    expect(fixture.calls.filter(({ nodeId }) => nodeId === "alpha").map(({ callAttempt }) => callAttempt).sort((left, right) => left - right)).toEqual([1, 2]);
    expect(fixture.calls.filter(({ nodeId }) => nodeId === "beta").map(({ callAttempt }) => callAttempt).sort((left, right) => left - right)).toEqual([1, 2, 3]);
    expect(fixture.calls.filter(({ nodeId }) => nodeId === "gamma").map(({ callAttempt }) => callAttempt)).toEqual([1]);
    for (const nodeId of ["alpha", "beta", "gamma"]) {
      expect(fixture.operations().filter((operation) => operation.nodeId === nodeId && operation.operation === "build")).toHaveLength(1);
      expect(fixture.actionExists(nodeId)).toBe(true);
    }
    for (const call of fixture.calls) {
      expect(call.invocationAttempt).toBe(1);
      const expectedParent = call.callAttempt === 1 ? null : fixture.calls.find((candidate) => candidate.nodeId === call.nodeId && candidate.callAttempt === call.callAttempt - 1)?.callId;
      expect(call.parentCallId).toBe(expectedParent);
      if (call.method === "repair_response") {
        const operation = fixture.operation(call.nodeId, "repair", call.callAttempt - 1);
        expect(operation.argv).toContain("--agent");
        expect(operation.argv[operation.argv.indexOf("--agent") + 1]).toBe("nodulus-response");
        expect(operation.argv[operation.argv.indexOf("--session") + 1]).toBe(`${call.nodeId}-session`);
      }
    }
    verifyPerCallMetrics(fixture.project, result.runId, fixture);
    for (const prior of betaEvidence) {
      const bytes = readFileSync(path.join(runRoot(fixture.project, result.runId), ...prior.ref.split("/")));
      expect(sha256(bytes)).toBe(prior.sha256);
      expect(bytes.equals(prior.bytes)).toBe(true);
    }
  } finally {
    await cleanupFixture(fixture, settled);
  }
}, testWatchdogMs);

test("PAR-013 corrects a schema-invalid artifact without repeating its action", async () => {
  const fixture = await createGraphOpenCodeFixture({
    alpha: config("alpha-session", schemaInvalidOutcome("alpha"), [validOutcome("schema-corrected")]),
  });
  configureGraph(fixture.project, [{ id: "alpha", inputs: { request: { from: "request", contract: "request.v1" } } }], { alpha: [] }, 1);
  const settled = startRun(fixture);
  try {
    await waitForStartedOrSettled(fixture, "alpha", "build", 1, settled);
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    await waitForStartedOrSettled(fixture, "alpha", "repair", 1, settled);
    fixture.release("alpha", "repair", 1);
    await fixture.waitForFinished("alpha", "repair", 1);
    const result = expectSuccess(await settled);
    expectAliases(result, ["alpha"], { alpha: "schema-corrected" });
    expect(fixture.actionExists("alpha")).toBe(true);
    expect(fixture.operations().filter((operation) => operation.nodeId === "alpha" && operation.operation === "build")).toHaveLength(1);
    expect(fixture.calls.map(({ method }) => method)).toEqual(["invoke", "repair_response"]);
  } finally {
    await cleanupFixture(fixture, settled);
  }
}, testWatchdogMs);

test("PAR-013 reruns the real validator against the corrected artifact without replaying the action", async () => {
  const fixture = await createGraphOpenCodeFixture({
    alpha: config("alpha-session", validOutcome("reject-me"), [validOutcome("accepted:alpha")]),
  });
  configureGraph(fixture.project, [{ id: "alpha", inputs: { request: { from: "request", contract: "request.v1" } }, validator: true }], { alpha: [] }, 1);
  const settled = startRun(fixture);
  try {
    await waitForStartedOrSettled(fixture, "alpha", "build", 1, settled);
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    await waitForStartedOrSettled(fixture, "alpha", "repair", 1, settled);
    fixture.release("alpha", "repair", 1);
    await fixture.waitForFinished("alpha", "repair", 1);
    const result = expectSuccess(await settled);
    expectAliases(result, ["alpha"], { alpha: "accepted:alpha" });
    const validatorDirectory = path.join(fixture.project, ".nodulus", "validators", "repair-validator-state");
    const validatorRecords = readdirSync(validatorDirectory).filter((name) => /^validator-\d+\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(path.join(validatorDirectory, name), "utf8")) as { index: number; artifact: { text: string } });
    expect(validatorRecords.map(({ artifact }) => artifact.text)).toEqual(["reject-me", "accepted:alpha"]);
    expect(validatorRecords.map(({ index }) => index)).toEqual([1, 2]);
    expect(fixture.actionExists("alpha")).toBe(true);
    expect(fixture.operations().filter((operation) => operation.operation === "build")).toHaveLength(1);
  } finally {
    await cleanupFixture(fixture, settled);
  }
}, testWatchdogMs);

test("PAR-013 exhausts two isolated corrections without accepting the node or starting its successor", async () => {
  const fixture = await createGraphOpenCodeFixture({
    alpha: config("alpha-session", malformedOutcome("alpha", "build"), [malformedOutcome("alpha", "repair-1"), malformedOutcome("alpha", "repair-2")]),
    successor: config("successor-session", validOutcome("must-not-run")),
  });
  configureGraph(fixture.project, [
    { id: "alpha", inputs: { request: { from: "request", contract: "request.v1" } } },
    { id: "successor", inputs: { report: { from: "alpha.report", contract: "report.v1" } } },
  ], { alpha: [], successor: ["alpha"] }, 2);
  const settled = startRun(fixture);
  try {
    await waitForStartedOrSettled(fixture, "alpha", "build", 1, settled);
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    await waitForStartedOrSettled(fixture, "alpha", "repair", 1, settled);
    fixture.release("alpha", "repair", 1);
    await fixture.waitForFinished("alpha", "repair", 1);
    await waitForStartedOrSettled(fixture, "alpha", "repair", 2, settled);
    fixture.release("alpha", "repair", 2);
    await fixture.waitForFinished("alpha", "repair", 2);

    const outcome = await settled;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("error");
    expect((outcome.result.result as any).error.code).toBe("REPAIR_EXHAUSTED");
    expect(fixture.calls).toHaveLength(3);
    const callsByAttempt = [...fixture.calls].sort((left, right) => left.callAttempt - right.callAttempt);
    expect(callsByAttempt.map(({ callAttempt }) => callAttempt)).toEqual([1, 2, 3]);
    expect(callsByAttempt[0]).toMatchObject({ method: "invoke", invocationAttempt: 1, parentCallId: null });
    expect(callsByAttempt[1]?.parentCallId).toBe(callsByAttempt[0]?.callId);
    expect(callsByAttempt[2]?.parentCallId).toBe(callsByAttempt[1]?.callId);
    expect(callsByAttempt.slice(1).map(({ invocationAttempt }) => invocationAttempt)).toEqual([1, 1]);
    for (const call of callsByAttempt.slice(1)) {
      const operation = fixture.operation("alpha", "repair", call.callAttempt - 1);
      expect(operation.argv[operation.argv.indexOf("--session") + 1]).toBe("alpha-session");
      expect(operation.argv[operation.argv.indexOf("--agent") + 1]).toBe("nodulus-response");
    }
    expect(fixture.operations().filter((operation) => operation.nodeId === "alpha" && operation.operation === "build")).toHaveLength(1);
    expect(fixture.operations().filter((operation) => operation.nodeId === "alpha" && operation.operation === "repair")).toHaveLength(2);
    expect(fixture.actionExists("alpha")).toBe(true);
    expect(fixture.actionExists("successor")).toBe(false);
    const runId = fixture.calls[0]?.checkpointAtEntry.runId as string | undefined;
    expect(runId).toBeDefined();
    expect(readCheckpoint(fixture.project, runId as string).graph.nodes.alpha.phase).not.toBe("accepted");
    expect(fixture.hasStarted("successor", "build")).toBe(false);
  } finally {
    await cleanupFixture(fixture, settled);
  }
}, testWatchdogMs);

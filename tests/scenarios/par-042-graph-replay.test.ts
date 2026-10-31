import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { replaySavedRun } from "../../src/application/replay-run.js";
import { runWorkflow, type ApplicationRunResult, type ProviderPort } from "../../src/application/run-workflow.js";
import { observeOwnedNativeProcesses } from "../support/owned-native-processes.js";
import { createGraphOpenCodeFixture, type GraphOpenCodeFixture } from "../support/graph-opencode-fixture.js";
import { observeReadStorage } from "../support/read-only-storage-observer.js";
import { cleanupProviderProject } from "../support/provider-adapter-scenarios.js";
import { readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type JsonRecord = Record<string, unknown>;
type ReplayResult = Record<string, unknown>;
type Settlement = { kind: "result"; result: ApplicationRunResult } | { kind: "rejection"; error: unknown };
type ProviderCounts = {
  isAvailable: number;
  invoke: number;
  repairResponse: number;
  usageForLastCall: number;
  telemetryForCall: number;
  launchForCall: number;
};
type FileRow = { relative: string; kind: "directory" | "file"; size: number; sha256?: string };
type ReplayState = {
  fixture: GraphOpenCodeFixture;
  native: ReturnType<typeof observeOwnedNativeProcesses>;
  runSettlement: Promise<Settlement>;
  runSettled: () => boolean;
  runId: string;
  runDirectory: string;
  validatorLog: string;
  validatorPath: string;
  forbiddenValidatorMarker: string;
  providerCounts: ProviderCounts;
  pendingWork: Set<Promise<void>>;
  scenarioDeadline: number;
};

const scenarioLimitMs = 20_000;
const cleanupLimitMs = 10_000;
const caseLimitMs = 35_000;
const fixtureLimitMs = 60_000;
const validatorRelative = ".nodulus/validators/par-repair-validator.mjs";
const validatorStateRelative = ".nodulus/validators/repair-validator-state";
const validatorFixtureSource = fileURLToPath(new URL("../fixtures/par-repair-validator.mjs", import.meta.url));

test("PAR042 distinguishes verified acceptance from schema-valid candidates and ignores current schema or validator drift", async () => {
  await withRejectedCandidateRun("intact", async (state) => {
    const initial = await readReplay(state);
    assertCandidate(initial, "audit", "accepted");
    assertCandidate(initial, "candidate", "not_accepted");
    expect(initial).toMatchObject({ schemaVersion: 1, runId: state.runId, mode: "schema-only" });
    expect(asRecord(initial.skipped, "initial skipped work").providerCalls).toBe(true);
    expect(await readReplay(state)).toEqual(initial);

    const currentSchemaPath = path.join(state.fixture.project, ".nodulus", "contracts", "report.v1.schema.json");
    writeFileSync(currentSchemaPath, `${JSON.stringify({
      type: "object",
      required: ["replacement"],
      properties: { replacement: { type: "boolean" } },
      additionalProperties: false,
    })}\n`, "utf8");
    writeFileSync(state.validatorPath, forbiddenValidatorSource(state.forbiddenValidatorMarker), "utf8");

    const drifted = await readReplay(state);
    const driftAudit = assertCandidate(drifted, "audit", "accepted");
    const driftCandidate = assertCandidate(drifted, "candidate", "not_accepted");
    expect(driftAudit.valid).toBe(true);
    expect(driftCandidate.valid).toBe(true);
    expect(asArray(drifted.drift, "schema drift")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "contract-schema", contract: "report.v1" }),
    ]));
    const skipped = asRecord(drifted.skipped, "drifted skipped work");
    expect(skipped.providerCalls).toBe(true);
    expect(asArray(skipped.executableValidators, "skipped validators")).toContain(validatorRelative);
    expect(existsSync(state.forbiddenValidatorMarker)).toBe(false);
    expect(readFileSync(state.validatorLog).equals(state.validatorLogBytes)).toBe(true);
    expect(await readReplay(state)).toEqual(drifted);
  });
}, caseLimitMs);

test("PAR042 marks changed response and corrupted accepted evidence unverified while preserving unrelated candidates", async () => {
  await withRejectedCandidateRun("integrity", async (state) => {
    const initial = await readReplay(state);
    assertCandidate(initial, "audit", "accepted");
    assertCandidate(initial, "candidate", "not_accepted");

    const checkpoint = readJsonFile(path.join(state.runDirectory, "run.json"));
    const graph = asRecord(checkpoint.graph, "integrity checkpoint graph");
    const nodes = asRecord(graph.nodes, "integrity checkpoint nodes");
    const auditNode = asRecord(nodes.audit, "integrity audit node");
    const accepted = asRecord(auditNode.accepted, "integrity audit acceptance");
    const responsePath = safeRunPath(state.runDirectory, accepted.responseRef);
    const originalResponse = readFileSync(responsePath);
    const response = JSON.parse(originalResponse.toString("utf8")) as JsonRecord;
    const responseArtifacts = asArray(response.artifacts, "audit response artifacts");
    const responseArtifact = asRecord(responseArtifacts[0], "audit response artifact");
    responseArtifact.data = { text: "accepted:audit-mutated-with-valid-schema" };
    writeFileSync(responsePath, JSON.stringify(response), "utf8");

    const changedResponse = await readReplay(state);
    const changedAudit = assertCandidate(changedResponse, "audit", "unverified");
    expect(changedAudit.valid).toBe(true);
    assertCandidate(changedResponse, "candidate", "not_accepted");
    expect(diagnostics(changedResponse).join(" ")).toMatch(/response|hash|acceptance|evidence/i);
    writeFileSync(responsePath, originalResponse);

    const artifactRows = asArray(accepted.artifacts, "accepted audit artifacts");
    const artifact = asRecord(artifactRows[0], "accepted audit artifact");
    const artifactPath = safeRunPath(state.runDirectory, artifact.ref);
    const originalArtifact = readFileSync(artifactPath);
    const alteredArtifact = Buffer.from(originalArtifact);
    const originalText = Buffer.from("accepted:audit", "utf8");
    const changedText = Buffer.from("x ccepted:audit".replace(" ", ""), "utf8");
    const textOffset = alteredArtifact.indexOf(originalText);
    if (textOffset < 0) throw new Error("Saved audit artifact did not contain its expected schema-valid text.");
    changedText.copy(alteredArtifact, textOffset);
    writeFileSync(artifactPath, alteredArtifact);

    const corruptedArtifact = await readReplay(state);
    const corruptedAudit = assertCandidate(corruptedArtifact, "audit", "unverified");
    expect(corruptedAudit.valid).toBe(true);
    assertCandidate(corruptedArtifact, "candidate", "not_accepted");
    expect(diagnostics(corruptedArtifact).join(" ")).toMatch(/artifact|hash|acceptance|evidence/i);
    writeFileSync(artifactPath, originalArtifact);

    const restored = await readReplay(state);
    assertCandidate(restored, "audit", "accepted");
    assertCandidate(restored, "candidate", "not_accepted");
  });
}, caseLimitMs);

async function withRejectedCandidateRun(
  label: string,
  assertions: (state: ReplayState & { validatorLogBytes: Buffer }) => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  const scenarioDeadline = startedAt + scenarioLimitMs;
  const fixtureDeadline = startedAt + fixtureLimitMs;
  let fixture: GraphOpenCodeFixture | undefined;
  let native: ReturnType<typeof observeOwnedNativeProcesses> | undefined;
  let runSettlement: Promise<Settlement> | undefined;
  let runSettled = false;
  let runId: string | undefined;
  let runDirectory: string | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let stateForAssertions: (ReplayState & { validatorLogBytes: Buffer }) | undefined;
  const pendingWork = new Set<Promise<void>>();

  try {
    fixture = await createGraphOpenCodeFixture(replayFixtureConfigurations());
    configureReplayGraph(fixture);
    const settings = asRecord(readProjectJson(fixture.project, ".nodulus/settings.json"), "settings");
    const profiles = asRecord(settings.providerProfiles, "provider profiles");
    const profile = asRecord(profiles.fixture, "fixture profile");
    expect(profile.capabilities).toEqual([]);

    native = observeOwnedNativeProcesses();
    const providerCounts = emptyProviderCounts();
    const provider = observeProvider(fixture.provider, providerCounts);
    const runPromise = runWorkflow({
      projectRoot: fixture.project,
      cwd: fixture.project,
      workflow: "example",
      sources: [{ kind: "inline", text: `PAR042 ${label} replay request` }],
    }, provider);
    runSettlement = runPromise.then<Settlement, Settlement>(
      (result) => { runSettled = true; return { kind: "result", result }; },
      (error: unknown) => { runSettled = true; return { kind: "rejection", error }; },
    );

    await withinDeadline(trackPending(fixture.waitForStarted("audit", "build", 1, remaining(scenarioDeadline)), pendingWork), scenarioDeadline, "audit provider start");
    expect(fixture.hasStarted("candidate", "build")).toBe(false);
    fixture.release("audit", "build");
    await withinDeadline(trackPending(fixture.waitForFinished("audit", "build", 1, remaining(scenarioDeadline)), pendingWork), scenarioDeadline, "audit provider finish");
    await withinDeadline(trackPending(fixture.waitForAdapterSettled(["audit"], remaining(scenarioDeadline)), pendingWork), scenarioDeadline, "audit adapter settlement");
    await withinDeadline(trackPending(fixture.waitForStarted("candidate", "build", 1, remaining(scenarioDeadline)), pendingWork), scenarioDeadline, "candidate provider start");

    const runIdFromCall = fixture.calls.find((call) => call.nodeId === "audit")?.checkpointAtEntry.runId;
    if (typeof runIdFromCall !== "string") throw new Error("The real audit invocation did not capture a run ID.");
    runId = runIdFromCall;
    runDirectory = path.join(fixture.project, ".nodulus", "runs", runId);
    const duringCandidate = readJsonFile(path.join(runDirectory, "run.json"));
    const duringGraph = asRecord(duringCandidate.graph, "active graph checkpoint");
    const duringNodes = asRecord(duringGraph.nodes, "active graph nodes");
    expect(asRecord(duringNodes.audit, "active audit node").phase).toBe("accepted");
    expect(asRecord(duringNodes.candidate, "active candidate node").phase).toBe("active");
    const candidateCall = fixture.calls.find((call) => call.nodeId === "candidate");
    if (!candidateCall) throw new Error("Candidate invocation was not recorded by the real provider wrapper.");
    expect(asRecord(candidateCall.checkpointAtEntry.graph, "candidate entry graph").nodes).toMatchObject({ audit: { phase: "accepted" } });

    fixture.release("candidate", "build");
    await withinDeadline(trackPending(fixture.waitForFinished("candidate", "build", 1, remaining(scenarioDeadline)), pendingWork), scenarioDeadline, "candidate provider finish");
    await withinDeadline(trackPending(fixture.waitForAdapterSettled(["candidate"], remaining(scenarioDeadline)), pendingWork), scenarioDeadline, "candidate adapter settlement");
    const settlement = await withinDeadline(runSettlement, scenarioDeadline, "rejected candidate run settlement");
    if (settlement.kind === "rejection") throw new Error(`Graph run rejected unexpectedly: ${errorSummary(settlement.error)}`, { cause: settlement.error });
    expect(settlement.result.status).toBe("error");
    const publicError = asRecord(asRecord(settlement.result.result, "run result").error, "run error");
    expect(publicError.code).toBe("RESPONSE_REPAIR_UNAVAILABLE");

    expect(fixture.calls.map(({ nodeId, method, callAttempt }) => [nodeId, method, callAttempt])).toEqual([
      ["audit", "invoke", 1],
      ["candidate", "invoke", 1],
    ]);
    expect(fixture.calls.every((call) => call.adapterSettled)).toBe(true);
    expect(providerCounts.invoke).toBe(2);
    expect(providerCounts.repairResponse).toBe(0);
    expect(fixture.operations().map(({ nodeId, operation }) => `${nodeId}:${operation}`).sort((left, right) => left.localeCompare(right)))
      .toEqual(["audit:build", "candidate:build"]);
    fixture.validateProcessIds();
    expect(native.observationFailure).toBe(false);
    expect(native.diagnostics.length).toBeGreaterThanOrEqual(3);
    expect(native.diagnostics.every((record) => record.stages.includes("spawn") && record.stages.includes("close"))).toBe(true);

    const checkpoint = readJsonFile(path.join(runDirectory, "run.json"));
    expect(checkpoint.status).toBe("error");
    expect(asArray(checkpoint.completedNodes, "completed nodes")).toContain("audit");
    const graph = asRecord(checkpoint.graph, "saved graph checkpoint");
    const nodes = asRecord(graph.nodes, "saved graph nodes");
    const auditNode = asRecord(nodes.audit, "saved audit node");
    const candidateNode = asRecord(nodes.candidate, "saved candidate node");
    expect(auditNode.phase).toBe("accepted");
    expect(candidateNode.phase).toBe("failed");
    expect(candidateNode.accepted).toBeUndefined();
    const accepted = asRecord(auditNode.accepted, "saved audit acceptance");
    expect(accepted.attempt).toBe(1);
    expect(accepted.callId).toBe(fixture.calls[0]?.callId);
    const acceptedArtifactRows = asArray(accepted.artifacts, "audit accepted artifacts");
    expect(acceptedArtifactRows).toHaveLength(1);
    const acceptedArtifact = asRecord(acceptedArtifactRows[0], "audit artifact manifest");
    expect(acceptedArtifact).toMatchObject({ name: "report", contract: "report.v1", ref: "nodes/audit/artifacts/report.json" });
    assertSavedHash(runDirectory, accepted.resultRef, accepted.resultSha256);
    assertSavedHash(runDirectory, accepted.validationRef, accepted.validationSha256);
    assertSavedHash(runDirectory, accepted.responseRef, accepted.responseSha256);
    assertSavedHash(runDirectory, acceptedArtifact.ref, acceptedArtifact.sha256);
    const acceptedResult = readJsonFile(safeRunPath(runDirectory, accepted.resultRef));
    expect(acceptedResult).toMatchObject({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "accepted:audit" } }] });
    expect(readJsonFile(safeRunPath(runDirectory, accepted.validationRef))).toMatchObject({ valid: true, outcome: "success" });
    expect(readJsonFile(safeRunPath(runDirectory, acceptedArtifact.ref))).toMatchObject({ name: "report", contract: "report.v1", data: { text: "accepted:audit" } });
    expect(readJsonFile(safeRunPath(runDirectory, accepted.responseRef))).toMatchObject({ status: "success", artifacts: [{ data: { text: "accepted:audit" } }] });

    const candidateCallId = candidateCall.callId;
    const candidateResponse = readJsonFile(path.join(runDirectory, "nodes", "candidate", "attempt-001", "response.raw.txt"));
    expect(candidateResponse).toMatchObject({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "rejected:candidate" } }] });
    expect(readJsonFile(path.join(runDirectory, "nodes", "candidate", "attempt-001", "validation.json")))
      .toMatchObject({ valid: false, code: "ARTIFACT_REJECTED" });
    expect(readJsonFile(path.join(runDirectory, "nodes", "candidate", "attempt-001", "result.json")))
      .toMatchObject({ status: "error", error: { code: "ARTIFACT_REJECTED" } });
    const definitions = readJsonFile(path.join(runDirectory, "context", "definitions.json"));
    const definitionWorkflow = asRecord(definitions.workflow, "captured workflow");
    expect(definitionWorkflow).toMatchObject({
      nodes: ["audit", "candidate"],
      outputs: [{ name: "auditSummary", from: "audit.report", contract: "report.v1" }],
      execution: { kind: "dag", maxConcurrency: 1, dependsOn: { audit: [], candidate: [] }, resources: { audit: [], candidate: [] } },
    });
    const capturedProfiles = asRecord(definitions.providerProfiles, "captured provider profiles");
    expect(asRecord(capturedProfiles.fixture, "captured fixture profile").capabilities).toEqual([]);

    const eventRows = readJsonLines(path.join(runDirectory, "events.jsonl"));
    assertContiguousSequences(eventRows);
    const auditAccepted = eventRows.find((event) => event.event === "node.accepted" && event.nodeId === "audit" && event.callId === accepted.callId);
    const candidateStarted = eventRows.find((event) => event.event === "provider.call.started" && event.nodeId === "candidate" && event.callId === candidateCallId);
    const candidateCompleted = eventRows.find((event) => event.event === "provider.call.completed" && event.nodeId === "candidate" && event.callId === candidateCallId);
    const candidateFailed = eventRows.find((event) => event.event === "node.failed" && event.nodeId === "candidate");
    expect(auditAccepted).toBeDefined();
    expect(candidateStarted).toBeDefined();
    expect(candidateCompleted).toBeDefined();
    expect(candidateFailed).toBeDefined();
    expect(sequenceOf(auditAccepted)).toBeLessThan(sequenceOf(candidateStarted));
    expect(sequenceOf(candidateStarted)).toBeLessThan(sequenceOf(candidateCompleted));
    expect(sequenceOf(candidateCompleted)).toBeLessThan(sequenceOf(candidateFailed));
    expect(eventRows.some((event) => event.event === "node.accepted" && event.nodeId === "candidate")).toBe(false);

    const validatorStateDirectory = path.join(fixture.project, validatorStateRelative);
    const validatorFiles = readdirSync(validatorStateDirectory).filter((name) => /^validator-[0-9]+\.json$/.test(name));
    expect(validatorFiles).toEqual(["validator-1.json"]);
    const validatorRecord = readJsonFile(path.join(validatorStateDirectory, "validator-1.json"));
    expect(validatorRecord).toMatchObject({ index: 1, artifact: { text: "rejected:candidate" } });
    const validatorPid = validatorRecord.pid;
    if (typeof validatorPid !== "number" || !Number.isSafeInteger(validatorPid) || validatorPid <= 0) {
      throw new Error("The real response validator did not record a valid process ID.");
    }
    expect(native.diagnostics.some((record) => record.pid === validatorPid && record.stages.includes("spawn") && record.stages.includes("close"))).toBe(true);
    const validatorPath = path.join(fixture.project, validatorRelative);
    const validatorLog = path.join(validatorStateDirectory, "validator-1.json");
    const validatorLogBytes = readFileSync(validatorLog);
    stateForAssertions = {
      fixture,
      native,
      runSettlement,
      runSettled: () => runSettled,
      runId,
      runDirectory,
      validatorLog,
      validatorPath,
      forbiddenValidatorMarker: path.join(fixture.project, ".nodulus", "fixtures", `par042-${label}-validator-ran.txt`),
      providerCounts,
      pendingWork,
      scenarioDeadline,
      validatorLogBytes,
    };
    await assertions(stateForAssertions);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupLimitMs;
  const cleanupErrors: Error[] = [];
  if (fixture) {
    try { fixture.releaseAll(); }
    catch (error) { cleanupErrors.push(asError(error)); }
  }
  if (runSettlement) {
    try { await withinDeadline(runSettlement, cleanupDeadline, "workflow settlement during cleanup"); }
    catch (error) { cleanupErrors.push(asError(error)); }
  }
  while (pendingWork.size > 0 && Date.now() < cleanupDeadline) {
    try { await withinDeadline(Promise.all([...pendingWork]), cleanupDeadline, "replay fixture/query work settlement during cleanup"); }
    catch (error) { cleanupErrors.push(asError(error)); break; }
  }
  if (pendingWork.size > 0) {
    cleanupErrors.push(new Error(`PAR042 ${label} retained ${pendingWork.size} tracked fixture or replay operation(s) without confirmed settlement.`));
  }
  if (fixture) {
    try { await fixture.drain(Math.max(1, cleanupDeadline - Date.now())); }
    catch (error) { cleanupErrors.push(asError(error)); }
  }
  if (native) {
    try { await native.drain(cleanupDeadline); }
    catch (error) { cleanupErrors.push(asError(error)); }
  }

  if (!hasPrimaryError && Date.now() > fixtureDeadline) {
    hasPrimaryError = true;
    primaryError = new Error(`PAR042 ${label} exceeded its fixture lifetime.`);
  }
  const nativeClosed = native !== undefined && !native.observationFailure && native.diagnostics.every((record) => record.stages.includes("close"));
  const adapterSettled = fixture !== undefined && fixture.calls.every((call) => call.adapterSettled);
  if (fixture && !hasPrimaryError && cleanupErrors.length === 0 && runSettled && nativeClosed && adapterSettled) {
    try { cleanupProviderProject(fixture.project); }
    catch (error) { cleanupErrors.push(asError(error)); }
  } else if (fixture && !hasPrimaryError && cleanupErrors.length === 0) {
    cleanupErrors.push(new Error(`PAR042 retained ${path.basename(fixture.project)} because run, provider, or native process settlement was not confirmed.`));
  }

  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], `PAR042 ${label} replay test and cleanup both failed; owned project retained.`);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `PAR042 ${label} cleanup failed; owned project retained.`);
}

async function readReplay(state: ReplayState): Promise<ReplayResult> {
  const before = captureReadOnlyState(state);
  const observer = observeReadStorage();
  const query = trackPending(replaySavedRun(state.fixture.project, state.runId, observer.storage), state.pendingWork);
  const result = await withinDeadline(query, state.scenarioDeadline, "schema-only replay");
  expect(observer.mutations).toEqual({ createRun: 0, writeRunFiles: 0, acquireRunLock: 0, releaseRunLock: 0 });
  expect(captureReadOnlyState(state)).toEqual(before);
  return result;
}

function captureReadOnlyState(state: ReplayState): string {
  return JSON.stringify({
    run: snapshotTree(state.runDirectory),
    nodulus: snapshotTree(path.join(state.fixture.project, ".nodulus")),
    calls: state.fixture.calls,
    operations: state.fixture.operations(),
    providerCounts: state.providerCounts,
    validatorLogBytes: readFileSync(state.validatorLog).toString("base64"),
    native: state.native.diagnostics,
    nativeObservationFailure: state.native.observationFailure,
  });
}

function configureReplayGraph(fixture: GraphOpenCodeFixture): void {
  const workflow = readParallelWorkflow(fixture.project);
  workflow.nodes = ["audit", "candidate"];
  workflow.execution = {
    kind: "dag",
    maxConcurrency: 1,
    dependsOn: { audit: [], candidate: [] },
    resources: { audit: [], candidate: [] },
  };
  workflow.outputs = [{ name: "auditSummary", from: "audit.report", contract: "report.v1" }];
  writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);

  writeGraphNode(fixture.project, "audit", undefined);
  writeGraphNode(fixture.project, "candidate", validatorRelative);
  const validatorDirectory = path.join(fixture.project, validatorStateRelative);
  mkdirSync(validatorDirectory, { recursive: true });
  copyFileSync(validatorFixtureSource, path.join(fixture.project, validatorRelative));

  const settings = asRecord(readProjectJson(fixture.project, ".nodulus/settings.json"), "provider settings");
  const profiles = asRecord(settings.providerProfiles, "settings profiles");
  const profile = asRecord(profiles.fixture, "settings fixture profile");
  profile.capabilities = [];
  writeJson(fixture.project, ".nodulus/settings.json", settings);
}

function writeGraphNode(project: string, nodeId: string, validator: string | undefined): void {
  const outputs = [{ name: "report", contract: "report.v1", ...(validator === undefined ? {} : { validator }) }];
  writeJson(project, `.nodulus/nodes/${nodeId}.json`, {
    schemaVersion: 1,
    id: nodeId,
    providerProfile: "fixture",
    instructions: [`.nodulus/instructions/${nodeId}.md`],
    inputs: { request: { from: "request", contract: "request.v1" } },
    expectedOutputs: outputs,
  });
  writeFileSync(path.join(project, ".nodulus", "instructions", `${nodeId}.md`), `Return a report for ${nodeId}.\n`, "utf8");
}

function replayFixtureConfigurations(): Parameters<typeof createGraphOpenCodeFixture>[0] {
  const outcome = (text: string) => JSON.stringify({
    status: "success",
    artifacts: [{ name: "report", contract: "report.v1", data: { text } }],
  });
  return {
    audit: { sessionId: "par042_audit_session", buildRaw: outcome("accepted:audit"), repairRaw: [] },
    candidate: { sessionId: "par042_candidate_session", buildRaw: outcome("rejected:candidate"), repairRaw: [] },
  };
}

function forbiddenValidatorSource(marker: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, "executed");`,
    'process.stdout.write(JSON.stringify({ valid: true, errors: [] }));',
    "",
  ].join("\n");
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
      if (!actual.repairResponse) return Promise.reject(new Error("Actual OpenCode adapter has no repair method."));
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

function trackPending<T>(operation: Promise<T>, pending: Set<Promise<void>>): Promise<T> {
  let tracked: Promise<void>;
  tracked = operation.then(() => undefined, () => undefined).then(() => { pending.delete(tracked); });
  pending.add(tracked);
  return operation;
}

async function withinDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error(`PAR042 scenario deadline expired before ${label}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`PAR042 scenario deadline expired during ${label}.`)), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function snapshotTree(root: string): FileRow[] {
  const output: FileRow[] = [];
  let totalBytes = 0;
  const maxEntries = 2_048;
  const maxBytes = 8 * 1024 * 1024;
  const visit = (absolute: string, relative: string): void => {
    if (output.length >= maxEntries) throw new Error(`PAR042 snapshot entry limit exceeded at '${relative}'.`);
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) throw new Error(`PAR042 snapshot refuses symbolic link '${relative}'.`);
    if (stats.isDirectory()) {
      output.push({ relative, kind: "directory", size: 0 });
      for (const name of readdirSync(absolute).sort((left, right) => left.localeCompare(right))) {
        visit(path.join(absolute, name), relative ? path.join(relative, name) : name);
      }
      return;
    }
    if (!stats.isFile()) throw new Error(`PAR042 snapshot refuses unsupported entry '${relative}'.`);
    totalBytes += stats.size;
    if (totalBytes > maxBytes) throw new Error(`PAR042 snapshot byte limit exceeded at '${relative}'.`);
    const bytes = readFileSync(absolute);
    if (bytes.byteLength !== stats.size) throw new Error(`PAR042 observed unstable file size for '${relative}'.`);
    output.push({ relative, kind: "file", size: stats.size, sha256: sha256(bytes) });
  };
  visit(root, "");
  return output;
}

function assertCandidate(replay: ReplayResult, nodeId: string, status: "accepted" | "not_accepted" | "unverified"): JsonRecord {
  const candidates = asArray(replay.candidates, "replay candidates").map((value) => asRecord(value, "replay candidate"));
  const matching = candidates.filter((candidate) => candidate.nodeId === nodeId && candidate.name === "report");
  expect(matching).toHaveLength(1);
  const [candidate] = matching;
  expect(candidate).toMatchObject({ nodeId, attempt: 1, name: "report", contract: "report.v1", valid: true, acceptanceStatus: status });
  return candidate;
}

function diagnostics(replay: ReplayResult): string[] {
  return asArray(replay.diagnostics, "replay diagnostics").filter((value): value is string => typeof value === "string");
}

function assertSavedHash(runDirectory: string, refValue: unknown, hashValue: unknown): void {
  if (typeof refValue !== "string" || typeof hashValue !== "string" || !/^[a-f0-9]{64}$/.test(hashValue)) {
    throw new Error("PAR042 accepted manifest contained a malformed reference or SHA-256 value.");
  }
  const target = safeRunPath(runDirectory, refValue);
  expect(sha256(readFileSync(target))).toBe(hashValue);
}

function safeRunPath(runDirectory: string, referenceValue: unknown): string {
  if (typeof referenceValue !== "string" || referenceValue.includes("\\") || referenceValue.startsWith("/") || /^[A-Za-z]:/.test(referenceValue)) {
    throw new Error("PAR042 refused a noncanonical saved run reference.");
  }
  const target = path.resolve(runDirectory, referenceValue);
  const relative = path.relative(runDirectory, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("PAR042 saved run reference escaped its owned run directory.");
  }
  return target;
}

function readJsonFile(file: string): JsonRecord {
  return asRecord(JSON.parse(readFileSync(file, "utf8")) as unknown, `JSON file '${path.basename(file)}'`);
}

function readJsonLines(file: string): JsonRecord[] {
  return readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.length > 0)
    .map((line, index) => asRecord(JSON.parse(line) as unknown, `event line ${index + 1}`));
}

function assertContiguousSequences(events: JsonRecord[]): void {
  const sequences = events.map((event) => event.sequence);
  expect(sequences.every((sequence) => typeof sequence === "number" && Number.isSafeInteger(sequence))).toBe(true);
  const values = sequences as number[];
  expect(new Set(values).size).toBe(values.length);
  for (let index = 1; index < values.length; index += 1) expect(values[index]).toBe((values[index - 1] as number) + 1);
}

function sequenceOf(event: JsonRecord | undefined): number {
  const sequence = event?.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence)) throw new Error("PAR042 expected event sequence was missing.");
  return sequence;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`PAR042 ${label} was not an object.`);
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`PAR042 ${label} was not an array.`);
  return value;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyProviderCounts(): ProviderCounts {
  return { isAvailable: 0, invoke: 0, repairResponse: 0, usageForLastCall: 0, telemetryForCall: 0, launchForCall: 0 };
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(errorSummary(error)); }

function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 800)}`;
  return "Unexpected non-Error rejection.";
}

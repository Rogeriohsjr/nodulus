import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { resumeWorkflow, runWorkflow, type ApplicationRunResult } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type PendingCase = "two-questions" | "terminal-error";
type RunOutcome = { kind: "result"; result: ApplicationRunResult } | { kind: "rejection"; error: unknown };
type FixtureEvent = { stage: string; role: string; pid: number; atMs: number; nodeId?: string; runId?: string; callId?: string; attempt?: number };
type ProviderMarker = { role: string; nodeId: string; runId: string; callId: string; attempt: number; pid: number };
type PendingRequest = { id: string; nodeId: string; attempt: number; callId: string; questions: Array<{ id: string; message: string }>; answerContract: Record<string, unknown> };
type CheckpointNode = { phase?: string; attempt?: number; callId?: string; launch?: boolean | null; accepted?: AcceptedRecord };
type AcceptedRecord = {
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
type PendingIndex = { nodeId: string | null; kind: string; attempt: number; requestRef: string; requestSha256: string };
type GraphCheckpoint = {
  runId: string;
  status: string;
  graph: {
    admissionClosed: boolean;
    nodes: Record<string, CheckpointNode>;
    pendingRequests: Record<string, PendingIndex>;
  };
};
type CapturedFile = { bytes: Buffer; sha256: string };
type SeedEvidence = { accepted: AcceptedRecord; files: Map<string, CapturedFile> };
type QuestionEvidence = { request: PendingRequest; files: Map<string, CapturedFile> };

const fixtureSource = fileURLToPath(new URL("../fixtures/par-030-graph-provider.mjs", import.meta.url));
const roles = ["seed", "b", "a", "queued"] as const;
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 35_000;
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;

test("PAR-030 persists A as pending while B drains, then returns both requests in B/A order", async () => {
  await exercisePendingDrain("two-questions");
}, testCeilingMs);

test("PAR-030 retains A's pending request when B errors and rejects resume without mutation", async () => {
  await exercisePendingDrain("terminal-error");
}, testCeilingMs);

async function exercisePendingDrain(testCase: PendingCase): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = `par-030-pending-drain-${testCase}`;
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const stateDirectory = path.join(fixtureDirectory, "par-030-state");
  const eventsPath = path.join(stateDirectory, "events.jsonl");
  const controlPath = path.join(fixtureDirectory, "par-030-control.json");
  const startedPaths = Object.fromEntries(roles.map((role) => [role, path.join(stateDirectory, `${role}.started.json`)])) as Record<(typeof roles)[number], string>;
  const releasePaths = Object.fromEntries(roles.map((role) => [role, path.join(stateDirectory, `release-${role}`)])) as Record<(typeof roles)[number], string>;
  const cleanupErrors: Error[] = [];
  let run: Promise<RunOutcome> | undefined;
  let observedOutcome: RunOutcome | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;

  try {
    assertOwnedProject(project, projectIdentity, label);
    const sentinels = configureProject(project, testCase, eventsPath, stateDirectory, controlPath, startedPaths, releasePaths);
    assertScenarioTime(scenarioDeadline, "project setup");
    const provider = createDefaultProviderPort(project);
    run = runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Exercise ordered, concurrent clarification and branch-error persistence." }],
    }, provider).then(
      (result) => ({ kind: "result", result }),
      (error: unknown) => ({ kind: "rejection", error }),
    );
    void run.then((outcome) => { observedOutcome = outcome; });

    const seedMarker = await waitForMarker(startedPaths.seed, "seed inference", scenarioDeadline, () => observedOutcome);
    const bMarkerPromise = waitForMarker(startedPaths.b, "B inference", scenarioDeadline, () => observedOutcome);
    const aMarkerPromise = waitForMarker(startedPaths.a, "A inference", scenarioDeadline, () => observedOutcome);
    const seedAccepted = await waitForSeedAccepted(project, seedMarker.runId, scenarioDeadline, () => observedOutcome);
    const [bMarker, aMarker] = await Promise.all([bMarkerPromise, aMarkerPromise]);
    expect(seedMarker.runId).toBe(bMarker.runId);
    expect(seedMarker.runId).toBe(aMarker.runId);
    expect(seedAccepted.accepted.callId).toBe(seedMarker.callId);
    expect(bMarker).toMatchObject({ role: "b", nodeId: "b", attempt: 1 });
    expect(aMarker).toMatchObject({ role: "a", nodeId: "a", attempt: 1 });
    expect(isProcessAlive(bMarker.pid), "B's real provider child must remain alive until its gate is released.").toBe(true);
    expect(isProcessAlive(aMarker.pid), "A's real provider child must overlap B before either gate is released.").toBe(true);
    assertAcceptedBeforeChildren(project, seedMarker.runId, seedAccepted.accepted, [aMarker, bMarker]);

    writeFileSync(releasePaths.a, "release\n", { encoding: "utf8", flag: "wx" });
    const aEvidence = await waitForQuestionEvidence(project, seedMarker.runId, aMarker, scenarioDeadline, () => observedOutcome);
    expect(aEvidence.request.id).not.toBe("provider-untrusted-a");
    expect(isUuid(aEvidence.request.id)).toBe(true);
    const intermediate = await waitForAdmissionClosed(project, seedMarker.runId, scenarioDeadline, () => observedOutcome);
    const bAliveAtIntermediate = isProcessAlive(bMarker.pid);
    expect(bAliveAtIntermediate, "B's physical provider child must still be held when the intermediate checkpoint is captured.").toBe(true);
    expect(intermediate.status).toBe("running");
    expect(intermediate.graph.nodes.b).toMatchObject({ phase: "active", callId: bMarker.callId, attempt: 1 });

    writeFileSync(releasePaths.b, "release\n", { encoding: "utf8", flag: "wx" });
    const completion = await awaitRun(run, scenarioDeadline, "public graph result", () => observedOutcome);
    if (completion.kind === "rejection") throw completion.error;
    const result = completion.result;
    expect(result.runId).toBe(seedMarker.runId);
    assertInteractions(readFixtureEvents(eventsPath));
    assertTransport(project, result.runId, aMarker);
    assertTransport(project, result.runId, bMarker);
    assertTransport(project, result.runId, seedMarker);
    assertSeedEvidenceUnchanged(project, result.runId, seedAccepted);
    assertQuestionEvidenceUnchanged(project, result.runId, aEvidence);
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);

    if (testCase === "two-questions") {
      expect(result.status).toBe("needs_input");
      const pendingResult = result.result as { request?: PendingRequest; requests?: PendingRequest[] };
      expect(pendingResult.requests?.map((request) => request.nodeId)).toEqual(["b", "a"]);
      expect(pendingResult.request).toEqual(pendingResult.requests?.[0]);
      const bQuestion = await waitForQuestionEvidence(project, result.runId, bMarker, scenarioDeadline, () => observedOutcome);
      expect(pendingResult.requests).toHaveLength(2);
      expect(pendingResult.requests?.[0]).toEqual(bQuestion.request);
      expect(pendingResult.requests?.[1]).toEqual(aEvidence.request);
      expect(bQuestion.request.id).not.toBe("provider-untrusted-b");
      expect(isUuid(bQuestion.request.id)).toBe(true);
      assertPendingProjection(project, result.runId, bQuestion);
      assertPendingProjection(project, result.runId, aEvidence);
      const finalCheckpoint = readCheckpoint(project, result.runId);
      expect(finalCheckpoint.graph.pendingRequests[bQuestion.request.id]).toMatchObject({ nodeId: "b", kind: "node", attempt: 1 });
      expect(finalCheckpoint.graph.pendingRequests[aEvidence.request.id]).toMatchObject({ nodeId: "a", kind: "node", attempt: 1 });
      expect(finalCheckpoint.graph.nodes.b.phase).toBe("pending");
      expect(finalCheckpoint.graph.nodes.a.phase).toBe("pending");

      // Check the captured intermediate projection last so the completed B/A order remains a baseline control.
      assertPendingProjectionFromCheckpoint(intermediate, aEvidence);
      expect(intermediate.graph.nodes.a).toMatchObject({ phase: "pending", callId: aMarker.callId, attempt: 1 });
    } else {
      expect(result.status).toBe("error");
      const terminalError = (result.result as { error?: { code?: string; message?: string; nodeId?: string; callId?: string; launch?: boolean } }).error;
      expect(terminalError).toMatchObject({ code: "P4_BRANCH_FAILED", message: expect.any(String), nodeId: "b", callId: bMarker.callId, launch: true });
      const finalCheckpoint = readCheckpoint(project, result.runId);
      expect(finalCheckpoint.status).toBe("error");
      expect(readJson(path.join(project, ".nodulus", "runs", result.runId, "result.json"))).toMatchObject({ status: "error", error: { code: "P4_BRANCH_FAILED", nodeId: "b", callId: bMarker.callId } });
      expect(finalCheckpoint.graph.nodes.b).toMatchObject({ phase: "failed", callId: bMarker.callId, failure: { code: "P4_BRANCH_FAILED" } });
      assertSeedEvidenceUnchanged(project, result.runId, seedAccepted);
      assertQuestionEvidenceUnchanged(project, result.runId, aEvidence);

      const treeBeforeResume = snapshotRunTree(project, result.runId);
      const eventsBeforeResume = readFixtureEvents(eventsPath);
      let resumeError: unknown;
      try {
        await resumeWorkflow({
          projectRoot: project,
          runId: result.runId,
          requestId: aEvidence.request.id,
          answers: { answer: "A answer" },
        }, provider);
      } catch (error) { resumeError = error; }
      expect(resumeError).toMatchObject({ code: "RUN_NOT_PAUSED" });
      expect(snapshotRunTree(project, result.runId)).toEqual(treeBeforeResume);
      expect(readFixtureEvents(eventsPath)).toEqual(eventsBeforeResume);

      // Terminal error and no-resume-mutation controls precede this expected pending-diagnostic assertion.
      assertPendingProjection(project, result.runId, aEvidence);
      expect(finalCheckpoint.graph.nodes.a.phase).toBe("pending");
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  for (const role of roles) {
    try {
      mkdirSync(path.dirname(releasePaths[role]), { recursive: true });
      if (!existsSync(releasePaths[role])) writeFileSync(releasePaths[role], "cleanup release\n", { flag: "wx" });
    } catch (error) { if (!isAlreadyExists(error)) cleanupErrors.push(asError(error)); }
  }

  let runSettled = run === undefined || observedOutcome !== undefined;
  if (run) {
    try {
      observedOutcome ??= await withDeadline(run, cleanupDeadline, "public graph run cleanup");
      runSettled = true;
    } catch (error) { cleanupErrors.push(asError(error)); }
  }
  let inferenceProcessesExited = false;
  try {
    const ownedPids = readStartedInferencePids(startedPaths);
    inferenceProcessesExited = await waitForPids(ownedPids, cleanupDeadline);
  } catch (error) { cleanupErrors.push(asError(error)); }

  if (runSettled && inferenceProcessesExited) {
    try {
      if (!hasPrimaryError) {
        assertOwnedProject(project, projectIdentity, label);
        rmSync(project, { recursive: true, force: true });
      }
    } catch (error) { cleanupErrors.push(asError(error)); }
  } else {
    cleanupErrors.push(new Error(`P4A project retained because run or owned inference processes did not settle: ${project}`));
  }

  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "P4A scenario failed and cleanup also reported errors.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P4A cleanup failed.");
}

function configureProject(
  project: string,
  testCase: PendingCase,
  eventsPath: string,
  stateDirectory: string,
  controlPath: string,
  startedPaths: Record<(typeof roles)[number], string>,
  releasePaths: Record<(typeof roles)[number], string>,
): { providerSentinel: string; validatorSentinel: string } {
  const sentinels = configureParallelProject(project);
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const projectFixture = path.join(fixtureDirectory, "par-030-graph-provider.mjs");
  writeFileSync(projectFixture, readFileSync(fixtureSource, "utf8"), "utf8");
  writeFileSync(controlPath, JSON.stringify({
    case: testCase,
    eventsPath: path.relative(project, eventsPath),
    fixtureLifetimeMs,
    startedPaths: Object.fromEntries(roles.map((role) => [role, path.relative(project, startedPaths[role])])),
    releasePaths: Object.fromEntries(roles.map((role) => [role, path.relative(project, releasePaths[role])])),
  }), "utf8");

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  const baseProfile = profiles.fixture ?? {};
  for (const role of roles) {
    const wrapper = path.join(fixtureDirectory, process.platform === "win32" ? `par-030-${role}.cmd` : `par-030-${role}.sh`);
    if (process.platform === "win32") {
      writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-030-graph-provider.mjs" "${role}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    } else {
      writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-030-graph-provider.mjs' '${role}' "$@"\n`, "utf8");
      chmodSync(wrapper, 0o755);
    }
    profiles[role] = {
      ...baseProfile,
      enabled: true,
      executable: wrapper,
      kind: "codex",
      model: `p4-${role}`,
      timeoutMs: profileTimeoutMs,
      capabilities: [],
      sandbox: "read-only",
    };
  }
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = [...roles];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { seed: [], b: ["seed"], a: ["seed"], queued: [] };
  workflow.execution.resources = { seed: ["seed-queued-exclusive"], b: [], a: [], queued: ["seed-queued-exclusive"] };
  workflow.outputs = roles.map((nodeId) => ({ name: `${nodeId}Result`, from: `${nodeId}.report`, contract: "report.v1" }));
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  const template = readProjectJson(project, ".nodulus/nodes/prepare.json");
  for (const nodeId of roles) {
    const instruction = `.nodulus/instructions/${nodeId}.md`;
    writeFileSync(path.join(project, instruction), `P4A local fixture instructions for ${nodeId}.\n`, "utf8");
    const inputs = nodeId === "b" || nodeId === "a"
      ? { report: { from: "seed.report", contract: "report.v1" } }
      : { request: { from: "request", contract: "request.v1" } };
    writeJson(project, `.nodulus/nodes/${nodeId}.json`, {
      ...template,
      id: nodeId,
      providerProfile: nodeId,
      instructions: [instruction],
      inputs,
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
  }
  return sentinels;
}

function assertInteractions(events: FixtureEvent[]): void {
  const probes = events.filter((event) => event.stage === "version" || event.stage === "readiness");
  expect(probes).toHaveLength(12);
  expect(probes.filter((event) => event.stage === "version")).toHaveLength(6);
  expect(probes.filter((event) => event.stage === "readiness")).toHaveLength(6);
  for (const role of ["seed", "b", "a"]) {
    expect(probes.filter((event) => event.role === role)).toHaveLength(4);
  }
  expect(events.some((event) => event.role === "queued")).toBe(false);
  const inferenceStarts = events.filter((event) => event.stage === "inference-started");
  expect(inferenceStarts.map((event) => event.role).sort((left, right) => left.localeCompare(right))).toEqual(["a", "b", "seed"]);
  expect(events.filter((event) => event.stage === "inference-completed")).toHaveLength(3);
}

function assertAcceptedBeforeChildren(project: string, runId: string, seed: AcceptedRecord, children: ProviderMarker[]): void {
  const events = readRunEvents(project, runId);
  const accepted = events.find((event) => event.event === "node.accepted" && event.nodeId === "seed");
  expect(accepted?.callId).toBe(seed.callId);
  for (const marker of children) {
    const started = events.find((event) => event.event === "provider.call.started" && event.nodeId === marker.nodeId && event.callId === marker.callId);
    expect(started).toBeDefined();
    expect(started!.sequence).toBeGreaterThan(accepted!.sequence as number);
  }
}

async function waitForSeedAccepted(project: string, runId: string, deadline: number, getOutcome: () => RunOutcome | undefined): Promise<SeedEvidence> {
  await waitForCondition(() => {
    try { return readCheckpoint(project, runId).graph.nodes.seed?.phase === "accepted"; }
    catch { return false; }
  }, deadline, "seed acceptance", getOutcome);
  return captureSeedEvidence(project, runId);
}

function captureSeedEvidence(project: string, runId: string): SeedEvidence {
  const checkpoint = readCheckpoint(project, runId);
  const accepted = checkpoint.graph.nodes.seed?.accepted;
  if (!accepted) throw new Error("P4A seed was accepted without its durable evidence manifest.");
  const expected = new Map<string, string>([
    [accepted.resultRef, accepted.resultSha256],
    [accepted.validationRef, accepted.validationSha256],
    [accepted.responseRef, accepted.responseSha256],
    ...accepted.artifacts.map((artifact) => [artifact.ref, artifact.sha256] as [string, string]),
  ]);
  const files = new Map<string, CapturedFile>();
  for (const [reference, expectedHash] of expected) {
    const bytes = readFileSync(path.join(project, ".nodulus", "runs", runId, reference));
    const sha256 = digest(bytes);
    expect(sha256).toBe(expectedHash);
    files.set(reference, { bytes, sha256 });
  }
  return { accepted: JSON.parse(JSON.stringify(accepted)) as AcceptedRecord, files };
}

function assertSeedEvidenceUnchanged(project: string, runId: string, snapshot: SeedEvidence): void {
  const current = readCheckpoint(project, runId).graph.nodes.seed?.accepted;
  expect(current).toEqual(snapshot.accepted);
  for (const [reference, captured] of snapshot.files) {
    const bytes = readFileSync(path.join(project, ".nodulus", "runs", runId, reference));
    expect(digest(bytes)).toBe(captured.sha256);
    expect(bytes.equals(captured.bytes)).toBe(true);
  }
}

async function waitForQuestionEvidence(project: string, runId: string, marker: ProviderMarker, deadline: number, getOutcome: () => RunOutcome | undefined): Promise<QuestionEvidence> {
  const resultRelative = `nodes/${marker.nodeId}/attempt-001/result.json`;
  const resultPath = path.join(project, ".nodulus", "runs", runId, resultRelative);
  await waitForCondition(() => existsSync(resultPath), deadline, `${marker.nodeId} saved needs_input result`, getOutcome);
  const resultBytes = readFileSync(resultPath);
  const savedResult = JSON.parse(resultBytes.toString("utf8")) as { status?: string; request?: PendingRequest };
  if (savedResult.status !== "needs_input" || !savedResult.request) throw new Error(`P4A ${marker.nodeId} result did not save a needs_input request.`);
  const request = savedResult.request;
  expect(request).toMatchObject({ nodeId: marker.nodeId, attempt: marker.attempt, callId: marker.callId });
  const validationRelative = `nodes/${marker.nodeId}/attempt-001/validation.json`;
  const requestRelative = `pending/${request.id}.json`;
  await waitForCondition(() => existsSync(path.join(project, ".nodulus", "runs", runId, requestRelative)), deadline, `${marker.nodeId} pending request file`, getOutcome);
  const validationBytes = readFileSync(path.join(project, ".nodulus", "runs", runId, validationRelative));
  const requestBytes = readFileSync(path.join(project, ".nodulus", "runs", runId, requestRelative));
  expect(JSON.parse(validationBytes.toString("utf8"))).toEqual({ valid: true, outcome: "needs_input", errors: [] });
  expect(JSON.parse(requestBytes.toString("utf8"))).toEqual(request);
  return {
    request,
    files: new Map([
      [resultRelative, { bytes: resultBytes, sha256: digest(resultBytes) }],
      [validationRelative, { bytes: validationBytes, sha256: digest(validationBytes) }],
      [requestRelative, { bytes: requestBytes, sha256: digest(requestBytes) }],
    ]),
  };
}

function assertQuestionEvidenceUnchanged(project: string, runId: string, snapshot: QuestionEvidence): void {
  for (const [reference, captured] of snapshot.files) {
    const bytes = readFileSync(path.join(project, ".nodulus", "runs", runId, reference));
    expect(digest(bytes)).toBe(captured.sha256);
    expect(bytes.equals(captured.bytes)).toBe(true);
  }
}

function assertPendingProjection(project: string, runId: string, evidence: QuestionEvidence): void {
  assertPendingProjectionFromCheckpoint(readCheckpoint(project, runId), evidence);
}

function assertPendingProjectionFromCheckpoint(checkpoint: GraphCheckpoint, evidence: QuestionEvidence): void {
  const request = evidence.request;
  const requestRef = `pending/${request.id}.json`;
  const savedRequest = evidence.files.get(requestRef);
  if (!savedRequest) throw new Error(`P4A ${request.nodeId} request evidence was not captured.`);
  expect(checkpoint.graph.pendingRequests[request.id]).toMatchObject({
    nodeId: request.nodeId,
    kind: "node",
    attempt: request.attempt,
    requestRef,
    requestSha256: savedRequest.sha256,
  });
}

function assertTransport(project: string, runId: string, marker: ProviderMarker): void {
  const transport = readJson(path.join(project, ".nodulus", "runs", runId, "calls", marker.callId, "transport.json"));
  expect(transport).toMatchObject({ callId: marker.callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
}

async function waitForAdmissionClosed(project: string, runId: string, deadline: number, getOutcome: () => RunOutcome | undefined): Promise<GraphCheckpoint> {
  await waitForCondition(() => {
    try {
      const checkpoint = readCheckpoint(project, runId);
      return checkpoint.graph.admissionClosed && readRunEvents(project, runId).some((event) => event.event === "graph.admission.closed");
    } catch { return false; }
  }, deadline, "committed graph admission closure", getOutcome);
  return readCheckpoint(project, runId);
}

async function waitForMarker(file: string, description: string, deadline: number, getOutcome: () => RunOutcome | undefined): Promise<ProviderMarker> {
  await waitForCondition(() => existsSync(file), deadline, description, getOutcome);
  const marker = readJson(file) as unknown as ProviderMarker;
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0 || typeof marker.runId !== "string" || typeof marker.callId !== "string" || typeof marker.nodeId !== "string") {
    throw new Error(`P4A ${description} marker has invalid provider identity.`);
  }
  return marker;
}

async function waitForCondition(predicate: () => boolean, deadline: number, description: string, getOutcome: () => RunOutcome | undefined): Promise<void> {
  while (!predicate()) {
    const early = getOutcome();
    if (early) {
      if (early.kind === "rejection") throw early.error;
      throw new Error(`P4A public run completed before ${description}.`);
    }
    assertScenarioTime(deadline, description);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function awaitRun(run: Promise<RunOutcome>, deadline: number, description: string, getOutcome: () => RunOutcome | undefined): Promise<RunOutcome> {
  const current = getOutcome();
  if (current) return current;
  return withDeadline(run, deadline, description);
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`P4A shared deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`P4A shared deadline expired during ${description}.`)), remaining); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function readStartedInferencePids(startedPaths: Record<(typeof roles)[number], string>): number[] {
  const pids: number[] = [];
  for (const role of roles) {
    if (!existsSync(startedPaths[role])) continue;
    const marker = readJson(startedPaths[role]) as { pid?: unknown; role?: unknown };
    if (marker.role !== role || typeof marker.pid !== "number" || !Number.isSafeInteger(marker.pid) || marker.pid <= 0) {
      throw new Error(`P4A ${role} inference marker has invalid owned PID evidence.`);
    }
    pids.push(marker.pid);
  }
  return [...new Set(pids)];
}

async function waitForPids(pids: number[], deadline: number): Promise<boolean> {
  while (pids.some(isProcessAlive)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function readFixtureEvents(eventsPath: string): FixtureEvent[] {
  return readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
}

function readRunEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(project, ".nodulus", "runs", runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readCheckpoint(project: string, runId: string): GraphCheckpoint {
  return readJson(path.join(project, ".nodulus", "runs", runId, "run.json")) as unknown as GraphCheckpoint;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function snapshotRunTree(project: string, runId: string): Array<{ relative: string; sha256: string }> {
  const root = path.join(project, ".nodulus", "runs", runId);
  const files: Array<{ relative: string; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ relative: path.relative(root, absolute), sha256: digest(readFileSync(absolute)) });
    }
  };
  visit(root);
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const nativeTemp = realpathSync.native(tmpdir());
  const current = realpathSync.native(project);
  if (current !== identity || path.dirname(identity) !== nativeTemp || !path.basename(identity).startsWith(`nodulus-${label}-`)) {
    throw new Error("P4A refused cleanup outside the exact owned native temporary project.");
  }
}

function assertScenarioTime(deadline: number, operation: string): void {
  if (Date.now() >= deadline) throw new Error(`P4A shared scenario deadline expired during ${operation}.`);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("P4A cleanup failed with a non-Error value.");
}

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "vitest";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import { resumeWorkflow } from "../../src/application/resume-workflow.js";
import { runWorkflow, type ProviderInvocation, type ProviderPort } from "../../src/application/run-workflow.js";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { runProcess } from "../../src/adapters/providers/process-runner.js";
import { createFeedbackProject, acceptedResponses, fixBuildResponses } from "../support/feedback-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

const fixturePath = fileURLToPath(new URL("../fixtures/fb-040-feedback-limits-provider.mjs", import.meta.url));
const defaultCliFixturePath = fileURLToPath(new URL("../fixtures/fb-040-default-provider-cli.mjs", import.meta.url));
const request = (projectRoot: string) => ({ projectRoot, cwd: projectRoot, workflow: "example", sources: [{ kind: "inline" as const, text: "Review and revise the example within configured feedback limits." }] });

type LimitCall = { nodeId: string; operation: string; attempt: number; callId?: string; inputs?: Record<string, unknown>; deadlineAtMs?: number };
type RegionCheckpoint = { iteration: number; providerCalls?: number; elapsedMs?: number; deadlineAtMs?: number; generationHistory?: unknown[]; uncertainCalls?: Array<Record<string, unknown>> };

function configureRoute(fixture: ReturnType<typeof createFeedbackProject>, overrides: Record<string, unknown> = {}, limits: Record<string, number> = {}): void {
  const workflow = readProjectJson(fixture.project, ".nodulus/workflows/example.json");
  const current = workflow.feedbackRouting as Record<string, unknown>;
  const currentLimits = current.limits as Record<string, number>;
  workflow.feedbackRouting = { ...current, ...overrides, limits: { ...currentLimits, ...limits } };
  writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);
}

function setRepairCapability(fixture: ReturnType<typeof createFeedbackProject>): void {
  const settings = readProjectJson(fixture.project, ".nodulus/settings.json");
  const profile = settings.providerProfiles.fixture as Record<string, unknown>;
  profile.capabilities = ["responseRepair"];
  writeJson(fixture.project, ".nodulus/settings.json", settings);
}

function installSlowDefaultCodexFixture(project: string): { started: string; completed: string } {
  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profile = settings.providerProfiles.fixture as Record<string, unknown>;
  Object.assign(profile, { kind: "codex", timeoutMs: 5000, model: "fixture", sandbox: "read-only" });
  const providerDirectory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(providerDirectory, { recursive: true });
  const cliFixture = path.join(providerDirectory, "fb-040-default-provider-cli.mjs");
  copyFileSync(defaultCliFixturePath, cliFixture);
  const wrapperPath = path.join(providerDirectory, process.platform === "win32" ? "codex-fixture.cmd" : "codex-fixture.sh");
  if (process.platform === "win32") {
    writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\fb-040-default-provider-cli.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    writeFileSync(wrapperPath, `#!/bin/sh\nexec '${process.execPath}' '.nodulus/fixtures/fb-040-default-provider-cli.mjs' "$@"\n`, "utf8");
    chmodSync(wrapperPath, 0o755);
  }
  profile.executable = wrapperPath;
  writeJson(project, ".nodulus/settings.json", settings);
  return {
    started: path.join(project, ".nodulus", "readiness-probe-started"),
    completed: path.join(project, ".nodulus", "readiness-probe-completed"),
  };
}

function readCalls(fixture: ReturnType<typeof createFeedbackProject>): LimitCall[] {
  const raw = readFileSync(fixture.tracePath, "utf8");
  return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as LimitCall);
}

async function regionState(fixture: ReturnType<typeof createFeedbackProject>, runId: string): Promise<RegionCheckpoint> {
  const storage = new LocalIntakeStorage();
  const checkpoint = JSON.parse(await storage.readRunFile(fixture.project, runId, "run.json")) as { feedbackRouting?: { regions?: Record<string, RegionCheckpoint> } };
  return checkpoint.feedbackRouting?.regions?.["content-review"] ?? {} as RegionCheckpoint;
}

function limitProvider(
  fixture: ReturnType<typeof createFeedbackProject>,
  hooks: { onInvoke?: (invocation: ProviderInvocation) => void; onAvailable?: () => void } = {},
): ProviderPort {
  const markersPath = path.join(fixture.temporary, "process-markers");
  const runFixture = async (input: ProviderInvocation | Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    const result = await runProcess(process.execPath, [fixturePath, fixture.responsesPath, fixture.tracePath, markersPath, fixture.project], {
      cwd: fixture.temporary,
      stdin: JSON.stringify(input),
      timeoutMs: 5000,
      ...(signal ? { signal } : {}),
    });
    if (result.cancelled) throw new Error("Feedback limit fixture process was cancelled.");
    if (result.timedOut) throw new Error("Feedback limit fixture process timed out.");
    if (result.exitCode !== 0) throw new Error(result.stderr || `Feedback limit fixture exited ${result.exitCode}`);
    return result.stdout;
  };
  const signalOf = (invocation: ProviderInvocation): AbortSignal | undefined => (invocation as ProviderInvocation & { signal?: AbortSignal }).signal;
  return {
    async invoke(invocation) {
      hooks.onInvoke?.(invocation);
      return runFixture(invocation, signalOf(invocation));
    },
    async repairResponse(invocation, previousRawResponse, validationErrors) {
      const { signal, ...payload } = invocation as ProviderInvocation & { signal?: AbortSignal };
      return runFixture({ ...payload, previousRawResponse, validationErrors }, signal);
    },
    isAvailable() { hooks.onAvailable?.(); return true; },
  };
}

function writeResponses(fixture: ReturnType<typeof createFeedbackProject>, responses: Array<Record<string, unknown>>): void {
  writeFileSync(fixture.responsesPath, JSON.stringify({ responses }), "utf8");
}

test("FB-040 allows acceptance on the last iteration and rejects a revision at the cap", async () => {
  const accepted = createFeedbackProject("last-iteration-accept");
  const revision = createFeedbackProject("iteration-cap-revision");
  configureRoute(accepted, {}, { maxIterations: 1 });
  configureRoute(revision, {}, { maxIterations: 1 });
  accepted.writeResponses(acceptedResponses());
  revision.writeResponses(fixBuildResponses());
  try {
    const acceptedRun = await runWorkflow(request(accepted.project), accepted.provider);
    expect(acceptedRun.status).toBe("success");
    expect(acceptedRun.result).toMatchObject({ artifacts: [expect.objectContaining({ name: "continued" })] });
    expect(accepted.readTrace().map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review", "continue"]);

    const revisionRun = await runWorkflow(request(revision.project), revision.provider);
    expect(revisionRun.status).toBe("error");
    expect(revisionRun.result).toMatchObject({ error: { code: "FEEDBACK_LIMIT_EXCEEDED" } });
    expect(revision.readTrace().map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review"]);
  } finally {
    accepted.cleanup();
    revision.cleanup();
  }
}, 20000);

test.each([3, 4])("FB-040 provider-call budget %i excludes prefix and continuation calls", async (maxProviderCalls) => {
  const fixture = createFeedbackProject("region-call-budget-" + maxProviderCalls);
  configureRoute(fixture, { startNode: "docs", reentrySafeNodes: ["docs", "build", "review"] }, { maxProviderCalls });
  fixture.writeResponses(acceptedResponses());
  try {
    const result = await runWorkflow(request(fixture.project), limitProvider(fixture));
    const observedCalls = readCalls(fixture).map((call) => call.nodeId);
    const state = await regionState(fixture, result.runId);
    const errorCode = (result.result as { error?: { code?: string } }).error?.code ?? null;
    expect({ status: result.status, errorCode, observedCalls, providerCalls: state.providerCalls }).toEqual({
      status: "success", errorCode: null, observedCalls: ["prepare", "docs", "build", "review", "continue"], providerCalls: 3,
    });
  } finally {
    fixture.cleanup();
  }
});

test("FB-040 counts response-only repairs against the region budget", async () => {
  const fixture = createFeedbackProject("repair-call-budget");
  configureRoute(fixture, {}, { maxProviderCalls: 5 });
  setRepairCapability(fixture);
  writeResponses(fixture, [
    { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "prepared once" },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 1" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 1" },
    { nodeId: "review", rawOutcome: "{invalid response" },
    { nodeId: "review", operation: "repair_response", rawOutcome: "{still invalid" },
  ]);
  try {
    const result = await runWorkflow(request(fixture.project), limitProvider(fixture));
    expect(result.status).toBe("error");
    expect(result.result).toMatchObject({ error: { code: "FEEDBACK_LIMIT_EXCEEDED" } });
    expect(readCalls(fixture).map(({ nodeId, operation }) => [nodeId, operation])).toEqual([
      ["prepare", "invoke"], ["docs", "invoke"], ["build", "invoke"], ["review", "invoke"], ["review", "repair_response"],
    ]);
    expect(await regionState(fixture, result.runId)).toMatchObject({ providerCalls: 5 });
  } finally {
    fixture.cleanup();
  }
});

test("FB-040 persists a failed provider call in the region call budget", async () => {
  const fixture = createFeedbackProject("failed-call-budget");
  fixture.writeResponses([
    { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "prepared once" },
    { nodeId: "docs", fail: true },
  ]);
  try {
    const result = await runWorkflow(request(fixture.project), limitProvider(fixture));
    expect(result.status).toBe("error");
    expect(result.result).toMatchObject({ error: { code: "PROVIDER_FAILURE" } });
    expect(readCalls(fixture).map((call) => call.nodeId)).toEqual(["prepare", "docs"]);
    expect(await regionState(fixture, result.runId)).toMatchObject({ providerCalls: 2 });
  } finally {
    fixture.cleanup();
  }
});

test("FB-040 aborts an overlong in-flight child at the persisted region deadline", async () => {
  const fixture = createFeedbackProject("deadline-aborts-child");
  configureRoute(fixture, {}, { maxElapsedMs: 1200 });
  const responses = acceptedResponses();
  responses[0] = { ...responses[0]!, delayMs: 3000 };
  fixture.writeResponses(responses);
  try {
    const result = await runWorkflow(request(fixture.project), limitProvider(fixture));
    const calls = readCalls(fixture);
    const state = await regionState(fixture, result.runId);
    const errorCode = (result.result as { error?: { code?: string } }).error?.code ?? null;
    expect({
      status: result.status,
      errorCode,
      calls: calls.map((call) => call.nodeId),
      started: existsSync(path.join(fixture.temporary, "process-markers", "started-1")),
      completed: existsSync(path.join(fixture.temporary, "process-markers", "completed-1")),
      providerCalls: state.providerCalls,
      deadlineAtMs: state.deadlineAtMs,
      uncertainCalls: state.uncertainCalls,
    }).toEqual({
      status: "error",
      errorCode: "FEEDBACK_LIMIT_EXCEEDED",
      calls: ["prepare"],
      started: true,
      completed: false,
      providerCalls: 1,
      deadlineAtMs: expect.any(Number),
      uncertainCalls: [{ callId: calls[0]?.callId, nodeId: "prepare", attempt: 1, operation: "invoke", launchStatus: "uncertain" }],
    });
  } finally {
    fixture.cleanup();
  }
});

test("FB-040 expired paused deadline rejects resume before availability checks or mutation", async () => {
  const fixture = createFeedbackProject("expired-paused-deadline");
  const maxElapsedMs = 1200;
  configureRoute(fixture, {}, { maxElapsedMs });
  const pause = { status: "needs_input", request: { id: "deadline-pause", questions: [{ id: "detail", message: "Clarify the review." }], answerContract: { type: "object", required: ["detail"], properties: { detail: { type: "string" } }, additionalProperties: false } } };
  fixture.writeResponses([
    { nodeId: "prepare", rawOutcome: JSON.stringify(pause) },
    { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "prepared after answer" },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs after answer" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build after answer" },
    { nodeId: "review", kind: "decision", decisionCode: "ACCEPT", reason: "Accepted after answer.", findings: [] },
    { nodeId: "continue", name: "continued", contract: "continued.v1", text: "continued after answer" },
  ]);
  let regionStartedAt = 0;
  let availabilityChecks = 0;
  const provider = limitProvider(fixture, {
    onInvoke() { if (!regionStartedAt) regionStartedAt = Date.now(); },
    onAvailable() { availabilityChecks += 1; },
  });
  const storage = new LocalIntakeStorage();
  try {
    const initial = await runWorkflow(request(fixture.project), provider);
    expect(initial.status).toBe("needs_input");
    expect(regionStartedAt).toBeGreaterThan(0);
    const pending = JSON.parse(await storage.readRunFile(fixture.project, initial.runId, "pending/request.json")) as { id: string };
    const pausedBytes = await storage.readRunFile(fixture.project, initial.runId, "run.json");
    const pausedCalls = readCalls(fixture);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, regionStartedAt + maxElapsedMs + 150 - Date.now())));

    const outcome = await resumeWorkflow({ projectRoot: fixture.project, runId: initial.runId, requestId: pending.id, answers: { detail: "Do not resume after the deadline." } }, provider)
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    const callsAfter = readCalls(fixture);
    const checkpointAfter = await storage.readRunFile(fixture.project, initial.runId, "run.json");
    const outcomeSummary = "error" in outcome
      ? { kind: "error", code: (outcome.error as { code?: string }).code }
      : {
          kind: "result",
          status: outcome.result.status,
          code: (outcome.result.result as { error?: { code?: string } }).error?.code ?? null,
        };
    expect({
      outcome: outcomeSummary,
      availabilityChecks,
      traceUnchanged: JSON.stringify(callsAfter) === JSON.stringify(pausedCalls),
      checkpointUnchanged: checkpointAfter === pausedBytes,
    }).toEqual({
      outcome: { kind: "result", status: "error", code: "FEEDBACK_LIMIT_EXCEEDED" },
      availabilityChecks: 0,
      traceUnchanged: true,
      checkpointUnchanged: true,
    });
  } finally {
    fixture.cleanup();
  }
});

test("FB-040 bounds the real default-provider readiness probe during resume", async () => {
  const fixture = createFeedbackProject("readiness-probe-deadline");
  const maxElapsedMs = 1800;
  configureRoute(fixture, {}, { maxElapsedMs });
  const { started: probeStarted, completed: probeCompleted } = installSlowDefaultCodexFixture(fixture.project);
  const pause = { status: "needs_input", request: { id: "readiness-pause", questions: [{ id: "detail", message: "Clarify the request." }], answerContract: { type: "object", required: ["detail"], properties: { detail: { type: "string" } }, additionalProperties: false } } };
  fixture.writeResponses([{ nodeId: "prepare", rawOutcome: JSON.stringify(pause) }]);
  const storage = new LocalIntakeStorage();
  let regionStartedAt = 0;
  const initialProvider = limitProvider(fixture, { onInvoke() { regionStartedAt ||= Date.now(); } });
  try {
    const initial = await runWorkflow(request(fixture.project), initialProvider);
    expect(initial.status).toBe("needs_input");
    expect(Date.now() - regionStartedAt).toBeLessThan(maxElapsedMs - 200);
    const pending = JSON.parse(await storage.readRunFile(fixture.project, initial.runId, "pending/request.json")) as { id: string };
    const pausedBytes = await storage.readRunFile(fixture.project, initial.runId, "run.json");
    const resumed = await resumeWorkflow({ projectRoot: fixture.project, runId: initial.runId, requestId: pending.id, answers: { detail: "Resume while time remains." } }, createDefaultProviderPort(fixture.project))
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    const runState = JSON.parse(await storage.readRunFile(fixture.project, initial.runId, "run.json")) as { status?: string; result?: { error?: { code?: string } } };
    const outcome = "error" in resumed
      ? { status: "error", errorCode: (resumed.error as { code?: string }).code ?? null }
      : { status: resumed.result.status, errorCode: (resumed.result.result as { error?: { code?: string } }).error?.code ?? null };
    expect({
      ...outcome,
      probeStarted: existsSync(probeStarted),
      probeCompleted: existsSync(probeCompleted),
      pausedCheckpointPreserved: await storage.readRunFile(fixture.project, initial.runId, "run.json") === pausedBytes,
      terminalStatus: runState.status,
    }).toEqual({
      status: "error",
      errorCode: "FEEDBACK_LIMIT_EXCEEDED",
      probeStarted: true,
      probeCompleted: false,
      pausedCheckpointPreserved: true,
      terminalStatus: "needs_input",
    });
  } finally {
    fixture.cleanup();
  }
}, 20000);

test("FB-040 bounds readiness before inference and records the provider call as not launched", async () => {
  const fixture = createFeedbackProject("invoke-readiness-deadline");
  configureRoute(fixture, {}, { maxElapsedMs: 1200 });
  const { started: probeStarted, completed: probeCompleted } = installSlowDefaultCodexFixture(fixture.project);
  try {
    const result = await runWorkflow(request(fixture.project), createDefaultProviderPort(fixture.project));
    const state = await regionState(fixture, result.runId);
    const errorCode = (result.result as { error?: { code?: string } }).error?.code ?? null;
    expect({
      status: result.status,
      errorCode,
      probeStarted: existsSync(probeStarted),
      probeCompleted: existsSync(probeCompleted),
      invocationStarted: existsSync(path.join(fixture.project, ".nodulus", "provider-invocation-started")),
      providerCalls: state.providerCalls,
      uncertainCalls: state.uncertainCalls,
    }).toEqual({
      status: "error",
      errorCode: "FEEDBACK_LIMIT_EXCEEDED",
      probeStarted: true,
      probeCompleted: false,
      invocationStarted: false,
      providerCalls: 1,
      uncertainCalls: [{ callId: expect.any(String), nodeId: "prepare", attempt: 1, operation: "invoke", launchStatus: "not_launched" }],
    });
  } finally {
    fixture.cleanup();
  }
}, 20000);

test("FB-040 starts elapsed budget at region entry after slow prefix work", async () => {
  const fixture = createFeedbackProject("slow-prefix-before-region");
  const maxElapsedMs = 2500;
  configureRoute(fixture, { startNode: "docs", reentrySafeNodes: ["docs", "build", "review"] }, { maxElapsedMs });
  const responses = acceptedResponses();
  responses[0] = { ...responses[0]!, delayMs: 2800 };
  fixture.writeResponses(responses);
  try {
    const result = await runWorkflow(request(fixture.project), limitProvider(fixture));
    const state = await regionState(fixture, result.runId);
    expect({
      status: result.status,
      calls: readCalls(fixture).map((call) => call.nodeId),
      deadlineAtMs: state.deadlineAtMs,
      providerCalls: state.providerCalls,
    }).toEqual({
      status: "success",
      calls: ["prepare", "docs", "build", "review", "continue"],
      deadlineAtMs: expect.any(Number),
      providerCalls: 3,
    });
  } finally {
    fixture.cleanup();
  }
}, 20000);

test("FB-040 permits continuation resume after the accepted region deadline expires", async () => {
  const fixture = createFeedbackProject("continuation-resume-after-region");
  const maxElapsedMs = 5000;
  configureRoute(fixture, {}, { maxElapsedMs });
  const responses = acceptedResponses();
  const continuationPause = {
    status: "needs_input",
    request: {
      id: "continue-pause",
      questions: [{ id: "detail", message: "Clarify continuation." }],
      answerContract: { type: "object", required: ["detail"], properties: { detail: { type: "string" } }, additionalProperties: false },
    },
  };
  responses[4] = { nodeId: "continue", rawOutcome: JSON.stringify(continuationPause) };
  responses.push({ nodeId: "continue", name: "continued", contract: "continued.v1", text: "continued after region acceptance" });
  fixture.writeResponses(responses);
  const provider = limitProvider(fixture);
  const storage = new LocalIntakeStorage();
  try {
    const initial = await runWorkflow(request(fixture.project), provider);
    expect(initial.status).toBe("needs_input");
    const stateAtPause = await regionState(fixture, initial.runId);
    const deadlineAtMs = stateAtPause.deadlineAtMs;
    expect(Number.isFinite(deadlineAtMs as number)).toBe(true);
    if (typeof deadlineAtMs !== "number" || !Number.isFinite(deadlineAtMs)) {
      throw new Error("Continuation pause has no finite persisted region deadline");
    }
    const historyAtPause = stateAtPause.generationHistory;
    const pending = JSON.parse(await storage.readRunFile(fixture.project, initial.runId, "pending/request.json")) as { id: string };
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineAtMs + 150 - Date.now())));
    const resumed = await resumeWorkflow({ projectRoot: fixture.project, runId: initial.runId, requestId: pending.id, answers: { detail: "Continue after acceptance." } }, provider);
    const stateAfterResume = await regionState(fixture, initial.runId);
    expect({
      status: resumed.status,
      calls: readCalls(fixture).map((call) => call.nodeId),
      deadlineAtMs: stateAtPause.deadlineAtMs,
      historyPreserved: JSON.stringify(stateAfterResume.generationHistory) === JSON.stringify(historyAtPause),
    }).toEqual({
      status: "success",
      calls: ["prepare", "docs", "build", "review", "continue", "continue"],
      deadlineAtMs: expect.any(Number),
      historyPreserved: true,
    });
  } finally {
    fixture.cleanup();
  }
}, 20000);

test("FB-040 response repair shares the original region deadline", async () => {
  const fixture = createFeedbackProject("repair-shares-region-deadline");
  const maxElapsedMs = 3000;
  configureRoute(fixture, {}, { maxElapsedMs });
  setRepairCapability(fixture);
  fixture.writeResponses([
    { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "prepared" },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build" },
    { nodeId: "review", rawOutcome: "{invalid response" },
    { nodeId: "review", operation: "repair_response", delayMs: 4500, rawOutcome: JSON.stringify({ kind: "decision", decisionCode: "ACCEPT", reason: "accepted", findings: [] }) },
  ]);
  try {
    const result = await runWorkflow(request(fixture.project), limitProvider(fixture));
    const calls = readCalls(fixture);
    const repairCall = calls.find((call) => call.operation === "repair_response");
    expect({
      status: result.status,
      errorCode: (result.result as { error?: { code?: string } }).error?.code ?? null,
      operations: calls.map((call) => [call.nodeId, call.operation]),
      invokeDeadline: calls.find((call) => call.nodeId === "review" && call.operation === "invoke")?.deadlineAtMs,
      repairDeadline: repairCall?.deadlineAtMs,
      repairStarted: existsSync(path.join(fixture.temporary, "process-markers", "started-5")),
      repairCompleted: existsSync(path.join(fixture.temporary, "process-markers", "completed-5")),
    }).toEqual({
      status: "error",
      errorCode: "FEEDBACK_LIMIT_EXCEEDED",
      operations: [["prepare", "invoke"], ["docs", "invoke"], ["build", "invoke"], ["review", "invoke"], ["review", "repair_response"]],
      invokeDeadline: expect.any(Number),
      repairDeadline: expect.any(Number),
      repairStarted: true,
      repairCompleted: false,
    });
    expect(repairCall?.deadlineAtMs).toBe(calls.find((call) => call.nodeId === "review" && call.operation === "invoke")?.deadlineAtMs);
  } finally {
    fixture.cleanup();
  }
}, 20000);

test("FB-040 retains captured cancellation and launch identity for an aborted default provider call", async () => {
  const fixture = createFeedbackProject("captured-provider-cancelled");
  configureRoute(fixture, {}, { maxElapsedMs: 1200 });
  const { started: readinessStarted, completed: readinessCompleted } = installSlowDefaultCodexFixture(fixture.project);
  writeFileSync(readinessStarted, "already checked\n", "utf8");
  writeFileSync(readinessCompleted, "already checked\n", "utf8");
  writeFileSync(path.join(fixture.project, ".nodulus", "slow-provider-invocation"), "slow\n", "utf8");
  try {
    const result = await runWorkflow(request(fixture.project), createDefaultProviderPort(fixture.project));
    const state = await regionState(fixture, result.runId);
    const callsDirectory = path.join(fixture.project, ".nodulus", "runs", result.runId, "calls");
    const callId = readdirSync(callsDirectory)[0];
    const transport = JSON.parse(readFileSync(path.join(callsDirectory, callId!, "transport.json"), "utf8")) as { callId: string; cancelled?: boolean };
    expect({
      status: result.status,
      errorCode: (result.result as { error?: { code?: string } }).error?.code ?? null,
      invocationStarted: existsSync(path.join(fixture.project, ".nodulus", "provider-invocation-started")),
      invocationCompleted: existsSync(path.join(fixture.project, ".nodulus", "provider-invocation-completed")),
      transportCancelled: transport.cancelled,
      callId: transport.callId,
      uncertainCalls: state.uncertainCalls,
    }).toEqual({
      status: "error",
      errorCode: "FEEDBACK_LIMIT_EXCEEDED",
      invocationStarted: true,
      invocationCompleted: false,
      transportCancelled: true,
      callId: expect.any(String),
      uncertainCalls: [{ callId: transport.callId, nodeId: "prepare", attempt: 1, operation: "invoke", launchStatus: "launched" }],
    });
  } finally {
    fixture.cleanup();
  }
}, 20000);

test("FB-040 stops a slow artifact validator at the active region deadline", async () => {
  const fixture = createFeedbackProject("validator-deadline");
  configureRoute(fixture, {}, { maxElapsedMs: 1200 });
  const validatorPath = path.join(fixture.project, ".nodulus", "validators", "fb-040-slow.mjs");
  const started = path.join(fixture.temporary, "validator-started");
  const completed = path.join(fixture.temporary, "validator-completed");
  mkdirSync(path.dirname(validatorPath), { recursive: true });
  writeFileSync(validatorPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(started)}, "started");\nawait new Promise((resolve) => setTimeout(resolve, 3000));\nwriteFileSync(${JSON.stringify(completed)}, "completed");\nconsole.log(JSON.stringify({ valid: true, errors: [] }));\n`, "utf8");
  const prepare = readProjectJson(fixture.project, ".nodulus/nodes/prepare.json");
  const output = (prepare.expectedOutputs as Array<Record<string, unknown>>)[0]!;
  output.validator = ".nodulus/validators/fb-040-slow.mjs";
  output.validatorTimeoutMs = 5000;
  writeJson(fixture.project, ".nodulus/nodes/prepare.json", prepare);
  fixture.writeResponses(acceptedResponses());
  try {
    const result = await runWorkflow(request(fixture.project), limitProvider(fixture));
    const state = await regionState(fixture, result.runId);
    expect({
      status: result.status,
      errorCode: (result.result as { error?: { code?: string } }).error?.code ?? null,
      validatorStarted: existsSync(started),
      validatorCompleted: existsSync(completed),
      acceptedPrepareGeneration: state.generationHistory.some((record) => record.nodeId === "prepare" && record.status === "accepted"),
    }).toEqual({
      status: "error",
      errorCode: "FEEDBACK_LIMIT_EXCEEDED",
      validatorStarted: true,
      validatorCompleted: false,
      acceptedPrepareGeneration: false,
    });
  } finally {
    fixture.cleanup();
  }
}, 20000);

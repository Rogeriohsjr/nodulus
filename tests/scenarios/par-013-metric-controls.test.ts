import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ApplicationRunResult, type ProviderPort } from "../../src/index.js";
import type { ProviderTelemetry } from "../../src/core/ports/provider-telemetry.js";
import { readParallelWorkflow } from "../support/parallel-project.js";
import { writeJson } from "../support/workflow-sequence.js";
import { createGraphOpenCodeFixture, type GraphOpenCodeFixture, type GraphOpenCodeNodeConfig } from "../support/graph-opencode-fixture.js";

type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };
type NodeConfig = { id: string; dependencies: string[] };

const testWatchdogMs = 35_000;
const waitWatchdogMs = 10_000;

function validOutcome(text: string): string {
  return JSON.stringify({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text } }] });
}

function malformedOutcome(): string {
  return '{"status":"success","artifacts":[';
}

function config(sessionId: string, buildRaw: string): GraphOpenCodeNodeConfig {
  return { sessionId, buildRaw, repairRaw: [] };
}

function configureGraph(project: string, nodes: NodeConfig[], maxConcurrency = 2): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = nodes.map(({ id }) => id);
  workflow.execution.maxConcurrency = maxConcurrency;
  workflow.execution.dependsOn = Object.fromEntries(nodes.map(({ id, dependencies }) => [id, dependencies]));
  workflow.execution.resources = Object.fromEntries(nodes.map(({ id }) => [id, []]));
  workflow.outputs = nodes.map(({ id }) => ({ name: `${id}Output`, from: `${id}.report`, contract: "report.v1" }));
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  for (const { id } of nodes) {
    writeJson(project, `.nodulus/nodes/${id}.json`, {
      schemaVersion: 1,
      id,
      providerProfile: "fixture",
      instructions: [`.nodulus/instructions/${id}.md`],
      inputs: { request: { from: "request", contract: "request.v1" } },
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
  }
}

function request(fixture: GraphOpenCodeFixture) {
  return {
    projectRoot: fixture.project,
    cwd: fixture.project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Verify optional per-call measurement handling." }],
  };
}

function startRun(fixture: GraphOpenCodeFixture, provider: ProviderPort = fixture.provider): Promise<RunOutcome> {
  return runWorkflow(request(fixture), provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

function expectSuccessful(outcome: RunOutcome): ApplicationRunResult {
  expect(outcome.kind).toBe("result");
  if (outcome.kind !== "result") throw outcome.error;
  expect(outcome.result.status).toBe("success");
  return outcome.result;
}

async function settleAndCleanup(fixture: GraphOpenCodeFixture, settled: Promise<RunOutcome>): Promise<void> {
  fixture.releaseAll();
  await settled;
  await fixture.cleanup();
}

function runDirectory(fixture: GraphOpenCodeFixture, runId: string): string {
  return path.join(fixture.project, ".nodulus", "runs", runId);
}

function checkpoint(fixture: GraphOpenCodeFixture, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(runDirectory(fixture, runId), "run.json"), "utf8")) as Record<string, any>;
}

function metrics(fixture: GraphOpenCodeFixture, runId: string): Array<Record<string, any>> {
  return JSON.parse(readFileSync(path.join(runDirectory(fixture, runId), "metrics.json"), "utf8")) as Array<Record<string, any>>;
}

function expectSuccessAliases(result: ApplicationRunResult, nodes: string[], texts: Record<string, string>): void {
  expect(result.result).toEqual({ artifacts: nodes.map((id) => ({ name: `${id}Output`, contract: "report.v1", data: { text: texts[id] } })) });
}

function expectHealthyBetaMetric(metric: Record<string, any>, callId: string): void {
  expect(metric).toMatchObject({
    nodeId: "beta",
    callId,
    attempt: 1,
    operation: "invoke",
    usage: { inputTokens: 115, outputTokens: 43, cacheReadTokens: 3, costUsd: 0.011 },
    launched: true,
    telemetry: {
      provider: "opencode",
      coverage: "complete",
      reported: { inputTokens: 111, outputTokens: 41, cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 2, costUsd: 0.011 },
      normalized: { inputTokens: 115, outputTokens: 43 },
    },
  });
}

function expectBadMeasurementDiagnostic(fixture: GraphOpenCodeFixture, runId: string, callId: string): void {
  const diagnostics = checkpoint(fixture, runId).diagnostics as unknown;
  expect(Array.isArray(diagnostics)).toBe(true);
  expect((diagnostics as unknown[]).some((item) => typeof item === "string" && item.includes(callId) && /measurement|telemetry/i.test(item))).toBe(true);
}

async function waitForMeasurementHook(
  observed: Promise<void>,
  settled: Promise<RunOutcome>,
  fixture: GraphOpenCodeFixture,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      observed,
      settled.then((outcome) => { throw new Error(`Workflow settled before alpha measurement hook: ${describeOutcome(outcome)}.`); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for alpha measurement hook. ${fixture.diagnostics()}`)), waitWatchdogMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describeOutcome(outcome: RunOutcome): string {
  if (outcome.kind === "rejection") return `rejection ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;
  const error = (outcome.result.result as any)?.error;
  return `${outcome.result.status}${error?.code ? ` ${error.code}` : ""}${error?.message ? `: ${String(error.message).slice(0, 500)}` : ""}`;
}

function rawTelemetryForCall(fixture: GraphOpenCodeFixture, callId: string): ProviderTelemetry | null {
  return fixture.provider.telemetryForCall?.(callId) ?? null;
}

function setCapabilities(project: string, capabilities: string[]): void {
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { providerProfiles: Record<string, Record<string, unknown>> };
  settings.providerProfiles.fixture.capabilities = capabilities;
  writeJson(project, ".nodulus/settings.json", settings);
}

test("PAR-013 graph metrics ignore a shared legacy usage getter", async () => {
  const fixture = await createGraphOpenCodeFixture({
    alpha: config("alpha-session", validOutcome("alpha-final")),
    beta: config("beta-session", validOutcome("beta-final")),
  });
  configureGraph(fixture.project, [{ id: "alpha", dependencies: [] }, { id: "beta", dependencies: [] }]);
  let legacyGetterReads = 0;
  const provider: ProviderPort = {
    isAvailable: (profile, options) => fixture.provider.isAvailable?.(profile, options) ?? true,
    invoke: (invocation) => fixture.provider.invoke(invocation),
    launchForCall: (callId) => fixture.provider.launchForCall?.(callId) ?? null,
    usageForLastCall: () => {
      legacyGetterReads += 1;
      return { inputTokens: 999, outputTokens: 888, cacheReadTokens: 77, costUsd: 6.66 };
    },
  };
  const settled = startRun(fixture, provider);
  try {
    await fixture.waitForStarted("alpha", "build");
    await fixture.waitForStarted("beta", "build");
    fixture.release("beta", "build");
    await fixture.waitForFinished("beta", "build");
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    const result = expectSuccessful(await settled);
    expectSuccessAliases(result, ["alpha", "beta"], { alpha: "alpha-final", beta: "beta-final" });
    expect(legacyGetterReads).toBe(0);
    const rows = metrics(fixture, result.runId);
    expect(rows).toHaveLength(2);
    for (const call of fixture.calls) {
      expect(new Set(fixture.calls.map(({ callId }) => callId)).size).toBe(2);
      const row = rows.find(({ callId }) => callId === call.callId);
      expect(row).toMatchObject({ nodeId: call.nodeId, callId: call.callId, attempt: 1, operation: "invoke", usage: null, launched: true });
      expect(row).not.toHaveProperty("telemetry");
    }
  } finally {
    await settleAndCleanup(fixture, settled);
  }
}, testWatchdogMs);

test.each([
  { kind: "getter-throws" as const, label: "throws" },
  { kind: "circular-extra" as const, label: "contains a circular extra field" },
])("PAR-013 isolates alpha's telemetry when it $label", async ({ kind }) => {
  const fixture = await createGraphOpenCodeFixture({
    alpha: config("alpha-session", validOutcome("alpha-final")),
    beta: config("beta-session", validOutcome("beta-final")),
  });
  configureGraph(fixture.project, [{ id: "alpha", dependencies: [] }, { id: "beta", dependencies: [] }]);
  const nodeByCall = new Map<string, string>();
  let observedResolve!: () => void;
  const observed = new Promise<void>((resolve) => { observedResolve = resolve; });
  const actual = fixture.provider;
  let cycleInjected = false;
  const provider: ProviderPort = {
    ...actual,
    invoke(invocation) {
      if (invocation.call?.callId) nodeByCall.set(invocation.call.callId, invocation.nodeId);
      return actual.invoke(invocation);
    },
    telemetryForCall(callId) {
      const nodeId = nodeByCall.get(callId);
      if (nodeId === "alpha") {
        observedResolve();
        if (kind === "getter-throws") throw new Error("fixture alpha telemetry unavailable");
        const telemetry = rawTelemetryForCall(fixture, callId);
        if (!telemetry) return null;
        const extra: Record<string, unknown> = {};
        extra.self = extra;
        cycleInjected = true;
        return { ...telemetry, extra } as ProviderTelemetry;
      }
      return rawTelemetryForCall(fixture, callId);
    },
  };
  const settled = startRun(fixture, provider);
  try {
    await fixture.waitForStarted("alpha", "build");
    await fixture.waitForStarted("beta", "build");
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    await waitForMeasurementHook(observed, settled, fixture);
    expect(cycleInjected).toBe(kind === "circular-extra");
    fixture.release("beta", "build");
    await fixture.waitForFinished("beta", "build");
    const outcome = await settled;
    if (outcome.kind === "result" && outcome.result.status !== "success") {
      throw new Error(`Unexpected ${kind} telemetry outcome: ${describeOutcome(outcome)}.`);
    }
    const result = expectSuccessful(outcome);
    expectSuccessAliases(result, ["alpha", "beta"], { alpha: "alpha-final", beta: "beta-final" });
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.map(({ nodeId }) => nodeId).sort()).toEqual(["alpha", "beta"]);
    expect(fixture.operations().filter(({ operation }) => operation === "build")).toHaveLength(2);
    expect(fixture.calls.every(({ nodeId }) => fixture.actionExists(nodeId))).toBe(true);
    const rows = metrics(fixture, result.runId);
    expect(rows).toHaveLength(2);
    const alphaCall = fixture.calls.find(({ nodeId }) => nodeId === "alpha");
    const betaCall = fixture.calls.find(({ nodeId }) => nodeId === "beta");
    expect(alphaCall).toBeDefined();
    expect(betaCall).toBeDefined();
    const alphaMetric = rows.find(({ callId }) => callId === alphaCall?.callId);
    const betaMetric = rows.find(({ callId }) => callId === betaCall?.callId);
    expect(alphaMetric).toMatchObject({ nodeId: "alpha", callId: alphaCall?.callId, usage: null, launched: true });
    expect(alphaMetric).not.toHaveProperty("telemetry");
    if (!betaCall) throw new Error("Healthy beta call was not recorded.");
    expectHealthyBetaMetric(betaMetric ?? {}, betaCall.callId);
    expectBadMeasurementDiagnostic(fixture, result.runId, alphaCall?.callId ?? "");
  } finally {
    await settleAndCleanup(fixture, settled);
  }
}, testWatchdogMs);

test("PAR-013 keeps successful required completion when optional metrics path is a directory", async () => {
  const fixture = await createGraphOpenCodeFixture({ alpha: config("alpha-session", validOutcome("alpha-final")) });
  configureGraph(fixture.project, [{ id: "alpha", dependencies: [] }], 1);
  const settled = startRun(fixture);
  try {
    await fixture.waitForStarted("alpha", "build");
    const runId = fixture.calls[0]?.checkpointAtEntry.runId as string | undefined;
    expect(runId).toBeDefined();
    if (!runId) throw new Error("OpenCode call did not expose its run ID.");
    const metricsPath = path.join(runDirectory(fixture, runId), "metrics.json");
    if (existsSync(metricsPath)) {
      expect(lstatSync(metricsPath).isFile()).toBe(true);
      unlinkSync(metricsPath);
    }
    mkdirSync(metricsPath);
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    const result = expectSuccessful(await settled);
    expectSuccessAliases(result, ["alpha"], { alpha: "alpha-final" });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.actionExists("alpha")).toBe(true);
    expect(statSync(metricsPath).isDirectory()).toBe(true);
    const saved = checkpoint(fixture, result.runId);
    expect(saved.graph.nodes.alpha.phase).toBe("accepted");
    expect((saved.diagnostics as string[]).some((item) => item.startsWith("Optional graph metrics persistence failed: "))).toBe(true);
  } finally {
    await settleAndCleanup(fixture, settled);
  }
}, testWatchdogMs);

test("PAR-013 does not replay an action when response-only repair is unavailable", async () => {
  const fixture = await createGraphOpenCodeFixture({
    alpha: config("alpha-session", malformedOutcome()),
    beta: config("beta-session", validOutcome("beta-should-not-run")),
  });
  configureGraph(fixture.project, [{ id: "alpha", dependencies: [] }, { id: "beta", dependencies: ["alpha"] }]);
  setCapabilities(fixture.project, []);
  const settled = startRun(fixture);
  try {
    await fixture.waitForStarted("alpha", "build");
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    const outcome = await settled;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expect(outcome.result.status).toBe("error");
    expect((outcome.result.result as any)?.error?.code).toBe("RESPONSE_REPAIR_UNAVAILABLE");
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({ nodeId: "alpha", method: "invoke", invocationAttempt: 1, callAttempt: 1 });
    expect(fixture.operations()).toHaveLength(1);
    expect(fixture.operations()[0]).toMatchObject({ nodeId: "alpha", operation: "build" });
    expect(fixture.actionExists("alpha")).toBe(true);
    expect(fixture.actionExists("beta")).toBe(false);
    const saved = checkpoint(fixture, outcome.result.runId);
    expect(saved.graph.nodes.alpha.phase).toBe("failed");
    expect(saved.graph.nodes.alpha.accepted).toBeUndefined();
    expect(saved.graph.nodes.beta.phase).toBe("not_started");
    expect(saved.graph.nodes.beta.accepted).toBeUndefined();
  } finally {
    await settleAndCleanup(fixture, settled);
  }
}, testWatchdogMs);

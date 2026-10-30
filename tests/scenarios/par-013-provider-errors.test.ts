import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ApplicationRunResult, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { readParallelWorkflow } from "../support/parallel-project.js";
import { writeJson } from "../support/workflow-sequence.js";
import { createGraphOpenCodeFixture, type GraphOpenCodeFixture, type GraphOpenCodeNodeConfig } from "../support/graph-opencode-fixture.js";

type RunOutcome =
  | { kind: "result"; result: ApplicationRunResult }
  | { kind: "rejection"; error: unknown };

const testWatchdogMs = 35_000;

function successOutcome(text: string): string {
  return JSON.stringify({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text } }] });
}

function controlFailureOutcome(): string {
  return JSON.stringify({ status: "error", error: { code: "CONTROL_FAILURE", message: "Original provider outcome is a terminal control failure." } });
}

function config(sessionId: string, buildRaw: string): GraphOpenCodeNodeConfig {
  return { sessionId, buildRaw, repairRaw: [] };
}

function configureGraph(project: string): void {
  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["alpha", "beta"];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { alpha: [], beta: ["alpha"] };
  workflow.execution.resources = { alpha: [], beta: [] };
  workflow.outputs = [
    { name: "alphaOutput", from: "alpha.report", contract: "report.v1" },
    { name: "betaOutput", from: "beta.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  for (const id of workflow.nodes) {
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
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { providerProfiles: Record<string, Record<string, unknown>> };
  settings.providerProfiles.fixture.capabilities = ["responseRepair"];
  writeJson(project, ".nodulus/settings.json", settings);
}

function request(fixture: GraphOpenCodeFixture) {
  return {
    projectRoot: fixture.project,
    cwd: fixture.project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Verify provider promise failures stop the graph." }],
  };
}

function startRun(fixture: GraphOpenCodeFixture, provider: ProviderPort): Promise<RunOutcome> {
  return runWorkflow(request(fixture), provider).then(
    (result) => ({ kind: "result", result }),
    (error: unknown) => ({ kind: "rejection", error }),
  );
}

async function releaseAndCleanup(fixture: GraphOpenCodeFixture, settled: Promise<RunOutcome>): Promise<void> {
  fixture.releaseAll();
  await settled;
  await fixture.cleanup();
}

function runDirectory(fixture: GraphOpenCodeFixture, runId: string): string {
  return path.join(fixture.project, ".nodulus", "runs", runId);
}

function readCheckpoint(fixture: GraphOpenCodeFixture, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(runDirectory(fixture, runId), "run.json"), "utf8")) as Record<string, any>;
}

function expectCapturedRepairCapability(fixture: GraphOpenCodeFixture, runId: string): void {
  const context = JSON.parse(readFileSync(path.join(runDirectory(fixture, runId), "context", "definitions.json"), "utf8")) as Record<string, any>;
  expect(context.providerProfiles.fixture.capabilities).toContain("responseRepair");
}

function outcomeError(result: ApplicationRunResult): { code?: string; message?: string } {
  return (result.result as any)?.error ?? {};
}

test("PAR-013 rejected undefined provider promise is not response-corrected or replayed", async () => {
  const fixture = await createGraphOpenCodeFixture({
    alpha: config("alpha-session", successOutcome("actual-child-completed")),
    beta: config("beta-session", successOutcome("dependent-must-not-run")),
  });
  configureGraph(fixture.project);
  let alphaChildCompleted = false;
  let repairHookCalls = 0;
  const provider: ProviderPort = {
    ...fixture.provider,
    async invoke(invocation: ProviderInvocation) {
      await fixture.provider.invoke(invocation);
      if (invocation.nodeId === "alpha") {
        alphaChildCompleted = true;
        throw undefined;
      }
      throw new Error(`Unexpected original invocation for dependent '${invocation.nodeId}'.`);
    },
    async repairResponse() {
      repairHookCalls += 1;
      throw new Error("Response-repair hook should be unreachable after provider rejection.");
    },
  };
  const settled = startRun(fixture, provider);
  try {
    await fixture.waitForStarted("alpha", "build");
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    const outcome = await settled;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expectCapturedRepairCapability(fixture, outcome.result.runId);
    const error = outcomeError(outcome.result);
    expect.soft(outcome.result.status).toBe("error");
    expect.soft(error.code).toBe("PROVIDER_FAILURE");
    expect.soft(repairHookCalls).toBe(0);
    expect(alphaChildCompleted).toBe(true);
    expect(fixture.calls).toHaveLength(1);
    const originalCall = fixture.calls[0];
    expect(originalCall).toMatchObject({ nodeId: "alpha", method: "invoke", callAttempt: 1, invocationAttempt: 1, adapterSettled: true });
    expect(fixture.operations()).toHaveLength(1);
    expect(fixture.operations()[0]).toMatchObject({ nodeId: "alpha", operation: "build" });
    expect(fixture.actionExists("alpha")).toBe(true);
    expect(fixture.actionExists("beta")).toBe(false);
    const saved = readCheckpoint(fixture, outcome.result.runId);
    expect(saved.graph.nodes.alpha.phase).toBe("failed");
    expect(saved.graph.nodes.alpha.failure.code).toBe("PROVIDER_FAILURE");
    expect(saved.graph.nodes.alpha.accepted).toBeUndefined();
    expect(saved.graph.nodes.beta.phase).toBe("not_started");
    expect(saved.graph.nodes.beta.accepted).toBeUndefined();
    const events = readFileSync(path.join(runDirectory(fixture, outcome.result.runId), "events.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, any>);
    expect(events.find((event) => event.event === "provider.call.completed" && event.callId === originalCall.callId)?.launched).toBe(true);
  } finally {
    await releaseAndCleanup(fixture, settled);
  }
}, testWatchdogMs);

test("PAR-013 valid initial control failure remains terminal with response repair capability", async () => {
  const fixture = await createGraphOpenCodeFixture({
    alpha: config("alpha-session", controlFailureOutcome()),
    beta: config("beta-session", successOutcome("dependent-must-not-run")),
  });
  configureGraph(fixture.project);
  let repairHookCalls = 0;
  const provider: ProviderPort = {
    ...fixture.provider,
    repairResponse() {
      repairHookCalls += 1;
      throw new Error("A valid terminal control failure must not be repaired.");
    },
  };
  const settled = startRun(fixture, provider);
  try {
    await fixture.waitForStarted("alpha", "build");
    fixture.release("alpha", "build");
    await fixture.waitForFinished("alpha", "build");
    const outcome = await settled;
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") throw outcome.error;
    expectCapturedRepairCapability(fixture, outcome.result.runId);
    const error = outcomeError(outcome.result);
    expect(outcome.result.status).toBe("error");
    expect(error).toMatchObject({ code: "CONTROL_FAILURE", message: "Original provider outcome is a terminal control failure." });
    expect(repairHookCalls).toBe(0);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({ nodeId: "alpha", method: "invoke", adapterSettled: true });
    expect(fixture.operations()).toHaveLength(1);
    expect(fixture.operations()[0]).toMatchObject({ nodeId: "alpha", operation: "build" });
    expect(fixture.actionExists("alpha")).toBe(true);
    expect(fixture.actionExists("beta")).toBe(false);
    const saved = readCheckpoint(fixture, outcome.result.runId);
    expect(saved.graph.nodes.alpha.phase).toBe("failed");
    expect(saved.graph.nodes.alpha.failure).toMatchObject({ code: "CONTROL_FAILURE", message: "Original provider outcome is a terminal control failure." });
    expect(saved.graph.nodes.alpha.accepted).toBeUndefined();
    expect(saved.graph.nodes.beta.phase).toBe("not_started");
    expect(saved.graph.nodes.beta.accepted).toBeUndefined();
    const events = readFileSync(path.join(runDirectory(fixture, outcome.result.runId), "events.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, any>);
    expect(events.find((event) => event.event === "provider.call.completed" && event.callId === fixture.calls[0]?.callId)?.launched).toBe(true);
  } finally {
    await releaseAndCleanup(fixture, settled);
  }
}, testWatchdogMs);

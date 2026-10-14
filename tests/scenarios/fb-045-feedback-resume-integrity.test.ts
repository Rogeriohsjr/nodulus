import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import { resumeWorkflow } from "../../src/application/resume-workflow.js";
import { runWorkflow, type ProviderInvocation, type ProviderPort } from "../../src/application/run-workflow.js";
import { acceptedResponses, createFeedbackProject, type FeedbackFixtureResponse } from "../support/feedback-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";
const pauseOutcome = JSON.stringify({
  status: "needs_input",
  request: {
    id: "clarify-docs",
    questions: [{ id: "detail", message: "Clarify the docs." }],
    answerContract: { type: "object", required: ["detail"], properties: { detail: { type: "string" } }, additionalProperties: false },
  },
});

function pauseResponses(): FeedbackFixtureResponse[] {
  return [
    { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "prepared once" },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 1" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 1" },
    { nodeId: "review", kind: "decision", decisionCode: "FIX_DOCS", reason: "Revise docs.", findings: [{ id: "DOC-1" }] },
    { nodeId: "docs", rawOutcome: pauseOutcome } as FeedbackFixtureResponse,
  ];
}

function resumeResponses(): FeedbackFixtureResponse[] {
  return [
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 2" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 2" },
    { nodeId: "review", kind: "decision", decisionCode: "ACCEPT", reason: "Accepted.", findings: [] },
    { nodeId: "continue", name: "continued", contract: "continued.v1", text: "continued" },
  ];
}

async function makePaused(label: string, responses = [...pauseResponses(), ...resumeResponses()]) {
  const fixture = createFeedbackProject(label);
  fixture.writeResponses(responses);
  const initial = await runWorkflow({
    projectRoot: fixture.project,
    cwd: fixture.project,
    workflow: "example",
    sources: [{ kind: "inline", text: "Review and revise this workflow." }],
  }, fixture.provider);
  expect(initial.status).toBe("needs_input");
  if (initial.status !== "needs_input") throw new Error(`Expected paused run, got ${initial.status}`);
  return { ...fixture, runId: initial.runId };
}

function snapshotRun(project: string, runId: string): Array<{ path: string; digest: string }> {
  const root = path.join(project, ".nodulus", "runs", runId);
  const files: Array<{ path: string; digest: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === ".resume.lock") continue;
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else files.push({ path: path.relative(root, absolute).replaceAll(path.sep, "/"), digest: createHash("sha256").update(readFileSync(absolute)).digest("hex") });
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readRunJson(project: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, any>;
}

function writeRunJson(project: string, runId: string, value: unknown): void {
  writeFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function errorCode(result: { result: unknown }): string | undefined {
  return (result.result as { error?: { code?: string } }).error?.code;
}

async function resumeForError(request: Parameters<typeof resumeWorkflow>[0], provider: ProviderPort): Promise<{ result: unknown }> {
  try {
    const outcome = await resumeWorkflow(request, provider);
    return { result: outcome.result };
  } catch (error) {
    return { result: { error: { code: (error as { code?: string }).code } } };
  }
}

function countedProvider(fixture: Awaited<ReturnType<typeof makePaused>>): { provider: ProviderPort; calls: () => { invocation: number; availability: number } } {
  let invocationCount = 0;
  let availabilityCount = 0;
  return {
    provider: {
      async invoke(invocation: ProviderInvocation) { invocationCount += 1; return fixture.provider.invoke(invocation); },
      async isAvailable(profile, options) {
        availabilityCount += 1;
        return fixture.provider.isAvailable ? fixture.provider.isAvailable(profile, options) : true;
      },
    },
    calls: () => ({ invocation: invocationCount, availability: availabilityCount }),
  };
}

test("FB-045 rejects forged completed-node state before provider calls or run writes", async () => {
  const fixture = await makePaused("forged-completed");
  try {
    const checkpoint = readRunJson(fixture.project, fixture.runId);
    checkpoint.completedNodes = [...checkpoint.completedNodes, checkpoint.pendingNodeId];
    writeRunJson(fixture.project, fixture.runId, checkpoint);
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    const resumed = await resumeWorkflow({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Add the missing behavior." } }, counter.provider)
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    expect({
      code: "error" in resumed ? (resumed.error as { code?: string }).code : (resumed.result.result as { error?: { code?: string } }).error?.code,
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: JSON.stringify(snapshotRun(fixture.project, fixture.runId)) === JSON.stringify(before),
    }).toEqual({ code: "RUN_STATE_INVALID", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: true });
  } finally { fixture.cleanup(); }
});

test.each(["generationId", "sha256", "attemptPath", "status"] as const)("FB-045 rejects altered generation %s while immutable attempt files remain unchanged", async (field) => {
  const fixture = await makePaused(`generation-${field}`);
  try {
    const checkpoint = readRunJson(fixture.project, fixture.runId);
    const region = checkpoint.feedbackRouting.regions["content-review"];
    const generation = region.generationHistory.find((entry: Record<string, unknown>) => entry.nodeId === "docs" && entry.outputName === "readme");
    expect(generation).toBeDefined();
    const replacements: Record<typeof field, unknown> = {
      generationId: "forged-generation-id",
      sha256: "0".repeat(64),
      attemptPath: "nodes/docs/attempt-999/result.json",
      status: "accepted",
    };
    expect(generation[field]).not.toBe(replacements[field]);
    generation[field] = replacements[field];
    writeRunJson(fixture.project, fixture.runId, checkpoint);
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    const result = await resumeForError({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Add the missing behavior." } }, counter.provider);
    expect({
      code: errorCode(result),
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: JSON.stringify(snapshotRun(fixture.project, fixture.runId)) === JSON.stringify(before),
    }).toEqual({ code: "FEEDBACK_STATE_INVALID", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: true });
  } finally { fixture.cleanup(); }
});

test("FB-045 rejects removal of a generation from mutable history when creation evidence remains", async () => {
  const fixture = await makePaused("removed-generation-history");
  try {
    const checkpoint = readRunJson(fixture.project, fixture.runId);
    const region = checkpoint.feedbackRouting.regions["content-review"];
    const generationIndex = region.generationHistory.findIndex((entry: Record<string, unknown>) => entry.nodeId === "docs" && entry.outputName === "readme");
    expect(generationIndex).toBeGreaterThanOrEqual(0);
    region.generationHistory.splice(generationIndex, 1);
    writeRunJson(fixture.project, fixture.runId, checkpoint);
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    const result = await resumeForError({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Add the missing behavior." } }, counter.provider);
    expect({
      code: errorCode(result),
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: snapshotRun(fixture.project, fixture.runId),
    }).toEqual({ code: "FEEDBACK_STATE_INVALID", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: before });
  } finally { fixture.cleanup(); }
});

test.each(["missing-region", "invalid-counter", "missing-deadline"] as const)("FB-045 fails closed when active route state is %s", async (mutation) => {
  const fixture = await makePaused(`route-state-${mutation}`);
  try {
    const checkpoint = readRunJson(fixture.project, fixture.runId);
    const region = checkpoint.feedbackRouting.regions["content-review"];
    if (mutation === "missing-region") delete checkpoint.feedbackRouting.regions["content-review"];
    else if (mutation === "invalid-counter") region.providerCalls = -1;
    else delete region.deadlineAtMs;
    writeRunJson(fixture.project, fixture.runId, checkpoint);
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    const result = await resumeForError({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Add the missing behavior." } }, counter.provider);
    expect({
      code: errorCode(result),
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: JSON.stringify(snapshotRun(fixture.project, fixture.runId)) === JSON.stringify(before),
    }).toEqual({ code: "FEEDBACK_STATE_INVALID", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: true });
  } finally { fixture.cleanup(); }
});

test.each([
  { name: "provider call count", code: "FEEDBACK_STATE_INVALID", mutate: (checkpoint: Record<string, any>) => { checkpoint.feedbackRouting.regions["content-review"].providerCalls += 1; } },
  { name: "absolute deadline", code: "FEEDBACK_STATE_INVALID", mutate: (checkpoint: Record<string, any>) => { checkpoint.feedbackRouting.regions["content-review"].deadlineAtMs += 60_000; } },
  { name: "pending attempt", code: "RUN_STATE_INVALID", mutate: (checkpoint: Record<string, any>) => { checkpoint.attempt -= 1; } },
] as const)("FB-045 rejects a forged $name against saved execution evidence", async ({ name, code, mutate }) => {
  const fixture = await makePaused(`forged-evidence-${name.replaceAll(" ", "-")}`);
  try {
    const checkpoint = readRunJson(fixture.project, fixture.runId);
    mutate(checkpoint);
    writeRunJson(fixture.project, fixture.runId, checkpoint);
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    const result = await resumeForError({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Add the missing behavior." } }, counter.provider);
    expect({
      code: errorCode(result),
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: snapshotRun(fixture.project, fixture.runId),
    }).toEqual({ code, providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: before });
  } finally { fixture.cleanup(); }
});

test("FB-045 rejects a forged pending answer contract against the saved pause attempt", async () => {
  const fixture = await makePaused("forged-pending-contract");
  try {
    const requestPath = path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json");
    const pending = JSON.parse(readFileSync(requestPath, "utf8")) as { id: string; answerContract: Record<string, unknown> };
    pending.answerContract = { type: "object", properties: { detail: { type: "number" } } };
    writeFileSync(requestPath, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const result = await resumeForError({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: 7 } }, counter.provider);
    expect({
      code: errorCode(result),
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: snapshotRun(fixture.project, fixture.runId),
    }).toEqual({ code: "RUN_STATE_INVALID", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: before });
  } finally { fixture.cleanup(); }
});

test("FB-045 rejects a tampered accepted artifact materialization before providers or writes", async () => {
  const fixture = await makePaused("tampered-materialization");
  try {
    const artifactPath = path.join(fixture.project, ".nodulus", "runs", fixture.runId, "nodes/prepare/artifacts/prepared.json");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { data: { text: string } };
    artifact.data.text = "changed outside the accepted attempt";
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    const result = await resumeForError({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Add the missing behavior." } }, counter.provider);
    expect({
      code: errorCode(result),
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: JSON.stringify(snapshotRun(fixture.project, fixture.runId)) === JSON.stringify(before),
    }).toEqual({ code: "FEEDBACK_STATE_INVALID", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: true });
    expect(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "nodes/prepare/attempt-001/result.json"), "utf8")).not.toContain("changed outside the accepted attempt");
  } finally { fixture.cleanup(); }
});

test("FB-045 allows an ordinary pre-region caller-input pause without feedback checkpoint state", async () => {
  const fixture = createFeedbackProject("caller-input-before-region");
  fixture.writeResponses(acceptedResponses());
  try {
    const workflow = readProjectJson(fixture.project, ".nodulus/workflows/example.json");
    workflow.inputs = { objective: { contract: "request.v1" } };
    writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);
    const initial = await runWorkflow({
      projectRoot: fixture.project,
      cwd: fixture.project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Review and revise this workflow." }],
    }, fixture.provider);
    expect(initial.status).toBe("needs_input");
    expect(existsSync(fixture.tracePath)).toBe(false);
    const checkpoint = readRunJson(fixture.project, initial.runId);
    expect(checkpoint).toMatchObject({ pendingKind: "caller_inputs", completedNodes: [] });
    expect(checkpoint.feedbackRouting).toBeUndefined();
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", initial.runId, "pending/request.json"), "utf8")) as { id: string };
    const resumed = await resumeWorkflow({ projectRoot: fixture.project, runId: initial.runId, requestId: pending.id, answers: { objective: "Write concise documentation." } }, fixture.provider);
    expect(resumed.status).toBe("success");
    expect(fixture.readTrace().map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review", "continue"]);
    expect(readRunJson(fixture.project, initial.runId).feedbackRouting.regions["content-review"].deadlineAtMs).toEqual(expect.any(Number));
  } finally { fixture.cleanup(); }
});

test("FB-045 rejects a node pause forged into a caller-input pause after deleting route state", async () => {
  const fixture = await makePaused("forged-caller-input-pause");
  try {
    const checkpoint = readRunJson(fixture.project, fixture.runId);
    checkpoint.pendingKind = "caller_inputs";
    checkpoint.activeNode = null;
    checkpoint.completedNodes = [];
    checkpoint.attempt = 0;
    delete checkpoint.pendingNodeId;
    delete checkpoint.feedbackRouting;
    writeRunJson(fixture.project, fixture.runId, checkpoint);
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    const result = await resumeForError({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Add the missing behavior." } }, counter.provider);
    expect({
      code: errorCode(result),
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: snapshotRun(fixture.project, fixture.runId),
    }).toEqual({ code: "RUN_STATE_INVALID", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: before });
  } finally { fixture.cleanup(); }
});

test("FB-045 rejects an unknown pending kind before provider probes or writes", async () => {
  const fixture = await makePaused("unknown-pending-kind");
  try {
    const checkpoint = readRunJson(fixture.project, fixture.runId);
    checkpoint.pendingKind = "unknown_pending_type";
    writeRunJson(fixture.project, fixture.runId, checkpoint);
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    const result = await resumeForError({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Add the missing behavior." } }, counter.provider);
    expect({
      code: errorCode(result),
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: snapshotRun(fixture.project, fixture.runId),
    }).toEqual({ code: "RUN_STATE_INVALID", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: before });
  } finally { fixture.cleanup(); }
});

test("FB-045 rejects non-array completedNodes on a legitimate caller-input pause", async () => {
  const fixture = createFeedbackProject("caller-input-null-completed");
  fixture.writeResponses(acceptedResponses());
  try {
    const workflow = readProjectJson(fixture.project, ".nodulus/workflows/example.json");
    workflow.inputs = { objective: { contract: "request.v1" } };
    writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);
    const initial = await runWorkflow({ projectRoot: fixture.project, cwd: fixture.project, workflow: "example", sources: [{ kind: "inline", text: "Review this workflow." }] }, fixture.provider);
    expect(initial.status).toBe("needs_input");
    const checkpoint = readRunJson(fixture.project, initial.runId);
    checkpoint.completedNodes = null;
    writeRunJson(fixture.project, initial.runId, checkpoint);
    const before = snapshotRun(fixture.project, initial.runId);
    const traceBefore = { exists: existsSync(fixture.tracePath), contents: existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, "utf8") : "" };
    const counter = countedProvider({ ...fixture, runId: initial.runId });
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", initial.runId, "pending/request.json"), "utf8")) as { id: string };
    const result = await resumeForError({ projectRoot: fixture.project, runId: initial.runId, requestId: pending.id, answers: { objective: "Write a concise report." } }, counter.provider);
    expect({
      code: errorCode(result),
      providerCalls: counter.calls(),
      traceUnchanged: existsSync(fixture.tracePath) === traceBefore.exists && (!traceBefore.exists || readFileSync(fixture.tracePath, "utf8") === traceBefore.contents),
      runTreeUnchanged: snapshotRun(fixture.project, initial.runId),
    }).toEqual({ code: "RUN_STATE_INVALID", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: before });
  } finally { fixture.cleanup(); }
});

test("FB-045 refuses a paused run with an unresolved provider call event", async () => {
  const fixture = await makePaused("unresolved-call");
  try {
    const runDirectory = path.join(fixture.project, ".nodulus", "runs", fixture.runId);
    const eventsPath = path.join(runDirectory, "events.jsonl");
    const events = readFileSync(eventsPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    const started = events.findLast((event) => event.event === "provider.call.started");
    expect(started?.callId).toEqual(expect.any(String));
    writeFileSync(eventsPath, `${events.filter((event) => !(event.event === "provider.call.completed" && event.callId === started?.callId)).map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const before = snapshotRun(fixture.project, fixture.runId);
    const traceLength = fixture.readTrace().length;
    const counter = countedProvider(fixture);
    const pending = JSON.parse(readFileSync(path.join(runDirectory, "pending/request.json"), "utf8")) as { id: string };
    const resumed = await resumeWorkflow({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Add the missing behavior." } }, counter.provider)
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    expect({
      code: "error" in resumed ? (resumed.error as { code?: string }).code : (resumed.result.result as { error?: { code?: string } }).error?.code,
      providerCalls: counter.calls(),
      traceUnchanged: fixture.readTrace().length === traceLength,
      runTreeUnchanged: JSON.stringify(snapshotRun(fixture.project, fixture.runId)) === JSON.stringify(before),
    }).toEqual({ code: "RUN_RECOVERY_REQUIRED", providerCalls: { invocation: 0, availability: 0 }, traceUnchanged: true, runTreeUnchanged: true });
  } finally { fixture.cleanup(); }
});

test("FB-045 invalidates a reused docs generation after a later FIX_DOCS route", async () => {
  const responses: FeedbackFixtureResponse[] = [
    { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "prepared once" },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 1" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 1" },
    { nodeId: "review", kind: "decision", decisionCode: "FIX_BUILD", reason: "Revise build.", findings: [{ id: "BUILD-1" }] },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 2" },
    { nodeId: "review", kind: "decision", decisionCode: "FIX_DOCS", reason: "Now revise docs.", findings: [{ id: "DOC-2" }] },
    { nodeId: "docs", rawOutcome: pauseOutcome } as FeedbackFixtureResponse,
  ];
  const fixture = await makePaused("mixed-target-invalidation", responses);
  try {
    const checkpoint = readRunJson(fixture.project, fixture.runId);
    const region = checkpoint.feedbackRouting.regions["content-review"];
    const originalDocs = region.generationHistory.find((entry: Record<string, unknown>) => entry.nodeId === "docs" && entry.outputName === "readme" && entry.iteration === 1);
    expect(originalDocs).toMatchObject({ status: "invalidated" });
    expect(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "nodes/docs/attempt-001/result.json"), "utf8")).toContain("docs generation 1");
    expect(fixture.readTrace().map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review", "build", "review", "docs"]);
    const pending = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    fixture.writeResponses([
      ...responses,
      { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 2" },
      { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 3" },
      { nodeId: "review", kind: "decision", decisionCode: "ACCEPT", reason: "Accepted.", findings: [] },
      { nodeId: "continue", rawOutcome: pauseOutcome } as FeedbackFixtureResponse,
      { nodeId: "continue", name: "continued", contract: "continued.v1", text: "continued" },
    ]);
    const resumed = await resumeWorkflow({ projectRoot: fixture.project, runId: fixture.runId, requestId: pending.id, answers: { detail: "Revise the docs." } }, fixture.provider);
    expect(resumed.status).toBe("needs_input");
    const acceptedRegion = readRunJson(fixture.project, fixture.runId).feedbackRouting.regions["content-review"];
    expect(acceptedRegion).toMatchObject({ completedAtMs: expect.any(Number), eligibleNodes: [] });
    const continuationRequest = JSON.parse(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "pending/request.json"), "utf8")) as { id: string };
    const continuation = await resumeWorkflow({ projectRoot: fixture.project, runId: fixture.runId, requestId: continuationRequest.id, answers: { detail: "Continue after accepting the revision." } }, fixture.provider);
    expect(continuation.status).toBe("success");
    expect(fixture.readTrace().map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review", "build", "review", "docs", "docs", "build", "review", "continue", "continue"]);
    expect(readFileSync(path.join(fixture.project, ".nodulus", "runs", fixture.runId, "nodes/docs/attempt-001/result.json"), "utf8")).toContain("docs generation 1");
  } finally { fixture.cleanup(); }
}, 30000);

test("FB-045 resumes from captured definitions in a fresh OS process and leaves invalid submissions unchanged", async () => {
  const completed = pauseResponses();
  const responses = [
    ...completed,
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 2" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 2" },
    { nodeId: "review", kind: "decision", decisionCode: "ACCEPT", reason: "Accepted.", findings: [] },
    { nodeId: "continue", name: "continued", contract: "continued.v1", text: "continued" },
  ] as FeedbackFixtureResponse[];
  const fixture = await makePaused("new-process-resume", completed);
  try {
    const runDirectory = path.join(fixture.project, ".nodulus", "runs", fixture.runId);
    const pending = JSON.parse(readFileSync(path.join(runDirectory, "pending/request.json"), "utf8")) as { id: string };
    const beforeInvalid = snapshotRun(fixture.project, fixture.runId);
    const worker = path.resolve("tests/fixtures/fb-045-resume-worker.mjs");
    const invalidId = spawnSync(process.execPath, [worker, fixture.project, fixture.runId, "wrong-request-id", JSON.stringify({ detail: "Valid answer." }), fixture.responsesPath, fixture.tracePath], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(invalidId.status).toBe(0);
    expect(JSON.parse(invalidId.stdout)).toMatchObject({ error: { code: "PENDING_REQUEST_MISMATCH" } });
    expect(snapshotRun(fixture.project, fixture.runId)).toEqual(beforeInvalid);
    const invalidAnswer = spawnSync(process.execPath, [worker, fixture.project, fixture.runId, pending.id, JSON.stringify({ detail: 12 }), fixture.responsesPath, fixture.tracePath], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(invalidAnswer.status).toBe(0);
    expect(JSON.parse(invalidAnswer.stdout)).toMatchObject({ error: { code: "ANSWERS_INVALID" } });
    expect(snapshotRun(fixture.project, fixture.runId)).toEqual(beforeInvalid);

    fixture.writeResponses(responses);
    writeFileSync(path.join(fixture.project, ".nodulus", "workflows", "example.json"), "{ invalid changed on-disk workflow", "utf8");
    writeFileSync(path.join(fixture.project, ".nodulus", "settings.json"), "{ invalid changed on-disk settings", "utf8");
    const saved = readRunJson(fixture.project, fixture.runId);
    const originalRegion = structuredClone(saved.feedbackRouting.regions["content-review"]);
    const resumed = spawnSync(process.execPath, [worker, fixture.project, fixture.runId, pending.id, JSON.stringify({ detail: "Captured context answer." }), fixture.responsesPath, fixture.tracePath], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "success" });
    const trace = fixture.readTrace();
    expect(trace.map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review", "docs", "docs", "build", "review", "continue"]);
    expect(trace.slice(5).map((call) => call.call?.attempt)).toEqual([3, 2, 2, 1]);
    const terminal = readRunJson(fixture.project, fixture.runId).feedbackRouting.regions["content-review"];
    expect(terminal).toMatchObject({ iteration: originalRegion.iteration, providerCalls: originalRegion.providerCalls + 3, deadlineAtMs: originalRegion.deadlineAtMs });
    expect(terminal.generationHistory).toEqual(expect.arrayContaining(originalRegion.generationHistory));
    expect(terminal.invalidatedSuffixes).toEqual(expect.arrayContaining(originalRegion.invalidatedSuffixes));
    expect(terminal.uncertainCalls).toEqual(originalRegion.uncertainCalls);
    expect(readFileSync(path.join(runDirectory, "nodes/review/attempt-001/result.json"), "utf8")).toContain("FIX_DOCS");
  } finally {
    fixture.cleanup();
  }
});

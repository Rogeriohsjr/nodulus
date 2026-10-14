import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import { inspectWorkflow } from "../../src/application/inspect-workflow.js";
import { intakeRequest } from "../../src/application/intake.js";
import { runWorkflow } from "../../src/application/run-workflow.js";
import {
  acceptedResponses,
  createFeedbackProject,
  fixBuildResponses,
} from "../support/feedback-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

function request(projectRoot: string) {
  return { projectRoot, cwd: projectRoot, workflow: "example", sources: [{ kind: "inline" as const, text: "Review the example and route any needed revision." }] };
}

function expectRejectedDecision(fixture: ReturnType<typeof createFeedbackProject>, runId: string, code: string): void {
  const runDirectory = path.join(fixture.project, ".nodulus", "runs", runId);
  const attemptDirectory = path.join(runDirectory, "nodes", "review", "attempt-001");
  expect(JSON.parse(readFileSync(path.join(runDirectory, "run.json"), "utf8"))).toMatchObject({ status: "error" });
  expect(JSON.parse(readFileSync(path.join(runDirectory, "result.json"), "utf8"))).toMatchObject({ status: "error", error: { code } });
  expect(JSON.parse(readFileSync(path.join(attemptDirectory, "validation.json"), "utf8"))).toMatchObject({ valid: false, code });
  expect(JSON.parse(readFileSync(path.join(attemptDirectory, "result.json"), "utf8"))).toMatchObject({ status: "error", error: { code } });
  expect(readFileSync(path.join(attemptDirectory, "response.raw.txt"), "utf8")).toContain('"status":"success"');
  expect(existsSync(path.join(runDirectory, "nodes", "review", "artifacts", "decision.json"))).toBe(false);
  const events = readFileSync(path.join(runDirectory, "events.jsonl"), "utf8")
    .trim().split(/\r?\n/).map((line) => JSON.parse(line) as { event: string; nodeId?: string; valid?: boolean });
  expect(events.some((event) => event.event === "node.rejected" && event.nodeId === "review")).toBe(true);
  expect(events.some((event) => event.event === "node.validation.completed" && event.nodeId === "review" && event.valid)).toBe(false);
  expect(events.some((event) => event.event === "node.succeeded" && event.nodeId === "review")).toBe(false);
}

test("FB-030 sends only the decision node's mapped accepted outputs as artifact references", async () => {
  const fixture = createFeedbackProject("mapped-outputs");
  fixture.writeResponses(acceptedResponses());
  try {
    const result = await runWorkflow(request(fixture.project), fixture.provider);
    expect(result.status).toBe("success");
    const calls = fixture.readTrace();
    const review = calls.find((call) => call.nodeId === "review");
    const references = review?.inputs.artifactReferences as Array<Record<string, unknown>>;
    expect(references.map((reference) => reference.nodeId)).toEqual(["docs", "build"]);
    expect(references.every((reference) => typeof reference.generationId === "string" && reference.generationId.length > 0)).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test("FB-030 preserves the actual generation identity of a reused prefix after FIX_BUILD", async () => {
  const fixture = createFeedbackProject("reused-generation");
  fixture.writeResponses(fixBuildResponses());
  try {
    const result = await runWorkflow(request(fixture.project), fixture.provider);
    expect(result.status).toBe("success");
    const reviews = fixture.readTrace().filter((call) => call.nodeId === "review");
    const first = reviews[0]?.inputs.artifactReferences as Array<Record<string, unknown>>;
    const second = reviews[1]?.inputs.artifactReferences as Array<Record<string, unknown>>;
    const firstDocs = first.find((reference) => reference.nodeId === "docs");
    const secondDocs = second.find((reference) => reference.nodeId === "docs");
    const secondBuild = second.find((reference) => reference.nodeId === "build");
    expect(secondDocs).toMatchObject({ iteration: 1, generationId: firstDocs?.generationId, sha256: firstDocs?.sha256 });
    expect(secondDocs?.generationId).toBeTruthy();
    expect(secondBuild).toMatchObject({ iteration: 2, generationId: expect.any(String) });
    expect(secondBuild?.generationId).not.toBe(first.find((reference) => reference.nodeId === "build")?.generationId);
    expect(second.map((reference) => reference.nodeId)).toEqual(["docs", "build"]);
  } finally {
    fixture.cleanup();
  }
});

test.each(["missing", "duplicate", "stale", "forged-digest", "unmapped"] as const)("FB-030 rejects %s returned references", async (mode) => {
  const fixture = createFeedbackProject("invalid-reference-" + mode);
  const responses = acceptedResponses();
  responses[3] = { ...responses[3]!, artifactRefsMode: mode };
  fixture.writeResponses(responses);
  try {
    const result = await runWorkflow(request(fixture.project), fixture.provider);
    expect(result.status, mode).toBe("error");
    expect(result.result, mode).toMatchObject({ error: { code: "FEEDBACK_REFERENCES_INVALID" } });
    expect(fixture.readTrace().some((call) => call.nodeId === "continue"), mode).toBe(false);
    expectRejectedDecision(fixture, result.runId, "FEEDBACK_REFERENCES_INVALID");
  } finally {
    fixture.cleanup();
  }
});

test("FB-030 treats inherited route-code properties as undeclared decisions", async () => {
  const fixture = createFeedbackProject("inherited-route");
  const responses = acceptedResponses();
  responses[3] = { ...responses[3]!, decisionCode: "toString" };
  fixture.writeResponses(responses);
  try {
    const execution = await runWorkflow(request(fixture.project), fixture.provider)
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    expect(execution).toMatchObject({ result: { status: "error", result: { error: { code: "FEEDBACK_DECISION_INVALID" } } } });
    expect(fixture.readTrace().map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review"]);
    if ("result" in execution) expectRejectedDecision(fixture, execution.result.runId, "FEEDBACK_DECISION_INVALID");
  } finally {
    fixture.cleanup();
  }
});

test("FB-030 rejects an unknown ordinary decision code before continuation", async () => {
  const fixture = createFeedbackProject("unknown-route-code");
  const responses = acceptedResponses();
  responses[3] = { ...responses[3]!, decisionCode: "NO_SUCH_ROUTE" };
  fixture.writeResponses(responses);
  try {
    const result = await runWorkflow(request(fixture.project), fixture.provider);
    expect(result.status).toBe("error");
    expect(result.result).toMatchObject({ error: { code: "FEEDBACK_DECISION_INVALID" } });
    expect(fixture.readTrace().map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review"]);
    expectRejectedDecision(fixture, result.runId, "FEEDBACK_DECISION_INVALID");
  } finally {
    fixture.cleanup();
  }
});

test("FB-030 rejects a wrong-type code when the declared schema allows it", async () => {
  const fixture = createFeedbackProject("wrong-type-route-code");
  const schema = readProjectJson(fixture.project, ".nodulus/contracts/workflow-decision.v1.schema.json");
  schema.properties.decisionCode = {};
  writeJson(fixture.project, ".nodulus/contracts/workflow-decision.v1.schema.json", schema);
  const responses = acceptedResponses();
  responses[3] = { ...responses[3]!, decisionCode: 42 };
  fixture.writeResponses(responses);
  try {
    const result = await runWorkflow(request(fixture.project), fixture.provider);
    expect(result.status).toBe("error");
    expect(result.result).toMatchObject({ error: { code: "FEEDBACK_DECISION_INVALID" } });
    expect(fixture.readTrace().map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review"]);
    expectRejectedDecision(fixture, result.runId, "FEEDBACK_DECISION_INVALID");
  } finally {
    fixture.cleanup();
  }
});

test("FB-030 accepts an author-defined code when it maps to continuation", async () => {
  const fixture = createFeedbackProject("alternate-accept-code");
  const workflow = readProjectJson(fixture.project, ".nodulus/workflows/example.json");
  workflow.feedbackRouting.routes = { FIX_DOCS: "docs", FIX_BUILD: "build", SHIP_IT: "continue" };
  writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);
  const responses = acceptedResponses();
  responses[3] = { ...responses[3]!, decisionCode: "SHIP_IT" };
  fixture.writeResponses(responses);
  try {
    const result = await runWorkflow(request(fixture.project), fixture.provider);
    expect(result.status).toBe("success");
    expect(fixture.readTrace().map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review", "continue"]);
  } finally {
    fixture.cleanup();
  }
});

test("FB-030 references accepted outputs produced before a decision-self region", async () => {
  const fixture = createFeedbackProject("decision-self-prefix");
  const workflow = readProjectJson(fixture.project, ".nodulus/workflows/example.json");
  workflow.feedbackRouting = {
    ...workflow.feedbackRouting,
    startNode: "review",
    routes: { RETRY_REVIEW: "review", SHIP_IT: "continue" },
    reentrySafeNodes: ["review"],
    limits: { maxIterations: 2, maxProviderCalls: 8, maxElapsedMs: 3_600_000 },
  };
  writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);
  const responses = acceptedResponses();
  responses[3] = { ...responses[3]!, decisionCode: "RETRY_REVIEW" };
  responses.splice(4, 0, { ...acceptedResponses()[3]!, decisionCode: "SHIP_IT" });
  fixture.writeResponses(responses);
  try {
    const result = await runWorkflow(request(fixture.project), fixture.provider);
    expect(result.status, JSON.stringify(result.result)).toBe("success");
    const trace = fixture.readTrace();
    expect(trace.map((call) => call.nodeId)).toEqual(["prepare", "docs", "build", "review", "review", "continue"]);
    const references = trace.filter((call) => call.nodeId === "review").map((call) => call.inputs.artifactReferences as Array<Record<string, unknown>>);
    expect(references.map((items) => items.map((reference) => reference.nodeId))).toEqual([["docs", "build"], ["docs", "build"]]);
    expect(references[1]).toEqual(references[0]);
    expect(references[1]?.[0]).toMatchObject({ iteration: 1, generationId: expect.any(String), sha256: expect.any(String) });
    expect(references[1]?.[1]).toMatchObject({ iteration: 1, generationId: expect.any(String), sha256: expect.any(String) });
  } finally {
    fixture.cleanup();
  }
});

test("FB-030 rejects author mappings that collide with reserved feedback runtime inputs", async () => {
  const fixture = createFeedbackProject("reserved-input");
  const review = readProjectJson(fixture.project, ".nodulus/nodes/review.json");
  review.inputs.artifactReferences = { from: "prepare.prepared", contract: "prepared.v1" };
  writeJson(fixture.project, ".nodulus/nodes/review.json", review);
  try {
    const storage = new LocalIntakeStorage();
    const runsPath = path.join(fixture.project, ".nodulus", "runs");
    mkdirSync(runsPath, { recursive: true });
    const runsBefore = readdirSync(runsPath);
    await expect(inspectWorkflow(fixture.project, "example")).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(readdirSync(runsPath)).toEqual(runsBefore);
    await expect(intakeRequest(request(fixture.project), storage)).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(readdirSync(runsPath)).toEqual(runsBefore);
  } finally {
    fixture.cleanup();
  }
});

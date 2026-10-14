import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { resumeWorkflow } from "../../src/application/resume-workflow.js";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import { createInitializedProject } from "../support/intake-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

test("FB-020 preserves routed state and attempt history across a fresh resume", async () => {
  const project = createInitializedProject("fb-020-resume");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "nodulus-fb020-"));
  const responsesPath = path.join(temporary, "responses.json");
  const tracePath = path.join(temporary, "trace.jsonl");
  const nodeIds = ["prepare", "docs", "build", "review", "continue"];
  const route = {
    schemaVersion: 1, regionId: "content-review", startNode: "prepare", decisionNode: "review",
    decisionOutput: { name: "decision", contract: "workflow-decision.v1" }, continuationNode: "continue",
    routes: { FIX_DOCS: "docs", ACCEPT: "continue" }, reentrySafeNodes: nodeIds.slice(0, 4),
    limits: { maxIterations: 2, maxProviderCalls: 12, maxElapsedMs: 3600000 },
  };
  writeJson(project, ".nodulus/contracts/request.v1.schema.json", { type: "string", minLength: 1 });
  const contracts: Record<string, Record<string, unknown>> = {
    "prepared.v1": { text: { type: "string" } }, "readme.v1": { text: { type: "string" } },
    "build.v1": { text: { type: "string" } }, "continued.v1": { text: { type: "string" } },
    "workflow-decision.v1": { decisionCode: { type: "string" }, reason: { type: "string" }, findings: { type: "array", items: { type: "object" } }, artifactRefs: { type: "array", items: { type: "object" } } },
  };
  for (const [name, properties] of Object.entries(contracts)) writeJson(project, `.nodulus/contracts/${name}.schema.json`, { type: "object", required: Object.keys(properties), properties, additionalProperties: false });
  writeJson(project, ".nodulus/workflows/example.json", { schemaVersion: 1, id: "example", nodes: nodeIds, feedbackRouting: route });
  const nodeDefs = [
    ["prepare", "request", "request", "request.v1", "prepared", "prepared.v1"],
    ["docs", "prepared", "prepare.prepared", "prepared.v1", "readme", "readme.v1"],
    ["build", "readme", "docs.readme", "readme.v1", "build", "build.v1"],
    ["review", "build", "build.build", "build.v1", "decision", "workflow-decision.v1"],
    ["continue", "decision", "review.decision", "workflow-decision.v1", "continued", "continued.v1"],
  ];
  for (const [id, input, from, inputContract, output, outputContract] of nodeDefs) {
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`);
    writeJson(project, `.nodulus/nodes/${id}.json`, { schemaVersion: 1, id, providerProfile: "fixture", instructions: [`.nodulus/instructions/${id}.md`], inputs: { [input]: { from, contract: inputContract } }, expectedOutputs: [{ name: output, contract: outputContract }] });
  }
  const review = readProjectJson(project, ".nodulus/nodes/review.json");
  review.inputs.docs = { from: "docs.readme", contract: "readme.v1" };
  writeJson(project, ".nodulus/nodes/review.json", review);
  const settings = readProjectJson(project, ".nodulus/settings.json");
  settings.providerProfiles.fixture = { enabled: true, executable: process.execPath, model: "fixture", timeoutMs: 5000 };
  writeJson(project, ".nodulus/settings.json", settings);
  const responses = [
    { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "prepared once" },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 1" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 1" },
    { nodeId: "review", kind: "decision", decisionCode: "FIX_DOCS", reason: "Revise docs", findings: [{ id: "DOC-1" }] },
    { nodeId: "docs", rawOutcome: JSON.stringify({ status: "needs_input", request: { id: "clarify-docs", questions: [{ id: "detail", message: "Clarify the docs." }], answerContract: { type: "object", required: ["detail"], properties: { detail: { type: "string" } }, additionalProperties: false } } }) },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 2" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 2" },
    { nodeId: "review", kind: "decision", decisionCode: "ACCEPT", reason: "Accepted", findings: [] },
    { nodeId: "continue", name: "continued", contract: "continued.v1", text: "done" },
  ];
  writeFileSync(responsesPath, JSON.stringify({ responses }), "utf8");
  const fixture = fileURLToPath(new URL("../fixtures/flow-015-feedback-routing-provider.mjs", import.meta.url));
  const provider = { async invoke(invocation: unknown) {
    const child = spawnSync(process.execPath, [fixture, responsesPath, tracePath], { cwd: temporary, input: JSON.stringify(invocation), encoding: "utf8", timeout: 5000, windowsHide: true });
    if (child.error || child.status !== 0) throw new Error(child.error?.message ?? child.stderr ?? `Fixture exited ${child.status}`);
    return child.stdout;
  } };
  const storage = new LocalIntakeStorage();
  try {
    const initial = await runWorkflow({ projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline", text: "Build and review." }] }, provider);
    expect(initial.status).toBe("needs_input");
    const pausedText = await storage.readRunFile(project, initial.runId, "run.json");
    const paused = JSON.parse(pausedText) as { feedbackRouting?: { regions?: Record<string, { iteration: number; feedback?: unknown; generationHistory: unknown[]; invalidatedSuffixes: unknown[]; providerCalls?: number }> } };
    const region = paused.feedbackRouting?.regions?.["content-review"];
    expect(region).toMatchObject({ iteration: 2, feedback: { decisionCode: "FIX_DOCS" }, providerCalls: 5 });
    expect(region?.generationHistory).toHaveLength(3);
    const attemptTwo = await storage.readRunFile(project, initial.runId, "nodes/docs/attempt-002/response.raw.txt");
    const firstGeneration = await storage.readRunFile(project, initial.runId, "nodes/docs/attempt-001/result.json");
    const firstReviewResult = await storage.readRunFile(project, initial.runId, "nodes/review/attempt-001/result.json");
    const firstReviewResponse = await storage.readRunFile(project, initial.runId, "nodes/review/attempt-001/response.raw.txt");
    const firstReviewInvocation = await storage.readRunFile(project, initial.runId, "nodes/review/attempt-001/invocation.json");
    const firstReviewValidation = await storage.readRunFile(project, initial.runId, "nodes/review/attempt-001/validation.json");
    const pending = JSON.parse(await storage.readRunFile(project, initial.runId, "pending/request.json")) as { id: string };
    const resumed = await resumeWorkflow({ projectRoot: project, runId: initial.runId, requestId: pending.id, answers: { detail: "Include empty input." } }, provider);
    expect(resumed.status).toBe("success");
    expect(await storage.readRunFile(project, initial.runId, "nodes/docs/attempt-002/response.raw.txt")).toBe(attemptTwo);
    expect(await storage.readRunFile(project, initial.runId, "nodes/docs/attempt-001/result.json")).toBe(firstGeneration);
    expect(await storage.readRunFile(project, initial.runId, "nodes/review/attempt-001/result.json")).toBe(firstReviewResult);
    expect(await storage.readRunFile(project, initial.runId, "nodes/review/attempt-001/response.raw.txt")).toBe(firstReviewResponse);
    expect(await storage.readRunFile(project, initial.runId, "nodes/review/attempt-001/invocation.json")).toBe(firstReviewInvocation);
    expect(await storage.readRunFile(project, initial.runId, "nodes/review/attempt-001/validation.json")).toBe(firstReviewValidation);
    const trace = readFileSync(tracePath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as { nodeId: string; attempt?: number; inputs?: Record<string, unknown> });
    expect(trace.map(({ nodeId }) => nodeId)).toEqual(["prepare", "docs", "build", "review", "docs", "docs", "build", "review", "continue"]);
    expect(trace.filter(({ nodeId }) => nodeId === "docs").map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
    expect(trace.filter(({ nodeId }) => nodeId === "review").map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(trace[5]?.inputs?.feedback).toMatchObject({ decisionCode: "FIX_DOCS", findings: [{ id: "DOC-1" }] });
    const terminal = JSON.parse(await storage.readRunFile(project, initial.runId, "run.json")) as typeof paused;
    expect(terminal.feedbackRouting?.regions?.["content-review"]).toMatchObject({ iteration: 2, feedback: { decisionCode: "FIX_DOCS" }, generationHistory: expect.arrayContaining([expect.objectContaining({ nodeId: "docs", attemptPath: "nodes/docs/attempt-003/result.json", iteration: 2 })]) });
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

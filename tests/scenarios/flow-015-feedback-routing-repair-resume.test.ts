import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ProviderInvocation, type ProviderPort } from "../../src/application/run-workflow.js";
import { resumeWorkflow } from "../../src/application/resume-workflow.js";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import { createInitializedProject } from "../support/intake-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

const command = "npx vitest run tests/scenarios/flow-015-feedback-routing-repair-resume.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=.nodulus/checkpoints/feedback-routing/fb-020-repair-resume-test/focused.json";
const retained = ["invocation.json", "response.raw.txt", "validation.json", "result.json"] as const;
type Trace = { nodeId: string; call?: { operation?: string; attempt?: number }; inputs?: Record<string, unknown>; answers?: Record<string, unknown> };

function provider(temporary: string): ProviderPort {
  const fixture = path.resolve("tests/fixtures/flow-015-feedback-routing-repair-resume-provider.mjs");
  const responses = path.join(temporary, "responses.json");
  const trace = path.join(temporary, "trace.jsonl");
  const execute = async (invocation: ProviderInvocation): Promise<string> => {
    const result = spawnSync(process.execPath, [fixture, responses, trace], {
      cwd: temporary, input: JSON.stringify(invocation), encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `Fixture exited ${result.status}`);
    return result.stdout;
  };
  return { invoke: execute, async repairResponse(invocation) { return execute(invocation); } };
}

function configure(project: string): void {
  const nodes = ["prepare", "docs", "build", "review", "continue"];
  const contracts: Record<string, unknown> = {
    "prepared.v1": { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
    "readme.v1": { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
    "build.v1": { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
    "workflow-decision.v1": { type: "object", required: ["decisionCode", "reason", "findings", "artifactRefs"], properties: { decisionCode: { type: "string" }, reason: { type: "string" }, findings: { type: "array", items: { type: "object" } }, artifactRefs: { type: "array", items: { type: "object" } } }, additionalProperties: false },
    "continued.v1": { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
  };
  writeJson(project, ".nodulus/contracts/request.v1.schema.json", { type: "string", minLength: 1 });
  for (const [name, schema] of Object.entries(contracts)) writeJson(project, `.nodulus/contracts/${name}.schema.json`, schema);
  writeJson(project, ".nodulus/workflows/example.json", { schemaVersion: 1, id: "example", nodes, feedbackRouting: {
    schemaVersion: 1, regionId: "content-review", startNode: "prepare", decisionNode: "review",
    decisionOutput: { name: "decision", contract: "workflow-decision.v1" }, continuationNode: "continue",
    routes: { FIX_DOCS: "docs", ACCEPT: "continue" }, reentrySafeNodes: nodes.slice(0, 4),
    limits: { maxIterations: 2, maxProviderCalls: 12, maxElapsedMs: 3_600_000 },
  } });
  const defs: Record<string, [string, string, string, string, string, string]> = {
    prepare: ["request", "request", "request.v1", "prepared", "prepared.v1", "prepare"],
    docs: ["prepared", "prepare.prepared", "prepared.v1", "readme", "readme.v1", "docs"],
    build: ["readme", "docs.readme", "readme.v1", "build", "build.v1", "build"],
    review: ["build", "build.build", "build.v1", "decision", "workflow-decision.v1", "review"],
    continue: ["decision", "review.decision", "workflow-decision.v1", "continued", "continued.v1", "continue"],
  };
  for (const id of nodes) {
    const [input, from, inputContract, output, outputContract] = defs[id]!;
    writeJson(project, `.nodulus/nodes/${id}.json`, { schemaVersion: 1, id, providerProfile: "fixture", instructions: [`.nodulus/instructions/${id}.md`], inputs: { [input]: { from, contract: inputContract } }, expectedOutputs: [{ name: output, contract: outputContract }] });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`);
  }
  const review = readProjectJson(project, ".nodulus/nodes/review.json");
  review.inputs.docs = { from: "docs.readme", contract: "readme.v1" };
  writeJson(project, ".nodulus/nodes/review.json", review);
  const settings = readProjectJson(project, ".nodulus/settings.json");
  settings.providerProfiles.fixture = { enabled: true, executable: process.execPath, model: "fixture", timeoutMs: 5000, capabilities: ["responseRepair"] };
  writeJson(project, ".nodulus/settings.json", settings);
}

test("FB-020 repaired routing evidence survives a fresh resume", async () => {
  const project = createInitializedProject("fb-020-repair-resume");
  const temporary = mkdtempSync(path.join(tmpdir(), "nodulus-fb020-repair-resume-"));
  configure(project);
  const entries = [
    { nodeId: "prepare", operation: "invoke", attempt: 1, name: "prepared", contract: "prepared.v1", text: "prepare once" },
    { nodeId: "docs", operation: "invoke", attempt: 1, name: "readme", contract: "readme.v1", text: "docs first" },
    { nodeId: "build", operation: "invoke", attempt: 1, name: "build", contract: "build.v1", text: "build first" },
    { nodeId: "review", operation: "invoke", attempt: 1, rawOutcome: "{invalid response" },
    { nodeId: "review", operation: "repair_response", attempt: 2, kind: "decision", decisionCode: "FIX_DOCS", reason: "Revise the docs.", findings: [{ id: "DOC-1", severity: "required", message: "Clarify behavior." }] },
    { nodeId: "docs", operation: "invoke", attempt: 2, rawOutcome: JSON.stringify({ status: "needs_input", request: { id: "clarify-docs", questions: [{ id: "detail", message: "Clarify the docs." }], answerContract: { type: "object", required: ["detail"], properties: { detail: { type: "string" } }, additionalProperties: false } } }) },
    { nodeId: "docs", operation: "invoke", attempt: 3, name: "readme", contract: "readme.v1", text: "docs revised with answer" },
    { nodeId: "build", operation: "invoke", attempt: 2, name: "build", contract: "build.v1", text: "build revised" },
    { nodeId: "review", operation: "invoke", attempt: 3, kind: "decision", decisionCode: "ACCEPT", reason: "Resolved.", findings: [] },
    { nodeId: "continue", operation: "invoke", attempt: 1, name: "continued", contract: "continued.v1", text: "done" },
  ];
  writeFileSync(path.join(temporary, "responses.json"), JSON.stringify({ entries }), "utf8");
  const storage = new LocalIntakeStorage();
  try {
    const firstProvider = provider(temporary);
    const initial = await runWorkflow({ projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline", text: "Review this routed workflow." }] }, firstProvider);
    if (initial.status !== "needs_input") {
      const run = initial.runId ? await storage.readRunFile(project, initial.runId, "run.json") : "no run id";
      console.error(`FB020_REPAIR_RESUME_INITIAL_FAILURE ${JSON.stringify({ status: initial.status, result: initial.result, run, trace: readFileSync(path.join(temporary, "trace.jsonl"), "utf8") })}`);
    }
    expect(initial.status).toBe("needs_input");
    const paused = JSON.parse(await storage.readRunFile(project, initial.runId, "run.json")) as { feedbackRouting?: { regions?: Record<string, { iteration: number; feedback?: unknown; generationHistory: unknown[]; invalidatedSuffixes: unknown[]; providerCalls: number }> } };
    const region = paused.feedbackRouting?.regions?.["content-review"];
    expect(region).toMatchObject({ iteration: 2, feedback: { decisionCode: "FIX_DOCS" }, providerCalls: 6 });
    expect(region?.generationHistory).toHaveLength(3);
    const base = `nodes/review/attempt-002/`;
    const before = retained.map((name) => {
      const bytes = Buffer.from(readFileSync(path.join(project, ".nodulus", "runs", initial.runId, base, name)));
      return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    const pending = JSON.parse(await storage.readRunFile(project, initial.runId, "pending/request.json")) as { id: string };
    const resumed = await resumeWorkflow({ projectRoot: project, runId: initial.runId, requestId: pending.id, answers: { detail: "Include the empty-input behavior." } }, provider(temporary));
    expect(resumed.status).toBe("success");
    const after = retained.map((name) => {
      const bytes = Buffer.from(readFileSync(path.join(project, ".nodulus", "runs", initial.runId, base, name)));
      return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    const equal = before.every((item, index) => item.name === after[index]?.name && item.bytes.equals(after[index]!.bytes) && item.sha256 === after[index]!.sha256);
    const trace = readFileSync(path.join(temporary, "trace.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Trace);
    const reviewAttempts = trace.filter((item) => item.nodeId === "review" && item.call?.operation === "invoke").map((item) => item.call?.attempt);
    const terminal = JSON.parse(await storage.readRunFile(project, initial.runId, "run.json")) as typeof paused;
    const finalRegion = terminal.feedbackRouting?.regions?.["content-review"];
    expect(trace.filter((item) => item.nodeId === "prepare" && item.call?.operation === "invoke")).toHaveLength(1);
    expect(trace.find((item) => item.nodeId === "docs" && item.call?.attempt === 3)?.answers).toMatchObject({ detail: "Include the empty-input behavior." });
    expect(reviewAttempts).toEqual([1, 3]);
    expect(finalRegion).toMatchObject({ iteration: 2, feedback: { decisionCode: "FIX_DOCS" } });
    expect(finalRegion?.generationHistory).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "docs", iteration: 2 })]));
    expect(finalRegion?.invalidatedSuffixes.length).toBeGreaterThan(0);
    expect(equal, "repair-002-retention-across-fresh-resume").toBe(true);
    console.info(`FB020_REPAIR_RESUME_EVIDENCE ${JSON.stringify({ command, trace: trace.map((item) => ({ nodeId: item.nodeId, operation: item.call?.operation, attempt: item.call?.attempt })), fileEvidence: before.map((item, index) => ({ file: item.name, beforeSha256: item.sha256, afterSha256: after[index]?.sha256 })), answerRequestId: pending.id })}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

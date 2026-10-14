import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ProviderInvocation, type ProviderPort } from "../../src/application/run-workflow.js";
import * as nodulusApi from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import { configureExpectedOutput, createRunRequest } from "../support/node-execution.js";

type InspectWorkflow = (projectRoot: string, workflowId: string) => Promise<unknown>;
const inspectWorkflow = (nodulusApi as unknown as { inspectWorkflow?: InspectWorkflow }).inspectWorkflow;

function fixtureProvider(temporary: string, rawOutcome: string): { provider: ProviderPort; tracePath: string } {
  const responsesPath = path.join(temporary, "outcomes.json");
  const tracePath = path.join(temporary, "trace.jsonl");
  writeFileSync(responsesPath, JSON.stringify({ responses: [{ nodeId: "example", rawOutcome }] }), "utf8");
  const fixturePath = fileURLToPath(new URL("../fixtures/flow-015-feedback-routing-provider.mjs", import.meta.url));
  return {
    tracePath,
    provider: {
      async invoke(invocation: ProviderInvocation): Promise<string> {
        const child = spawnSync(process.execPath, [fixturePath, responsesPath, tracePath], {
          cwd: temporary,
          input: JSON.stringify(invocation),
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        if (child.error || child.status !== 0) throw new Error(child.error?.message ?? child.stderr ?? `Fixture exited ${child.status}`);
        return child.stdout;
      },
    },
  };
}

function configureOutcomeProject(project: string): void {
  configureExpectedOutput(project, {
    name: "example",
    contract: "example.v1",
    schema: { type: "object", required: ["message"], properties: { message: { type: "string" } }, additionalProperties: false },
  });
}

test("FB-001C accepts a valid success envelope through runWorkflow and a real fixture process", async () => {
  const project = createInitializedProject("fb-001c-success");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "nodulus-fb-outcome-"));
  configureOutcomeProject(project);
  const { provider, tracePath } = fixtureProvider(temporary, JSON.stringify({
    status: "success", artifacts: [{ name: "example", contract: "example.v1", data: { message: "accepted" } }],
  }));
  try {
    const result = await runWorkflow(createRunRequest(project), provider);
    expect(result.status).toBe("success");
    const storage = new LocalIntakeStorage();
    expect(JSON.parse(await storage.readRunFile(project, result.runId, "nodes/example/attempt-001/result.json"))).toMatchObject({ status: "success", artifacts: [{ data: { message: "accepted" } }] });
    expect(readFileSync(`${tracePath}.cursor`, "utf8")).toBe("1");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("FB-001C accepts a valid system error envelope without an artifact", async () => {
  const project = createInitializedProject("fb-001c-error");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "nodulus-fb-outcome-"));
  configureOutcomeProject(project);
  const { provider, tracePath } = fixtureProvider(temporary, JSON.stringify({
    status: "error", error: { code: "FIXTURE_FAILURE", message: "The scripted node failed." },
  }));
  try {
    const result = await runWorkflow(createRunRequest(project), provider);
    expect(result.status).toBe("error");
    expect(result.result).toMatchObject({ error: { code: "FIXTURE_FAILURE", message: "The scripted node failed." } });
    const storage = new LocalIntakeStorage();
    expect(JSON.parse(await storage.readRunFile(project, result.runId, "nodes/example/attempt-001/validation.json"))).toMatchObject({ valid: true, outcome: "error" });
    expect(readFileSync(`${tracePath}.cursor`, "utf8")).toBe("1");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("FB-001C rejects a malformed inner provider outcome and persists its validation", async () => {
  const project = createInitializedProject("fb-001c-malformed");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "nodulus-fb-outcome-"));
  configureOutcomeProject(project);
  const { provider, tracePath } = fixtureProvider(temporary, "{not valid JSON");
  try {
    const result = await runWorkflow(createRunRequest(project), provider);
    expect(result.status).toBe("error");
    const storage = new LocalIntakeStorage();
    expect(JSON.parse(await storage.readRunFile(project, result.runId, "nodes/example/attempt-001/validation.json"))).toMatchObject({ valid: false, code: "INVALID_NODE_RESPONSE" });
    expect(JSON.parse(await storage.readRunFile(project, result.runId, "run.json"))).toMatchObject({ status: "error", error: { code: "RESPONSE_REPAIR_UNAVAILABLE" } });
    expect(readFileSync(`${tracePath}.cursor`, "utf8")).toBe("1");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

const feedbackRouting = {
  schemaVersion: 1,
  regionId: "content-review",
  startNode: "prepare",
  decisionNode: "review",
  decisionOutput: { name: "decision", contract: "workflow-decision.v1" },
  continuationNode: "continue",
  routes: { FIX_DOCS: "docs", FIX_BUILD: "build", ACCEPT: "continue" },
  reentrySafeNodes: ["prepare", "docs", "build", "review"],
  limits: { maxIterations: 2, maxProviderCalls: 12, maxElapsedMs: 3_600_000 },
};

function configureFeedbackProject(project: string): void {
  const nodeIds = ["prepare", "docs", "build", "review", "continue"];
  writeJson(project, ".nodulus/contracts/request.v1.schema.json", { type: "string", minLength: 1 });
  for (const [contract, properties] of Object.entries({
    "prepared.v1": { text: { type: "string" } },
    "readme.v1": { text: { type: "string" } },
    "build.v1": { text: { type: "string" } },
    "workflow-decision.v1": {
      decisionCode: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 },
      findings: { type: "array", items: { type: "object" } }, artifactRefs: { type: "array", items: { type: "object" } },
    },
    "continued.v1": { text: { type: "string" } },
  })) {
    writeJson(project, `.nodulus/contracts/${contract}.schema.json`, {
      type: "object", required: Object.keys(properties), properties, additionalProperties: false,
    });
  }
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 1, id: "example", nodes: nodeIds, feedbackRouting,
  });
  const definitions: Record<string, { inputName: string; from: string; inputContract: string; output: string; contract: string }> = {
    prepare: { inputName: "request", from: "request", inputContract: "request.v1", output: "prepared", contract: "prepared.v1" },
    docs: { inputName: "prepared", from: "prepare.prepared", inputContract: "prepared.v1", output: "readme", contract: "readme.v1" },
    build: { inputName: "readme", from: "docs.readme", inputContract: "readme.v1", output: "build", contract: "build.v1" },
    review: { inputName: "build", from: "build.build", inputContract: "build.v1", output: "decision", contract: "workflow-decision.v1" },
    continue: { inputName: "decision", from: "review.decision", inputContract: "workflow-decision.v1", output: "continued", contract: "continued.v1" },
  };
  for (const id of nodeIds) {
    const definition = definitions[id];
    writeJson(project, `.nodulus/nodes/${id}.json`, {
      schemaVersion: 1, id, providerProfile: "fixture", instructions: [`.nodulus/instructions/${id}.md`],
      inputs: { [definition.inputName]: { from: definition.from, contract: definition.inputContract } },
      expectedOutputs: [{ name: definition.output, contract: definition.contract }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
  }
  const review = readProjectJson(project, ".nodulus/nodes/review.json");
  review.inputs.docs = { from: "docs.readme", contract: "readme.v1" };
  writeJson(project, ".nodulus/nodes/review.json", review);
  const settings = readProjectJson(project, ".nodulus/settings.json");
  settings.providerProfiles.fixture = { enabled: true, executable: process.execPath, model: "fixture", timeoutMs: 5000 };
  writeJson(project, ".nodulus/settings.json", settings);
}

test("FB-001A accepts and reports a declared feedback route without inferring a provider", async () => {
  const project = createInitializedProject("fb-001a");
  configureFeedbackProject(project);
  try {
    const result = await inspectWorkflow!(project, "example") as { workflow: { feedbackRouting?: unknown } };
    expect(result.workflow.feedbackRouting).toEqual(feedbackRouting);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("FB-001B routes a non-adjacent documentation revision and accepts on pass two", async () => {
  const project = createInitializedProject("fb-001b");
  configureFeedbackProject(project);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "nodulus-feedback-"));
  const responsesPath = path.join(temporary, "responses.json");
  const tracePath = path.join(temporary, "trace.jsonl");
  const responses = [
    { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "prepared once" },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 1" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 1" },
    { nodeId: "review", kind: "decision", decisionCode: "FIX_DOCS", reason: "README usage omits the empty-input behavior.", findings: [{ id: "DOC-1", severity: "required", message: "Document empty input." }] },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 2" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 2" },
    { nodeId: "review", kind: "decision", decisionCode: "ACCEPT", reason: "All required findings are resolved.", findings: [] },
    { nodeId: "continue", name: "continued", contract: "continued.v1", text: "continued" },
  ];
  writeFileSync(responsesPath, JSON.stringify({ responses }), "utf8");
  const request = "Document the workflow behavior and build the example.";
  try {
    const result = await runWorkflow({ projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline", text: request }] }, {
      async invoke(invocation) {
        const child = spawnSync(process.execPath, [path.resolve("tests/fixtures/flow-015-feedback-routing-provider.mjs"), responsesPath, tracePath], { input: JSON.stringify(invocation), encoding: "utf8" });
        if (child.status !== 0) throw new Error(child.stderr || `Provider fixture exited ${child.status}`);
        return child.stdout;
      },
    });

    expect(result.status).toBe("success");
    const calls = readFileSync(tracePath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as { nodeId: string; inputs?: Record<string, unknown> });
    expect(calls.map(({ nodeId }) => nodeId)).toEqual(["prepare", "docs", "build", "review", "docs", "build", "review", "continue"]);
    expect(readFileSync(`${tracePath}.cursor`, "utf8")).toBe("8");
    const docsCalls = calls.filter(({ nodeId }) => nodeId === "docs");
    expect(docsCalls).toHaveLength(2);
    expect(calls.filter(({ nodeId }) => nodeId === "prepare")).toHaveLength(1);
    expect(calls.filter(({ nodeId }) => nodeId === "review").map(({ inputs }) => inputs)).toMatchObject([
      { docs: { text: "docs generation 1" }, build: { text: "build generation 1" }, artifactReferences: expect.any(Array) },
      { docs: { text: "docs generation 2" }, build: { text: "build generation 2" }, artifactReferences: expect.any(Array) },
    ]);
    const firstReviewRefs = calls[3].inputs?.artifactReferences as Array<Record<string, unknown>>;
    const secondReviewRefs = calls[6].inputs?.artifactReferences as Array<Record<string, unknown>>;
    const refFor = (refs: Array<Record<string, unknown>>, nodeId: string) => refs.find((reference) => reference.nodeId === nodeId);
    expect(calls[3].inputs).toMatchObject({ docs: { text: "docs generation 1" }, build: { text: "build generation 1" } });
    expect(refFor(secondReviewRefs, "docs")?.generationId).not.toBe(refFor(firstReviewRefs, "docs")?.generationId);
    expect(refFor(secondReviewRefs, "build")?.generationId).not.toBe(refFor(firstReviewRefs, "build")?.generationId);
    const docsGenerationOneRef = firstReviewRefs.find((reference) => reference.nodeId === "docs");
    const buildGenerationOneRef = firstReviewRefs.find((reference) => reference.nodeId === "build");
    expect(docsGenerationOneRef).toBeDefined();
    expect(buildGenerationOneRef).toBeDefined();
    expect(calls[4].inputs?.feedback).toEqual({
      originalRequest: request, decisionCode: "FIX_DOCS", reason: "README usage omits the empty-input behavior.",
      findings: [{ id: "DOC-1", severity: "required", message: "Document empty input." }],
      resolvedArtifacts: [
        { ...docsGenerationOneRef, data: { text: "docs generation 1" } },
        { ...buildGenerationOneRef, data: { text: "build generation 1" } },
      ],
    });
    expect(calls.filter(({ nodeId }) => nodeId === "review")).toHaveLength(2);
    const revisionCall = docsCalls[1];
    expect(revisionCall).toBeDefined();
    if (!revisionCall) throw new Error("Expected the second docs invocation to carry the revision feedback envelope.");
    const revisionFeedback = revisionCall.inputs?.feedback;
    expect(revisionFeedback).toBeDefined();
    if (!revisionFeedback || typeof revisionFeedback !== "object" || !("resolvedArtifacts" in revisionFeedback)) {
      throw new Error("The docs revision input is missing resolved artifact references.");
    }
    const resolvedArtifacts = revisionFeedback.resolvedArtifacts;
    expect(resolvedArtifacts).toEqual([
      { ...docsGenerationOneRef, data: { text: "docs generation 1" } },
      { ...buildGenerationOneRef, data: { text: "build generation 1" } },
    ]);
    expect(calls.filter(({ nodeId }) => nodeId === "review")[0].inputs).toMatchObject({
      build: { text: "build generation 1" }, docs: { text: "docs generation 1" },
      artifactReferences: expect.arrayContaining([expect.objectContaining({ nodeId: "docs", generationId: expect.any(String), sha256: expect.any(String) })]),
    });
    expect(calls.filter(({ nodeId }) => nodeId === "review")[1].inputs).toMatchObject({
      build: { text: "build generation 2" }, docs: { text: "docs generation 2" },
      artifactReferences: expect.arrayContaining([expect.objectContaining({ nodeId: "docs", generationId: expect.any(String), sha256: expect.any(String) })]),
    });
    const reviewRefs = calls.filter(({ nodeId }) => nodeId === "review").map(({ inputs }) => inputs?.artifactReferences as Array<{ nodeId: string; generationId: string }>);
    const firstDocsGeneration = reviewRefs[0].find((reference) => reference.nodeId === "docs")?.generationId;
    const secondDocsGeneration = reviewRefs[1].find((reference) => reference.nodeId === "docs")?.generationId;
    expect(firstDocsGeneration).toBeTruthy();
    expect(secondDocsGeneration).toBeTruthy();
    expect(secondDocsGeneration).not.toBe(firstDocsGeneration);
    for (const [refs, iteration] of [[reviewRefs[0], 1], [reviewRefs[1], 2]] as const) {
      for (const nodeId of ["docs", "build"]) {
        expect(refs.find((reference) => reference.nodeId === nodeId)).toMatchObject({
          runId: result.runId, nodeId, outputName: nodeId === "docs" ? "readme" : "build",
          contract: nodeId === "docs" ? "readme.v1" : "build.v1", iteration,
          generationId: expect.any(String), sha256: expect.any(String),
        });
      }
    }
    const storage = new LocalIntakeStorage();
    const runText = await storage.readRunFile(project, result.runId, "run.json");
    expect(existsSync(path.join(project, ".nodulus", "runs", result.runId, "run.json"))).toBe(true);
    const state = JSON.parse(runText) as {
      feedbackRouting?: { regions?: Record<string, { iteration?: number; generationHistory?: Array<Record<string, unknown>>; invalidatedSuffixes?: Array<Record<string, unknown>>; reusedPrefix?: string[]; eligibleNodes?: string[] }> };
    };
    const region = state.feedbackRouting?.regions?.["content-review"];
    expect(region?.iteration).toBe(2);
    expect(region?.reusedPrefix).toContain("prepare");
    expect(region?.eligibleNodes).not.toContain("docs");
    expect(region?.eligibleNodes).not.toContain("build");
    expect(region?.invalidatedSuffixes).toEqual([{ iteration: 2, target: "docs", nodeIds: ["docs", "build", "review"] }]);
    const history = region?.generationHistory ?? [];
    const expectedGenerations = [
      { nodeId: "docs", outputName: "readme", contract: "readme.v1", iteration: 1, attempt: 1, text: "docs generation 1", status: "invalidated" },
      { nodeId: "build", outputName: "build", contract: "build.v1", iteration: 1, attempt: 1, text: "build generation 1", status: "invalidated" },
      { nodeId: "docs", outputName: "readme", contract: "readme.v1", iteration: 2, attempt: 2, text: "docs generation 2", status: "accepted" },
      { nodeId: "build", outputName: "build", contract: "build.v1", iteration: 2, attempt: 2, text: "build generation 2", status: "accepted" },
    ];
    const attemptNumbers: Record<string, number[]> = { docs: [], build: [] };
    for (const expected of expectedGenerations) {
      const record = history.find((entry) => entry.nodeId === expected.nodeId && entry.iteration === expected.iteration);
      const attemptPath = `nodes/${expected.nodeId}/attempt-${String(expected.attempt).padStart(3, "0")}/result.json`;
      const identity = {
        runId: result.runId, nodeId: expected.nodeId, outputName: expected.outputName,
        contract: expected.contract, iteration: expected.iteration,
        generationId: expect.any(String), sha256: expect.any(String), attemptPath, status: expected.status,
      };
      expect(record).toEqual(identity);
      const envelope = JSON.parse(await storage.readRunFile(project, result.runId, attemptPath)) as {
        status: string; artifacts: Array<{ name: string; contract: string; data: { text: string } }>;
      };
      const artifact = envelope.artifacts.find(({ name }) => name === expected.outputName);
      expect(envelope.status).toBe("success");
      expect(artifact).toEqual({ name: expected.outputName, contract: expected.contract, data: { text: expected.text } });
      expect(record?.sha256).toBe(createHash("sha256").update(JSON.stringify(artifact?.data), "utf8").digest("hex"));
      const reviewerRefs = expected.iteration === 1 ? firstReviewRefs : secondReviewRefs;
      const reviewerRef = reviewerRefs.find((reference) => reference.nodeId === expected.nodeId);
      expect(reviewerRef).toEqual({
        runId: record?.runId, nodeId: record?.nodeId, outputName: record?.outputName,
        contract: record?.contract, iteration: record?.iteration,
        generationId: record?.generationId, sha256: record?.sha256,
      });
      attemptNumbers[expected.nodeId].push(expected.attempt);
    }
    expect(attemptNumbers.docs).toEqual([1, 2]);
    expect(attemptNumbers.build).toEqual([1, 2]);
    for (const nodeId of ["docs", "build"]) {
      const nodeHistory = history.filter((entry) => entry.nodeId === nodeId).sort((a, b) => Number(a.iteration) - Number(b.iteration));
      expect(nodeHistory.map((entry) => entry.iteration)).toEqual([1, 2]);
    }
    expect(history.filter((entry) => entry.status === "invalidated").map((entry) => entry.nodeId).sort((left, right) => left.localeCompare(right))).toEqual(["build", "docs"]);
    expect(history.some((entry) => entry.nodeId === "prepare" && entry.status === "invalidated")).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

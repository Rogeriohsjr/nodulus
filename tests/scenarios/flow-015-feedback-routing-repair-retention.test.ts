import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ProviderInvocation, type ProviderPort } from "../../src/application/run-workflow.js";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import { createInitializedProject } from "../support/intake-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

const route = {
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
const retainedFiles = ["invocation.json", "response.raw.txt", "validation.json", "result.json"] as const;
type TraceCall = { nodeId: string; call?: { operation?: string; attempt?: number }; inputs?: Record<string, unknown> };

function configureProject(project: string): void {
  const nodeIds = ["prepare", "docs", "build", "review", "continue"];
  writeJson(project, ".nodulus/contracts/request.v1.schema.json", { type: "string", minLength: 1 });
  const contracts: Record<string, unknown> = {
    "prepared.v1": { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
    "readme.v1": { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
    "build.v1": { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
    "workflow-decision.v1": { type: "object", required: ["decisionCode", "reason", "findings", "artifactRefs"], properties: { decisionCode: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 }, findings: { type: "array", items: { type: "object" } }, artifactRefs: { type: "array", items: { type: "object" } } }, additionalProperties: false },
    "continued.v1": { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false },
  };
  for (const [contract, schema] of Object.entries(contracts)) writeJson(project, `.nodulus/contracts/${contract}.schema.json`, schema);
  writeJson(project, ".nodulus/workflows/example.json", { schemaVersion: 1, id: "example", nodes: nodeIds, feedbackRouting: route });
  const definitions: Record<string, { input: string; from: string; inputContract: string; output: string; contract: string }> = {
    prepare: { input: "request", from: "request", inputContract: "request.v1", output: "prepared", contract: "prepared.v1" },
    docs: { input: "prepared", from: "prepare.prepared", inputContract: "prepared.v1", output: "readme", contract: "readme.v1" },
    build: { input: "readme", from: "docs.readme", inputContract: "readme.v1", output: "build", contract: "build.v1" },
    review: { input: "build", from: "build.build", inputContract: "build.v1", output: "decision", contract: "workflow-decision.v1" },
    continue: { input: "decision", from: "review.decision", inputContract: "workflow-decision.v1", output: "continued", contract: "continued.v1" },
  };
  for (const id of nodeIds) {
    const item = definitions[id];
    writeJson(project, `.nodulus/nodes/${id}.json`, {
      schemaVersion: 1, id, providerProfile: "fixture", instructions: [`.nodulus/instructions/${id}.md`],
      inputs: { [item.input]: { from: item.from, contract: item.inputContract } },
      expectedOutputs: [{ name: item.output, contract: item.contract }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
  }
  const review = readProjectJson(project, ".nodulus/nodes/review.json");
  review.inputs.docs = { from: "docs.readme", contract: "readme.v1" };
  writeJson(project, ".nodulus/nodes/review.json", review);
  const settings = readProjectJson(project, ".nodulus/settings.json");
  settings.providerProfiles.fixture = { enabled: true, executable: process.execPath, model: "fixture", timeoutMs: 5000, capabilities: ["responseRepair"] };
  writeJson(project, ".nodulus/settings.json", settings);
}

function fixtureProvider(temporary: string, project: string): ProviderPort {
  const responsesPath = path.join(temporary, "responses.json");
  const tracePath = path.join(temporary, "trace.jsonl");
  const fixturePath = path.resolve("tests/fixtures/flow-015-feedback-routing-repair-retention-provider.mjs");
  const evidencePath = path.join(temporary, "evidence.json");
  const invoke = async (invocation: ProviderInvocation): Promise<string> => {
    if (invocation.nodeId === "docs" && invocation.call?.operation === "invoke" && invocation.attempt > 1 && !existsSync(evidencePath)) {
      const files = retainedFiles.map((file) => {
        const absolute = path.join(project, ".nodulus", "runs", invocation.runId, "nodes", "review", "attempt-002", file);
        if (!existsSync(absolute)) throw new Error(`Review attempt-002 evidence file is absent before replayed docs response: ${file}`);
        const bytes = readFileSync(absolute);
        return { path: file, bytes: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
      });
      writeFileSync(evidencePath, JSON.stringify({ before: files }), "utf8");
    }
    return runFixture(fixturePath, responsesPath, tracePath, invocation);
  };
  const runFixture = (fixture: string, responses: string, trace: string, invocation: ProviderInvocation): Promise<string> => {
    const child = spawnSync(process.execPath, [fixture, responses, trace], { cwd: temporary, input: JSON.stringify(invocation), encoding: "utf8", timeout: 5000, windowsHide: true });
    if (child.error || child.status !== 0) throw new Error(child.error?.message ?? child.stderr ?? `Provider fixture exited ${child.status}`);
    return Promise.resolve(child.stdout);
  };
  return {
    invoke,
    async repairResponse(invocation, previousRawResponse, validationErrors) {
      return runFixture(fixturePath, responsesPath, tracePath, { ...invocation, inputs: { ...invocation.inputs, __repair: { previousRawResponse, validationErrors } } });
    },
  };
}

test("FB-020 repaired decision evidence survives configured reroute", async () => {
  const project = createInitializedProject("fb-020-repair-retention");
  const temporary = mkdtempSync(path.join(tmpdir(), "nodulus-fb-020-repair-retention-"));
  configureProject(project);
  const entries = [
    { nodeId: "prepare", operation: "invoke", attempt: 1, name: "prepared", contract: "prepared.v1", text: "prepare once" },
    { nodeId: "docs", operation: "invoke", attempt: 1, name: "readme", contract: "readme.v1", text: "docs first" },
    { nodeId: "build", operation: "invoke", attempt: 1, name: "build", contract: "build.v1", text: "build first" },
    { nodeId: "review", operation: "invoke", attempt: 1, rawOutcome: "{invalid response" },
    { nodeId: "review", operation: "repair_response", attempt: 2, kind: "decision", decisionCode: "FIX_DOCS", reason: "Revise the docs.", findings: [{ id: "DOC-1", severity: "required", message: "Clarify behavior." }] },
    { nodeId: "docs", operation: "invoke", attempt: 2, name: "readme", contract: "readme.v1", text: "docs revised" },
    { nodeId: "build", operation: "invoke", attempt: 2, name: "build", contract: "build.v1", text: "build revised" },
    { nodeId: "review", operation: "invoke", attempt: 3, kind: "decision", decisionCode: "ACCEPT", reason: "All findings are resolved.", findings: [] },
    { nodeId: "continue", operation: "invoke", attempt: 1, name: "continued", contract: "continued.v1", text: "continued after accept" },
  ];
  writeFileSync(path.join(temporary, "responses.json"), JSON.stringify({ entries }), "utf8");
  const provider = fixtureProvider(temporary, project);
  try {
    const result = await runWorkflow({ projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline", text: "Review this routed workflow." }] }, provider);
    const storage = new LocalIntakeStorage();
    const trace = readFileSync(path.join(temporary, "trace.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as TraceCall);
    const evidence = JSON.parse(readFileSync(path.join(temporary, "evidence.json"), "utf8")) as { before: Array<{ path: typeof retainedFiles[number]; bytes: string; sha256: string }> };
    const after = retainedFiles.map((file) => {
      const absolute = path.join(project, ".nodulus", "runs", result.runId, "nodes", "review", "attempt-002", file);
      const bytes = readFileSync(absolute);
      return { path: file, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    const equalFiles = evidence.before.length === retainedFiles.length && after.every((item) => evidence.before.some((before) => before.path === item.path && Buffer.from(before.bytes, "base64").equals(item.bytes)));
    const reviewCalls = trace.filter(({ nodeId }) => nodeId === "review");
    const reviewAttemptAfterRepair = Number(reviewCalls.find(({ call }) => call?.operation === "invoke" && Number(call.attempt) > 1)?.call?.attempt ?? 0);
    const prepareCount = trace.filter(({ nodeId, call }) => nodeId === "prepare" && call?.operation === "invoke").length;
    const docsReplayCount = trace.filter(({ nodeId, call }) => nodeId === "docs" && call?.operation === "invoke").length;
    const buildReplayCount = trace.filter(({ nodeId, call }) => nodeId === "build" && call?.operation === "invoke").length;
    const decisions = reviewCalls.map(({ inputs }) => inputs?.artifactReferences);
    const acceptIndex = trace.findIndex(({ nodeId, call, inputs }) => nodeId === "review" && call?.operation === "invoke" && (inputs?.decisionCode === "ACCEPT" || Number(call.attempt) > 2));
    const continueIndex = trace.findIndex(({ nodeId }) => nodeId === "continue");
    const runState = JSON.parse(await storage.readRunFile(project, result.runId, "run.json")) as { completedNodes?: string[] };
    const routeResult = {
      prepareCount, docsReplayCount, buildReplayCount,
      firstDecision: "FIX_DOCS", firstDecisionReferencesValid: Array.isArray(decisions[0]) && decisions[0].length >= 3,
      acceptDecision: "ACCEPT", acceptReferencesValid: Array.isArray(decisions[1]) && decisions[1].length >= 3,
      continuationAfterAccept: continueIndex > acceptIndex && runState.completedNodes?.includes("continue") === true,
      unexpectedCalls: 0, reviewAttemptAfterRepair, higherAttemptInvariant: reviewAttemptAfterRepair > 2,
    };
    expect(result.status, "configured route completes through runWorkflow").toBe("success");
    expect(trace.map(({ nodeId, call }) => [nodeId, call?.operation])).toEqual([
      ["prepare", "invoke"], ["docs", "invoke"], ["build", "invoke"], ["review", "invoke"], ["review", "repair_response"],
      ["docs", "invoke"], ["build", "invoke"], ["review", "invoke"], ["continue", "invoke"],
    ]);
    expect(trace.filter(({ nodeId }) => nodeId === "prepare")).toHaveLength(1);
    expect(routeResult.firstDecisionReferencesValid && routeResult.acceptReferencesValid && routeResult.continuationAfterAccept).toBe(true);
    // Named behavioral assertion: one failure can represent attempt collision or replacement of retained evidence.
    expect(reviewAttemptAfterRepair > 2 && equalFiles, "repair-attempt-002-retention-and-monotonic-attempt").toBe(true);
    const report = {
      trace: trace.map(({ nodeId, call }) => ({ nodeId, operation: call?.operation, attempt: call?.attempt })),
      route: routeResult,
      fileEvidence: {
        comparison: equalFiles ? "equal" : "mismatch",
        before: evidence.before.map(({ path: file, sha256 }) => ({ path: file, status: "present", sha256 })),
        after: after.map(({ path: file, sha256 }) => ({ path: file, status: "present", sha256 })),
        unavailable: [],
      },
    };
    console.info(`FB020_REPAIR_RETENTION_EVIDENCE ${JSON.stringify(report)}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

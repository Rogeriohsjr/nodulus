import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import type { ProviderInvocation, ProviderPort } from "../../src/application/run-workflow.js";
import { createInitializedProject } from "./intake-project.js";
import { readProjectJson, writeJson } from "./workflow-sequence.js";

export type FeedbackFixtureResponse = {
  nodeId: string;
  name?: string;
  contract?: string;
  text?: string;
  data?: Record<string, unknown>;
  kind?: "decision";
  decisionCode?: unknown;
  reason?: string;
  findings?: unknown[];
  artifactRefsMode?: "missing" | "duplicate" | "stale" | "forged-digest" | "unmapped";
};

export type FeedbackProject = {
  project: string;
  temporary: string;
  responsesPath: string;
  tracePath: string;
  provider: ProviderPort;
  writeResponses(responses: FeedbackFixtureResponse[]): void;
  readTrace(): Array<ProviderInvocation>;
  cleanup(): void;
};

export const feedbackRouting = {
  schemaVersion: 1,
  regionId: "content-review",
  startNode: "prepare",
  decisionNode: "review",
  decisionOutput: { name: "decision", contract: "workflow-decision.v1" },
  continuationNode: "continue",
  routes: { FIX_DOCS: "docs", FIX_BUILD: "build", ACCEPT: "continue" },
  reentrySafeNodes: ["prepare", "docs", "build", "review"],
  limits: { maxIterations: 3, maxProviderCalls: 20, maxElapsedMs: 3_600_000 },
} as const;

const nodeIds = ["prepare", "docs", "build", "review", "continue"];
const definitions: Record<string, { inputName: string; from: string; inputContract: string; output: string; contract: string }> = {
  prepare: { inputName: "request", from: "request", inputContract: "request.v1", output: "prepared", contract: "prepared.v1" },
  docs: { inputName: "prepared", from: "prepare.prepared", inputContract: "prepared.v1", output: "readme", contract: "readme.v1" },
  build: { inputName: "readme", from: "docs.readme", inputContract: "readme.v1", output: "build", contract: "build.v1" },
  review: { inputName: "build", from: "build.build", inputContract: "build.v1", output: "decision", contract: "workflow-decision.v1" },
  continue: { inputName: "decision", from: "review.decision", inputContract: "workflow-decision.v1", output: "continued", contract: "continued.v1" },
};
const contractProperties: Record<string, Record<string, unknown>> = {
  "prepared.v1": { text: { type: "string" } },
  "readme.v1": { text: { type: "string" } },
  "build.v1": { text: { type: "string" } },
  "workflow-decision.v1": {
    decisionCode: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    findings: { type: "array", items: { type: "object" } },
    artifactRefs: { type: "array", items: { type: "object" } },
  },
  "continued.v1": { text: { type: "string" } },
};

export function createFeedbackProject(label: string): FeedbackProject {
  const project = createInitializedProject("fb-030-" + label);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "nodulus-fb-030-" + label + "-"));
  const responsesPath = path.join(temporary, "responses.json");
  const tracePath = path.join(temporary, "trace.jsonl");
  configureFeedbackProject(project);
  writeResponsesFile(responsesPath, []);
  const fixturePath = fileURLToPath(new URL("../fixtures/fb-030-feedback-routing-provider.mjs", import.meta.url));
  return {
    project,
    temporary,
    responsesPath,
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
        if (child.error || child.status !== 0) throw new Error(child.error?.message ?? child.stderr ?? "Provider fixture exited " + child.status);
        return child.stdout;
      },
    },
    writeResponses(responses) { writeResponsesFile(responsesPath, responses); },
    readTrace() {
      return readFileSync(tracePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProviderInvocation);
    },
    cleanup() {
      rmSync(project, { recursive: true, force: true });
      rmSync(temporary, { recursive: true, force: true });
    },
  };
}

export function configureFeedbackProject(project: string): void {
  writeJson(project, ".nodulus/contracts/request.v1.schema.json", { type: "string", minLength: 1 });
  for (const [contract, properties] of Object.entries(contractProperties)) {
    writeJson(project, ".nodulus/contracts/" + contract + ".schema.json", {
      type: "object", required: Object.keys(properties), properties, additionalProperties: false,
    });
  }
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 1, id: "example", nodes: nodeIds, feedbackRouting,
  });
  for (const id of nodeIds) {
    const definition = definitions[id];
    writeJson(project, ".nodulus/nodes/" + id + ".json", {
      schemaVersion: 1, id, providerProfile: "fixture", instructions: [".nodulus/instructions/" + id + ".md"],
      inputs: { [definition.inputName]: { from: definition.from, contract: definition.inputContract } },
      expectedOutputs: [{ name: definition.output, contract: definition.contract }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", id + ".md"), "Instructions for " + id + ".\n", "utf8");
  }
  const review = readProjectJson(project, ".nodulus/nodes/review.json");
  review.inputs.docs = { from: "docs.readme", contract: "readme.v1" };
  writeJson(project, ".nodulus/nodes/review.json", review);
  const settings = readProjectJson(project, ".nodulus/settings.json");
  settings.providerProfiles.fixture = { enabled: true, executable: process.execPath, model: "fixture", timeoutMs: 5000 };
  writeJson(project, ".nodulus/settings.json", settings);
}

export function acceptedResponses(): FeedbackFixtureResponse[] {
  return [
    { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "prepared once" },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "docs generation 1" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 1" },
    { nodeId: "review", kind: "decision", decisionCode: "ACCEPT", reason: "Accepted.", findings: [] },
    { nodeId: "continue", name: "continued", contract: "continued.v1", text: "continued" },
  ];
}

export function fixBuildResponses(): FeedbackFixtureResponse[] {
  return [
    ...acceptedResponses().slice(0, 3),
    { nodeId: "review", kind: "decision", decisionCode: "FIX_BUILD", reason: "Revise the build.", findings: [{ id: "BUILD-1" }] },
    { nodeId: "build", name: "build", contract: "build.v1", text: "build generation 2" },
    { nodeId: "review", kind: "decision", decisionCode: "ACCEPT", reason: "Accepted.", findings: [] },
    { nodeId: "continue", name: "continued", contract: "continued.v1", text: "continued" },
  ];
}

function writeResponsesFile(pathname: string, responses: FeedbackFixtureResponse[]): void {
  writeFileSync(pathname, JSON.stringify({ responses }), "utf8");
}

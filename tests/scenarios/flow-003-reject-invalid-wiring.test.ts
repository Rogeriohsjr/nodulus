import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureSequenceProject, readProjectJson, sequenceRunRequest, setNodeInput, writeJson } from "../support/workflow-sequence.js";

const invalidWiring = [
  ["duplicate node IDs", (project: string) => writeJson(project, ".nodulus/workflows/example.json", { schemaVersion: 1, id: "example", nodes: ["analyze", "build", "analyze"] })],
  ["forward reference", (project: string) => setNodeInput(project, "analyze", "findings", { from: "build.implementation", contract: "implementation.v1" })],
  ["cycle", (project: string) => {
    setNodeInput(project, "analyze", "findings", { from: "build.implementation", contract: "implementation.v1" });
    setNodeInput(project, "build", "implementation", { from: "analyze.findings", contract: "finding.v1" });
  }],
  ["missing output", (project: string) => setNodeInput(project, "build", "findings", { from: "analyze.missing", contract: "finding.v1" })],
  ["mismatched declared contract", (project: string) => setNodeInput(project, "build", "findings", { from: "analyze.findings", contract: "implementation.v1" })],
] as const;

test.each(invalidWiring)("FLOW-003 rejects %s before run creation or provider calls", async (_label, alter) => {
  const project = createInitializedProject("flow-003");
  configureSequenceProject(project);
  alter(project);
  let calls = 0;
  try {
    const outcome = await runWorkflow(sequenceRunRequest(project), {
      async invoke() {
        calls += 1;
        throw new Error("Invalid workflow reached provider invocation.");
      },
    }).then((result) => result, (error: unknown) => error);

    expect(outcome).toMatchObject({ code: expect.any(String), message: expect.stringMatching(/\S/) });
    expect(calls).toBe(0);
    const runRoot = path.join(project, ".nodulus", "runs");
    expect(existsSync(runRoot) ? readdirSync(runRoot) : []).toEqual([]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("FLOW-003 rejects a dotted source that matches more than one prior node/output pair", async () => {
  const project = createInitializedProject("flow-003-ambiguous-source");
  configureSequenceProject(project, ["alpha", "alpha.beta", "review"]);
  const alpha = readProjectJson(project, ".nodulus/nodes/alpha.json");
  const alphaBeta = readProjectJson(project, ".nodulus/nodes/alpha.beta.json");
  alpha.expectedOutputs[0].name = "beta.gamma";
  alphaBeta.expectedOutputs[0].name = "gamma";
  writeJson(project, ".nodulus/nodes/alpha.json", alpha);
  writeJson(project, ".nodulus/nodes/alpha.beta.json", alphaBeta);
  setNodeInput(project, "alpha.beta", "findings", { from: "alpha.beta.gamma", contract: "finding.v1" });
  setNodeInput(project, "review", "findings", { from: "alpha.beta.gamma", contract: "finding.v1" });
  let calls = 0;
  try {
    const outcome = await runWorkflow(sequenceRunRequest(project), {
      async invoke() {
        calls += 1;
        throw new Error("Ambiguous wiring reached provider invocation.");
      },
    }).then((result) => result, (error: unknown) => error);

    expect(outcome).toMatchObject({ code: "CONFIGURATION_INVALID", message: expect.stringMatching(/ambiguous/i) });
    expect(calls).toBe(0);
    const runRoot = path.join(project, ".nodulus", "runs");
    expect(existsSync(runRoot) ? readdirSync(runRoot) : []).toEqual([]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

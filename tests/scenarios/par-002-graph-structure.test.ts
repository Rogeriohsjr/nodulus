import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { inspectWorkflow } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow, type ParallelWorkflowFixture } from "../support/parallel-project.js";
import { writeJson } from "../support/workflow-sequence.js";

function snapshotTree(root: string): Array<{ relativePath: string; sha256: string }> {
  const entries: Array<{ relativePath: string; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push({ relativePath: `${path.relative(root, entryPath)}${path.sep}`, sha256: "directory" });
        visit(entryPath);
      } else {
        entries.push({
          relativePath: path.relative(root, entryPath),
          sha256: createHash("sha256").update(readFileSync(entryPath)).digest("hex"),
        });
      }
    }
  };
  visit(root);
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function mutateAndInspect(name: string, mutate: (workflow: ParallelWorkflowFixture) => void, message: RegExp): void {
  test(`PAR-002 rejects ${name}`, async () => {
    const project = createInitializedProject(`par-002 ${name} café`);
    const sentinels = configureParallelProject(project);
    const workflow = readParallelWorkflow(project);
    mutate(workflow);
    writeJson(project, ".nodulus/workflows/example.json", workflow);
    const runsDirectory = path.join(project, ".nodulus", "runs");
    const savedRunsBefore = snapshotTree(runsDirectory);
    let inspectionError: unknown;
    try {
      try {
        await inspectWorkflow(project, "example");
      } catch (error) {
        inspectionError = error;
      }

      expect(inspectionError).toMatchObject({ code: "CONFIGURATION_INVALID" });
      expect(inspectionError instanceof Error ? inspectionError.message : "").toMatch(message);
      expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
      expect(existsSync(sentinels.providerSentinel)).toBe(false);
      expect(existsSync(sentinels.validatorSentinel)).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

test("PAR-002 inspects a valid graph before its independent negative mutations", async () => {
  const project = createInitializedProject("par-002 valid graph café");
  const sentinels = configureParallelProject(project);
  const runsDirectory = path.join(project, ".nodulus", "runs");
  const savedRunsBefore = snapshotTree(runsDirectory);
  try {
    const result = await inspectWorkflow(project, "example");
    expect(result).toMatchObject({
      workflow: {
        executionSupported: true,
        nodes: ["join", "audit", "left", "right", "prepare"],
        execution: {
          kind: "dag",
          maxConcurrency: 2,
          dependsOn: { prepare: [], audit: [], left: ["prepare"], right: ["prepare"], join: ["left", "right"] },
          resources: { prepare: [], audit: [], left: [], right: [], join: [] },
        },
        outputs: [
          { name: "joined", from: "join.report", contract: "report.v1" },
          { name: "audit", from: "audit.report", contract: "report.v1" },
        ],
      },
    });
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

mutateAndInspect("duplicate node ID", (workflow) => { workflow.nodes[1] = workflow.nodes[0]; }, /invalid schema-2 ID or node list/);
mutateAndInspect("unknown predecessor", (workflow) => { workflow.execution.dependsOn.join.push("ghost"); }, /invalid dependencies for node 'join'/);
mutateAndInspect("self dependency", (workflow) => { workflow.execution.dependsOn.audit.push("audit"); }, /invalid dependencies for node 'audit'/);
mutateAndInspect("duplicate edge", (workflow) => { workflow.execution.dependsOn.join.splice(1, 0, "left"); }, /invalid dependencies for node 'join'/);
mutateAndInspect("missing dependency entry", (workflow) => { delete workflow.execution.dependsOn.audit; }, /must declare dependencies for every node/);
mutateAndInspect("extra dependency entry", (workflow) => { workflow.execution.dependsOn.ghost = []; }, /must declare dependencies for every node/);
mutateAndInspect("dependency cycle", (workflow) => { workflow.execution.dependsOn.prepare = ["join"]; }, /contains a dependency cycle/);
mutateAndInspect("duplicate result alias", (workflow) => { workflow.outputs[1].name = workflow.outputs[0].name; }, /duplicate output alias/);
mutateAndInspect("missing result source", (workflow) => { workflow.outputs[0].from = "ghost.report"; }, /missing source/);
mutateAndInspect("mismatched result contract", (workflow) => { workflow.outputs[0].contract = "other.v1"; }, /contract must match source/);

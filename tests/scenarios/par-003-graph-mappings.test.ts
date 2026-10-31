import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { inspectWorkflow, runWorkflow } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { configureSequenceProject, readProjectJson, setNodeInputs as setSequenceNodeInputs, writeJson } from "../support/workflow-sequence.js";

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

function setNodeInputs(project: string, nodeId: string, inputs: Record<string, unknown>): void {
  const node = readProjectJson(project, `.nodulus/nodes/${nodeId}.json`);
  node.inputs = inputs;
  writeJson(project, `.nodulus/nodes/${nodeId}.json`, node);
}

function addCallerInput(project: string, name: string, contract: string): void {
  const workflow = readParallelWorkflow(project);
  writeJson(project, ".nodulus/workflows/example.json", { ...workflow, inputs: { [name]: { contract } } });
}

async function expectInspectionError(project: string, expectedMessage: RegExp): Promise<void> {
  let inspectionError: unknown;
  try {
    await inspectWorkflow(project, "example");
  } catch (error) {
    inspectionError = error;
  }
  expect(inspectionError).toMatchObject({ code: "CONFIGURATION_INVALID" });
  expect(inspectionError instanceof Error ? inspectionError.message : "").toMatch(expectedMessage);
}

test.each([
  ["transitive ancestor", (project: string) => {
    setNodeInputs(project, "join", {
      inherited: { from: "prepare.report", contract: "report.v1" },
      left: { from: "left.report", contract: "report.v1" },
      right: { from: "right.report", contract: "report.v1" },
    });
  }],
  ["control-only dependency", (project: string) => {
    const workflow = readParallelWorkflow(project);
    workflow.execution.dependsOn.audit = ["prepare"];
    writeJson(project, ".nodulus/workflows/example.json", workflow);
  }],
  ["declared caller input", (project: string) => {
    addCallerInput(project, "goal", "report.v1");
    setNodeInputs(project, "audit", { goal: { from: "caller.goal", contract: "report.v1" } });
  }],
])("PAR-003 accepts a %s mapping", async (_name, mutate) => {
  const project = createInitializedProject(`par-003 valid ${_name} café`);
  const sentinels = configureParallelProject(project);
  const runsDirectory = path.join(project, ".nodulus", "runs");
  const savedRunsBefore = snapshotTree(runsDirectory);
  try {
    mutate(project);
    const result = await inspectWorkflow(project, "example");
    expect(result).toMatchObject({ workflow: { executionSupported: true } });
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test.each([
  ["non-ancestor sibling source", (project: string) => {
    setNodeInputs(project, "left", { sibling: { from: "audit.report", contract: "report.v1" } });
  }, /has an invalid source 'audit.report'/],
  ["missing output", (project: string) => {
    setNodeInputs(project, "left", { missing: { from: "prepare.unknown", contract: "report.v1" } });
  }, /has an invalid source 'prepare.unknown'/],
  ["mismatched contract", (project: string) => {
    setNodeInputs(project, "left", { mismatch: { from: "prepare.report", contract: "other.v1" } });
  }, /contract must match source 'prepare.report'/],
  ["ambiguous dotted ancestor source", (project: string) => {
    const workflow = readParallelWorkflow(project);
    workflow.nodes.push("prepare.left");
    workflow.execution.dependsOn["prepare.left"] = ["prepare"];
    workflow.execution.dependsOn.join.push("prepare.left");
    writeJson(project, ".nodulus/workflows/example.json", workflow);

    const prepare = readProjectJson(project, ".nodulus/nodes/prepare.json");
    prepare.expectedOutputs.push({ name: "left.report", contract: "report.v1" });
    writeJson(project, ".nodulus/nodes/prepare.json", prepare);
    writeJson(project, ".nodulus/nodes/prepare.left.json", {
      schemaVersion: 1,
      id: "prepare.left",
      providerProfile: "fixture",
      instructions: [".nodulus/instructions/prepare.left.md"],
      inputs: { source: { from: "prepare.report", contract: "report.v1" } },
      expectedOutputs: [{ name: "report", contract: "report.v1" }],
    });
    writeFileSync(path.join(project, ".nodulus", "instructions", "prepare.left.md"), "Instructions for prepare.left.\n", "utf8");
    setNodeInputs(project, "join", {
      left: { from: "left.report", contract: "report.v1" },
      right: { from: "right.report", contract: "report.v1" },
      ambiguous: { from: "prepare.left.report", contract: "report.v1" },
    });
  }, /source 'prepare.left.report' is ambiguous/],
  ["undeclared caller input", (project: string) => {
    setNodeInputs(project, "audit", { absent: { from: "caller.absent", contract: "report.v1" } });
  }, /references undeclared caller input 'absent'/],
  ["undeclared caller.constructor without a contract", (project: string) => {
    setNodeInputs(project, "audit", { inherited: { from: "caller.constructor" } });
  }, /references undeclared caller input 'constructor'/],
])("PAR-003 rejects %s", async (_name, mutate, expectedMessage) => {
  const project = createInitializedProject(`par-003 invalid ${_name} café`);
  const sentinels = configureParallelProject(project);
  const runsDirectory = path.join(project, ".nodulus", "runs");
  const savedRunsBefore = snapshotTree(runsDirectory);
  try {
    mutate(project);
    await expectInspectionError(project, expectedMessage);
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("PAR-003 rejects undeclared caller.constructor before run creation or provider checks", async () => {
  const project = createInitializedProject("par-003 caller constructor café");
  configureSequenceProject(project);
  setSequenceNodeInputs(project, "analyze", { inherited: { from: "caller.constructor" } });
  const runsDirectory = path.join(project, ".nodulus", "runs");
  mkdirSync(path.join(runsDirectory, "preexisting-run"), { recursive: true });
  writeFileSync(path.join(runsDirectory, "preexisting-run", "marker.json"), "{\"before\":true}\n", "utf8");
  const savedRunsBefore = snapshotTree(runsDirectory);
  let availabilityChecks = 0;
  let providerCalls = 0;
  try {
    await expect(runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Validate caller mappings." }],
    }, {
      isAvailable() {
        availabilityChecks += 1;
        throw new Error("Invalid caller mappings must reject before provider readiness.");
      },
      async invoke() {
        providerCalls += 1;
        throw new Error("Invalid caller mappings must reject before inference.");
      },
    })).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(availabilityChecks).toBe(0);
    expect(providerCalls).toBe(0);
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

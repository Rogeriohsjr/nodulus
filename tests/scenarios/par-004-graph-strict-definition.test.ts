import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { inspectWorkflow } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type JsonObject = Record<string, unknown>;
type ProjectMutation = (project: string) => void;

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

function readWorkflowObject(project: string): JsonObject {
  return readProjectJson(project, ".nodulus/workflows/example.json") as JsonObject;
}

function writeWorkflowObject(project: string, workflow: JsonObject): void {
  writeJson(project, ".nodulus/workflows/example.json", workflow);
}

function record(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Fixture object is malformed.");
  return value as JsonObject;
}

function editExecution(project: string, mutate: (execution: JsonObject) => void): void {
  const workflow = readWorkflowObject(project);
  mutate(record(workflow.execution));
  writeWorkflowObject(project, workflow);
}

function editInputs(project: string, nodeId: string, mutate: (inputs: JsonObject) => void): void {
  const relative = `.nodulus/nodes/${nodeId}.json`;
  const node = readProjectJson(project, relative) as JsonObject;
  mutate(record(node.inputs));
  writeJson(project, relative, node);
}

async function inspectWithoutSideEffects(
  project: string,
  sentinels: { providerSentinel: string; validatorSentinel: string },
): Promise<Record<string, unknown>> {
  const runsDirectory = path.join(project, ".nodulus", "runs");
  const before = snapshotTree(runsDirectory);
  const result = await inspectWorkflow(project, "example");
  expect(snapshotTree(runsDirectory)).toEqual(before);
  expect(existsSync(sentinels.providerSentinel)).toBe(false);
  expect(existsSync(sentinels.validatorSentinel)).toBe(false);
  return result;
}

function validProjectCase(name: string, mutate: ProjectMutation, verify: (result: Record<string, unknown>, project: string) => void): void {
  test(`PAR-004 accepts ${name}`, async () => {
    const project = createInitializedProject(`par-004 valid ${name} café`);
    const sentinels = configureParallelProject(project);
    try {
      mutate(project);
      const workflowPath = path.join(project, ".nodulus", "workflows", "example.json");
      const workflowBefore = readFileSync(workflowPath, "utf8");
      const result = await inspectWithoutSideEffects(project, sentinels);
      expect(readFileSync(workflowPath, "utf8")).toBe(workflowBefore);
      verify(result, project);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

function rejectedProjectCase(name: string, mutate: ProjectMutation, expectedMessage: RegExp): void {
  test(`PAR-004 rejects ${name}`, async () => {
    const project = createInitializedProject(`par-004 invalid ${name} café`);
    const sentinels = configureParallelProject(project);
    const runsDirectory = path.join(project, ".nodulus", "runs");
    const savedRunsBefore = snapshotTree(runsDirectory);
    try {
      mutate(project);
      let inspectionError: unknown;
      try {
        await inspectWorkflow(project, "example");
      } catch (error) {
        inspectionError = error;
      }
      expect(inspectionError).toMatchObject({ code: "CONFIGURATION_INVALID" });
      expect(inspectionError instanceof Error ? inspectionError.message : "").toMatch(expectedMessage);
      expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
      expect(existsSync(sentinels.providerSentinel)).toBe(false);
      expect(existsSync(sentinels.validatorSentinel)).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

validProjectCase("omitted resources without rewriting the declaration", (project) => {
  editExecution(project, (execution) => { delete execution.resources; });
}, (result, project) => {
  const actual = readParallelWorkflow(project);
  expect(actual.execution.resources).toBeUndefined();
  expect(record(result.workflow).execution).toMatchObject({ kind: "dag", maxConcurrency: 2 });
  expect(record(record(result.workflow).execution).resources).toBeUndefined();
});

validProjectCase("explicit empty resource arrays", () => {}, (result) => {
  expect(record(record(result.workflow).execution).resources).toEqual({ prepare: [], audit: [], left: [], right: [], join: [] });
});

validProjectCase("valid typed caller input", (project) => {
  const workflow = readWorkflowObject(project);
  workflow.inputs = { goal: { contract: "report.v1" } };
  writeWorkflowObject(project, workflow);
  editInputs(project, "audit", (inputs) => { inputs.goal = { from: "caller.goal", contract: "report.v1" }; });
}, (result) => {
  expect(record(result.workflow).inputs).toEqual({ goal: { contract: "report.v1" } });
});

rejectedProjectCase("unknown workflow property", (project) => {
  const workflow = readWorkflowObject(project);
  workflow.unexpected = true;
  writeWorkflowObject(project, workflow);
}, /unknown schema-2 property/);

rejectedProjectCase("unknown execution property", (project) => {
  editExecution(project, (execution) => { execution.unexpected = true; });
}, /invalid graph execution definition/);

rejectedProjectCase("unknown output alias property", (project) => {
  const workflow = readWorkflowObject(project);
  const outputs = workflow.outputs as JsonObject[];
  outputs[0].unexpected = true;
  writeWorkflowObject(project, workflow);
}, /invalid output alias/);

rejectedProjectCase("unknown caller declaration property", (project) => {
  const workflow = readWorkflowObject(project);
  workflow.inputs = { goal: { contract: "report.v1", description: "extra field" } };
  writeWorkflowObject(project, workflow);
}, /unknown property/);

rejectedProjectCase("unknown graph input mapping property", (project) => {
  editInputs(project, "left", (inputs) => { inputs.report = { from: "prepare.report", contract: "report.v1", hint: "extra field" }; });
}, /unknown property/);

for (const [name, value] of [
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ["nonnumeric string", "2"],
] as const) {
  rejectedProjectCase(`${name} concurrency`, (project) => {
    editExecution(project, (execution) => { execution.maxConcurrency = value; });
  }, /invalid graph execution definition/);
}

rejectedProjectCase("graph combined with feedback routing", (project) => {
  const workflow = readWorkflowObject(project);
  workflow.feedbackRouting = {};
  writeWorkflowObject(project, workflow);
}, /unknown schema-2 property/);

rejectedProjectCase("unknown resource node", (project) => {
  editExecution(project, (execution) => { record(execution.resources).ghost = []; });
}, /invalid resource map/);

rejectedProjectCase("non-array resource declaration", (project) => {
  editExecution(project, (execution) => { record(execution.resources).prepare = "workspace"; });
}, /invalid resources for node 'prepare'/);

rejectedProjectCase("duplicate resource keys", (project) => {
  editExecution(project, (execution) => { record(execution.resources).prepare = ["shared", "shared"]; });
}, /invalid resources for node 'prepare'/);

rejectedProjectCase("unsafe resource key", (project) => {
  editExecution(project, (execution) => { record(execution.resources).prepare = ["unsafe key"]; });
}, /invalid resources for node 'prepare'/);

rejectedProjectCase("malformed caller declaration", (project) => {
  const workflow = readWorkflowObject(project);
  workflow.inputs = { goal: { wrong: "missing contract" } };
  writeWorkflowObject(project, workflow);
}, /invalid caller input declaration 'goal'/);

rejectedProjectCase("empty workflow output aliases", (project) => {
  const workflow = readWorkflowObject(project);
  workflow.outputs = [];
  writeWorkflowObject(project, workflow);
}, /must declare at least one output alias/);

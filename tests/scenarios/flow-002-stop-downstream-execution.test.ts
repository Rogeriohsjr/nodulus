import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureSequenceProject, sequenceNodes, sequenceRunRequest, sequenceSuccess } from "../support/workflow-sequence.js";

const middleOutcomes = [
  ["invalid artifact", JSON.stringify({ status: "success", artifacts: [{ name: "implementation", contract: "implementation.v1", data: { text: 99 } }] }), "error"],
  ["provider error", JSON.stringify({ status: "error", error: { code: "BUILD_FAILED", message: "Cannot build." } }), "error"],
  ["needs_input", JSON.stringify({ status: "needs_input", request: { id: "model-id", questions: [{ id: "confirm", message: "Confirm the target?" }], answerContract: { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] } } }), "needs_input"],
] as const;

test.each(middleOutcomes)("FLOW-002 stops after the middle node returns %s", async (_label, middleRaw, expectedStatus) => {
  const project = createInitializedProject("flow-002");
  configureSequenceProject(project);
  const invocations: string[] = [];
  const rawByNode: Record<string, string> = {
    analyze: sequenceSuccess("analysis result", "findings", "finding.v1"),
    build: middleRaw,
    review: sequenceSuccess("must not run", "review", "review.v1"),
  };
  try {
    const result = await runWorkflow(sequenceRunRequest(project), {
      async invoke(invocation) {
        invocations.push(invocation.nodeId);
        if (!rawByNode[invocation.nodeId]) throw new Error(`Unexpected provider invocation: ${invocation.nodeId}`);
        return rawByNode[invocation.nodeId];
      },
    });
    expect(result.status).toBe(expectedStatus);
    expect(invocations).toEqual(sequenceNodes.slice(0, 2));
    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    expect(existsSync(path.join(runDirectory, "nodes", "analyze", "artifacts", "findings.json"))).toBe(true);
    expect(existsSync(path.join(runDirectory, "nodes", "review", "attempt-001"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(runDirectory, "run.json"), "utf8")).completedNodes).toContain("analyze");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

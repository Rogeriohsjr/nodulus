import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { configureExpectedOutput, createRunRequest, scriptedProvider, successResponse } from "../support/node-execution.js";
import { createInitializedProject } from "../support/intake-project.js";

test("NODE-004 accepts schema-valid pass=false review content without an explicit rejecting validator", async () => {
  const project = createInitializedProject("node-004");
  const reviewSchema = {
    type: "object",
    properties: {
      pass: { type: "boolean" },
      findings: { type: "array", items: { type: "string" } },
    },
    required: ["pass", "findings"],
    additionalProperties: false,
  };
  const review = { pass: false, findings: ["The evidence does not support approval."] };
  configureExpectedOutput(project, { name: "review", contract: "review.v1", schema: reviewSchema });

  try {
    const result = await runWorkflow(createRunRequest(project), scriptedProvider(successResponse(review, "review", "review.v1")));
    expect(result.status).toBe("success");
    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    expect(JSON.parse(readFileSync(path.join(runDirectory, "nodes", "example", "artifacts", "review.json"), "utf8"))).toMatchObject({
      name: "review",
      contract: "review.v1",
      data: review,
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

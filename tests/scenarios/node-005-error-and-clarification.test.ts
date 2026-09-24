import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { createRunRequest, scriptedProvider } from "../support/node-execution.js";
import { createInitializedProject } from "../support/intake-project.js";

test("NODE-005 persists a validated provider error as a terminal error result", async () => {
  const project = createInitializedProject("node-005-error");
  const raw = JSON.stringify({ status: "error", error: { code: "PROVIDER_REJECTED", message: "The request was rejected." } });
  try {
    const result = await runWorkflow(createRunRequest(project), scriptedProvider(raw));
    expect(result.status).toBe("error");
    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    expect(readFileSync(path.join(runDirectory, "result.json"), "utf8")).toContain("PROVIDER_REJECTED");
    expect(readFileSync(path.join(runDirectory, "nodes", "example", "attempt-001", "response.raw.txt"), "utf8")).toBe(raw);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("NODE-005 stores needs_input as a pause and does not write terminal result.json", async () => {
  const project = createInitializedProject("node-005-pause");
  const raw = JSON.stringify({
    status: "needs_input",
    request: {
      id: "model-suggested-id",
      questions: [{ id: "target", message: "Which audience should this target?" }],
      answerContract: {
        type: "object",
        properties: { audience: { type: "string", minLength: 1 } },
        required: ["audience"],
        additionalProperties: false,
      },
    },
  });
  try {
    const result = await runWorkflow(createRunRequest(project), scriptedProvider(raw));
    expect(result.status).toBe("needs_input");
    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    expect(existsSync(path.join(runDirectory, "result.json"))).toBe(false);
    const checkpoint = JSON.parse(readFileSync(path.join(runDirectory, "run.json"), "utf8"));
    expect(checkpoint.status).toBe("needs_input");
    const pending = JSON.parse(readFileSync(path.join(runDirectory, "pending", "request.json"), "utf8"));
    expect(pending.questions).toEqual([{ id: "target", message: "Which audience should this target?" }]);
    expect(pending.id).not.toBe("model-suggested-id");
    expect(JSON.parse(readFileSync(path.join(runDirectory, "nodes", "example", "attempt-001", "result.json"), "utf8"))).toMatchObject({
      status: "needs_input",
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("NODE-005 converts an external provider exception to a persisted error outcome", async () => {
  const project = createInitializedProject("node-005-provider-failure");
  try {
    const result = await runWorkflow(createRunRequest(project), scriptedProvider(new Error("provider boundary failed")));
    expect(result.status).toBe("error");
    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    expect(readFileSync(path.join(runDirectory, "result.json"), "utf8")).toContain("provider boundary failed");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

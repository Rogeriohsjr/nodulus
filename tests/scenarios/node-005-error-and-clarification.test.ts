import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { resumeWorkflow } from "../../src/application/resume-workflow.js";
import { createRunRequest, scriptedProvider } from "../support/node-execution.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureSequenceProject, sequenceRunRequest, sequenceSuccess } from "../support/workflow-sequence.js";

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

test("NODE-005 resumes an ordinary pause without replaying its completed prefix", async () => {
  const project = createInitializedProject("node-005-resume");
  configureSequenceProject(project);
  const invocations: Array<{ nodeId: string; answers?: Record<string, unknown> }> = [];
  let call = 0;
  const provider = {
    async invoke(invocation: { nodeId: string; answers?: Record<string, unknown> }) {
      invocations.push(invocation);
      call += 1;
      if (call === 1) return sequenceSuccess("analyzed", "findings", "finding.v1");
      if (call === 2) return JSON.stringify({
        status: "needs_input",
        request: {
          id: "model-suggested-id",
          questions: [{ id: "detail", message: "Which detail should be included?" }],
          answerContract: { type: "object", required: ["detail"], properties: { detail: { type: "string", minLength: 1 } }, additionalProperties: false },
        },
      });
      if (call === 3) return sequenceSuccess("implemented", "implementation", "implementation.v1");
      if (call === 4) return sequenceSuccess("reviewed", "review", "review.v1");
      throw new Error("Unexpected provider invocation.");
    },
  };

  try {
    const initial = await runWorkflow(sequenceRunRequest(project), provider);
    expect(initial.status).toBe("needs_input");
    const runDirectory = path.join(project, ".nodulus", "runs", initial.runId);
    expect(existsSync(path.join(runDirectory, "result.json"))).toBe(false);
    const paused = JSON.parse(readFileSync(path.join(runDirectory, "run.json"), "utf8")) as { status: string; requestId: string; completedNodes: string[] };
    expect(paused).toMatchObject({ status: "needs_input", completedNodes: ["analyze"] });
    const pending = JSON.parse(readFileSync(path.join(runDirectory, "pending", "request.json"), "utf8")) as { id: string };
    expect(paused.requestId).toBe(pending.id);
    expect(pending.id).not.toBe("model-suggested-id");
    const prefixResponse = readFileSync(path.join(runDirectory, "nodes", "analyze", "attempt-001", "response.raw.txt"), "utf8");
    const prefixResult = readFileSync(path.join(runDirectory, "nodes", "analyze", "attempt-001", "result.json"), "utf8");
    const pausedAttempt = readFileSync(path.join(runDirectory, "nodes", "build", "attempt-001", "result.json"), "utf8");

    const resumed = await resumeWorkflow({ projectRoot: project, runId: initial.runId, requestId: pending.id, answers: { detail: "Include the empty-input case." } }, provider);

    expect(resumed.status).toBe("success");
    expect(invocations.map(({ nodeId }) => nodeId)).toEqual(["analyze", "build", "build", "review"]);
    expect(invocations[2]?.answers).toEqual({ detail: "Include the empty-input case." });
    expect(readFileSync(path.join(runDirectory, "nodes", "analyze", "attempt-001", "response.raw.txt"), "utf8")).toBe(prefixResponse);
    expect(readFileSync(path.join(runDirectory, "nodes", "analyze", "attempt-001", "result.json"), "utf8")).toBe(prefixResult);
    expect(readFileSync(path.join(runDirectory, "nodes", "build", "attempt-001", "result.json"), "utf8")).toBe(pausedAttempt);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

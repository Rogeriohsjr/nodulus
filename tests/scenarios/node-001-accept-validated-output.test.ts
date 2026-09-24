import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { createRunRequest, scriptedProvider, successResponse, validData } from "../support/node-execution.js";
import { createInitializedProject } from "../support/intake-project.js";

test("NODE-001 sends real Markdown and schema context, then persists an accepted artifact and terminal result", async () => {
  const project = createInitializedProject("node-001");
  const requestText = "Inspect the café workflow and preserve the conclusion.";
  const promptParts: string[] = [];

  try {
    const result = await runWorkflow(
      createRunRequest(project, requestText),
      scriptedProvider(successResponse(validData), (invocation) => promptParts.push(invocation.prompt)),
    );
    expect(result.status).toBe("success");
    expect(promptParts).toHaveLength(1);
    expect(promptParts[0]).toContain(requestText);
    expect(promptParts[0]).toContain("Read the request and return one `example` artifact");
    expect(promptParts[0]).toContain("Example output");
    expect(result.runId).toMatch(/\S/);

    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    const attempt = path.join(runDirectory, "nodes", "example", "attempt-001");
    expect(readFileSync(path.join(attempt, "response.raw.txt"), "utf8")).toBe(successResponse(validData));
    expect(JSON.parse(readFileSync(path.join(attempt, "validation.json"), "utf8"))).toMatchObject({ valid: true });
    expect(JSON.parse(readFileSync(path.join(attempt, "result.json"), "utf8"))).toMatchObject({ status: "success" });
    expect(JSON.parse(readFileSync(path.join(runDirectory, "nodes", "example", "artifacts", "example.json"), "utf8"))).toEqual({
      name: "example",
      contract: "example.v1",
      data: validData,
    });
    expect(JSON.parse(readFileSync(path.join(runDirectory, "result.json"), "utf8"))).toMatchObject({
      runId: result.runId,
      status: "success",
    });
    expect(existsSync(path.join(runDirectory, "result.json"))).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("NODE-001 does not publish success when accepted artifact persistence fails", async () => {
  const project = createInitializedProject("node-001-persist-failure");
  let runId = "";
  try {
    await expect(runWorkflow(
      createRunRequest(project),
      scriptedProvider(successResponse(validData), (invocation) => {
        runId = invocation.runId;
        const artifactsPath = path.join(project, ".nodulus", "runs", runId, "nodes", "example", "artifacts");
        mkdirSync(path.dirname(artifactsPath), { recursive: true });
        writeFileSync(artifactsPath, "block artifact directory", "utf8");
      }),
    )).rejects.toThrow();

    const runDirectory = path.join(project, ".nodulus", "runs", runId);
    const checkpoint = JSON.parse(readFileSync(path.join(runDirectory, "run.json"), "utf8"));
    expect(checkpoint.status).not.toBe("success");
    expect(existsSync(path.join(runDirectory, "result.json"))).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

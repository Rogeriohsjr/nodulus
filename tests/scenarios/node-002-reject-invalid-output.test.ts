import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { createRunRequest, scriptedProvider, successResponse, validData } from "../support/node-execution.js";
import { createInitializedProject } from "../support/intake-project.js";

const variants: Array<[string, string]> = [
  ["malformed JSON", "{not-json"],
  ["invalid outcome", JSON.stringify({ status: "completed", artifacts: [] })],
  ["missing expected artifact", JSON.stringify({ status: "success", artifacts: [] })],
  ["duplicate artifact", JSON.stringify({
    status: "success",
    artifacts: [
      { name: "example", contract: "example.v1", data: validData },
      { name: "example", contract: "example.v1", data: validData },
    ],
  })],
  ["wrong artifact field type", successResponse({ message: 42 })],
];

test.each(variants)("NODE-002 rejects %s and saves raw response and validation diagnostics", async (_caseName, raw) => {
  const project = createInitializedProject("node-002");
  try {
    const result = await runWorkflow(createRunRequest(project), scriptedProvider(raw));
    expect(result.status).toBe("error");
    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    const attempt = path.join(runDirectory, "nodes", "example", "attempt-001");
    expect(readFileSync(path.join(attempt, "response.raw.txt"), "utf8")).toBe(raw);
    const validation = JSON.parse(readFileSync(path.join(attempt, "validation.json"), "utf8"));
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
    expect(existsSync(path.join(runDirectory, "nodes", "example", "artifacts", "example.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(runDirectory, "result.json"), "utf8"))).toMatchObject({
      runId: result.runId,
      status: "error",
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("NODE-002 does not persist an earlier valid artifact when a later expected artifact fails schema validation", async () => {
  const project = createInitializedProject("node-002-atomic-output");
  const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  node.expectedOutputs = [
    { name: "example", contract: "example.v1" },
    { name: "count", contract: "count.v1" },
  ];
  writeFileSync(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");
  writeFileSync(
    path.join(project, ".nodulus", "contracts", "count.v1.schema.json"),
    `${JSON.stringify({ type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false }, null, 2)}\n`,
    "utf8",
  );
  const raw = JSON.stringify({
    status: "success",
    artifacts: [
      { name: "example", contract: "example.v1", data: validData },
      { name: "count", contract: "count.v1", data: { count: "not a number" } },
    ],
  });

  try {
    const result = await runWorkflow(createRunRequest(project), scriptedProvider(raw));
    expect(result.status).toBe("error");
    const artifactsDirectory = path.join(project, ".nodulus", "runs", result.runId, "nodes", "example", "artifacts");
    expect(existsSync(path.join(artifactsDirectory, "example.json"))).toBe(false);
    expect(existsSync(path.join(artifactsDirectory, "count.json"))).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

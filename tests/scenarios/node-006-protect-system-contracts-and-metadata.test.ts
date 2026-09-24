import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { createRunRequest, scriptedProvider } from "../support/node-execution.js";
import { createInitializedProject } from "../support/intake-project.js";

const overrideCases = [
  ["success", { status: "success", artifacts: [] }],
  ["needs_input", { status: "needs_input", request: {} }],
  ["error", { status: "error", error: {} }],
] as const;

test.each(overrideCases)("NODE-006 ignores project override of the package-owned %s outcome contract", async (contractName, rawValue) => {
  const project = createInitializedProject("node-006-contract");
  const contractDirectory = path.join(project, ".nodulus", "contracts");
  mkdirSync(contractDirectory, { recursive: true });
  writeFileSync(path.join(contractDirectory, `system.${contractName}.v1.schema.json`), "true\n", "utf8");
  try {
    const result = await runWorkflow(createRunRequest(project), scriptedProvider(JSON.stringify(rawValue)));
    expect(result.status).toBe("error");
    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    const validation = JSON.parse(readFileSync(path.join(runDirectory, "nodes", "example", "attempt-001", "validation.json"), "utf8"));
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path.join(runDirectory, "result.json"), "utf8")).runId).toBe(result.runId);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("NODE-006 keeps the actual run identity when a provider invents run metadata", async () => {
  const project = createInitializedProject("node-006-run-id");
  const providerRunId = "provider-chosen-run-id";
  const raw = JSON.stringify({
    status: "success",
    runId: providerRunId,
    artifacts: [{ name: "example", contract: "example.v1", data: { message: "safe" } }],
  });
  try {
    const result = await runWorkflow(createRunRequest(project), scriptedProvider(raw));
    expect(result.runId).not.toBe(providerRunId);
    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    expect(JSON.parse(readFileSync(path.join(runDirectory, "run.json"), "utf8")).runId).toBe(result.runId);
    expect(JSON.parse(readFileSync(path.join(runDirectory, "result.json"), "utf8")).runId).toBe(result.runId);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

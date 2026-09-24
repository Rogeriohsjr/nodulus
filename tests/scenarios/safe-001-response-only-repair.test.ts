import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { cleanupClarificationProject } from "../support/clarification-resume.js";
import { createRecoveryProject, directProvider, recoveryRequest, runFile, successfulNodeResponse } from "../support/recovery-scenarios.js";

test("SAFE-001 repairs an invalid response with exact feedback without replaying the node action", async () => {
  const { project } = createRecoveryProject("safe-001");
  const invoked: string[] = [];
  const repairs: Array<{ nodeId: string; previous: string; errors: string[] }> = [];
  try {
    const provider = directProvider(
      (invocation) => {
        invoked.push(invocation.nodeId);
        return invocation.nodeId === "analyze" ? "{ malformed" : successfulNodeResponse(invocation);
      },
      (invocation, previousRaw, validationErrors) => {
        repairs.push({ nodeId: invocation.nodeId, previous: previousRaw, errors: validationErrors });
        return successfulNodeResponse(invocation);
      },
    );
    const result = await runWorkflow(recoveryRequest(project), provider);

    expect(result.status).toBe("success");
    expect(invoked).toEqual(["analyze", "build", "review"]);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].nodeId).toBe("analyze");
    expect(repairs[0].previous).toBe("{ malformed");
    const firstValidation = JSON.parse(readFileSync(runFile(project, result.runId, "nodes/analyze/attempt-001/validation.json"), "utf8"));
    expect(repairs[0].errors).toEqual(firstValidation.errors);
    expect(repairs[0].errors.join(" ")).toMatch(/valid JSON/i);
    expect(readFileSync(runFile(project, result.runId, "nodes/analyze/attempt-001/response.raw.txt"), "utf8")).toBe("{ malformed");
    expect(firstValidation.valid).toBe(false);
    expect(JSON.parse(readFileSync(runFile(project, result.runId, "nodes/analyze/attempt-002/validation.json"), "utf8")).valid).toBe(true);
    expect(JSON.parse(readFileSync(runFile(project, result.runId, "nodes/analyze/artifacts/findings.json"), "utf8")).data.text).toBe("findings");
  } finally {
    cleanupClarificationProject(project);
  }
});

test("SAFE-001 repairs an invalid artifact contract in a valid provider envelope", async () => {
  const { project } = createRecoveryProject("safe-001-wrong-contract");
  const invokes: string[] = [];
  const repairs: string[][] = [];
  try {
    const result = await runWorkflow(recoveryRequest(project), directProvider(
      (invocation) => {
        invokes.push(invocation.nodeId);
        return invocation.nodeId === "analyze"
          ? JSON.stringify({ status: "success", artifacts: [{ name: "findings", contract: "wrong.v1", data: { text: "bad contract" } }] })
          : successfulNodeResponse(invocation);
      },
      (invocation, _previous, errors) => {
        repairs.push(errors);
        return successfulNodeResponse(invocation);
      },
    ));
    expect(result.status).toBe("success");
    expect(invokes).toEqual(["analyze", "build", "review"]);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].join(" ")).toMatch(/contract|expected|finding\.v1/i);
    expect(JSON.parse(readFileSync(runFile(project, result.runId, "nodes/analyze/attempt-001/validation.json"), "utf8")).valid).toBe(false);
    expect(JSON.parse(readFileSync(runFile(project, result.runId, "nodes/analyze/attempt-002/validation.json"), "utf8")).valid).toBe(true);
  } finally {
    cleanupClarificationProject(project);
  }
});

test("SAFE-001 repairs a semantic validator rejection without repeating the node action", async () => {
  const { project } = createRecoveryProject("safe-001-semantic-rejection");
  const validatorPath = ".nodulus/validators/analyze.mjs";
  const validatorCounter = ".nodulus/fixtures/analyze-validator-count";
  const validatorFile = path.join(project, validatorPath);
  mkdirSync(path.dirname(validatorFile), { recursive: true });
  writeFileSync(validatorFile, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    `const countPath = ${JSON.stringify(validatorCounter)};`,
    "const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;",
    "writeFileSync(countPath, String(count + 1));",
    "process.stdout.write(JSON.stringify(count === 0 ? { valid: false, errors: ['semantic finding is incomplete'] } : { valid: true, errors: [] }));",
    "",
  ].join("\n"), "utf8");
  const analyzeFile = path.join(project, ".nodulus", "nodes", "analyze.json");
  const analyze = JSON.parse(readFileSync(analyzeFile, "utf8"));
  analyze.expectedOutputs[0].validator = validatorPath;
  analyze.expectedOutputs[0].validatorTimeoutMs = 1000;
  writeFileSync(analyzeFile, `${JSON.stringify(analyze, null, 2)}\n`, "utf8");
  const invokes: string[] = [];
  const repairs: string[][] = [];
  try {
    const result = await runWorkflow(recoveryRequest(project), directProvider(
      (invocation) => { invokes.push(invocation.nodeId); return successfulNodeResponse(invocation); },
      (invocation, _previous, errors) => { repairs.push(errors); return successfulNodeResponse(invocation); },
    ));
    expect(result.status).toBe("success");
    expect(invokes).toEqual(["analyze", "build", "review"]);
    expect(repairs).toEqual([["semantic finding is incomplete"]]);
    expect(readFileSync(path.join(project, validatorCounter), "utf8")).toBe("2");
    expect(JSON.parse(readFileSync(runFile(project, result.runId, "nodes/analyze/attempt-001/validation.json"), "utf8"))).toMatchObject({ valid: false, errors: ["semantic finding is incomplete"] });
    expect(JSON.parse(readFileSync(runFile(project, result.runId, "nodes/analyze/attempt-002/validation.json"), "utf8")).valid).toBe(true);
  } finally {
    cleanupClarificationProject(project);
  }
});

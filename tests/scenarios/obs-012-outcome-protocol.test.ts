import { Ajv2020 } from "ajv/dist/2020.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { cleanupProviderProject, createProviderScenario, readProviderCalls, runDefaultProviderCli } from "../support/provider-adapter-scenarios.js";
import { getRunStatus } from "../../src/application/resume-workflow.js";

function parsePromptSection(prompt: string, heading: string, endMarker: string): unknown {
  const start = prompt.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`Missing prompt section: ${heading}`);
  const contentStart = start + heading.length + 1;
  const end = prompt.indexOf(endMarker, contentStart);
  const content = prompt.slice(contentStart, end < 0 ? undefined : end).trim();
  return JSON.parse(content) as unknown;
}

test.each(["codex", "cursor", "opencode"] as const)("OBS-012 outcome protocol prompt is self-contained for %s", async (kind) => {
  const { project, logPath } = await createProviderScenario(kind, "named-outputs");
  try {
    const run = await runDefaultProviderCli(project, "Return the configured named outputs.");
    expect(run.code).toBe(0);
    expect(run.envelope).toMatchObject({
      status: "success",
      result: { artifacts: [
        { name: "primary", contract: "example.v1", data: { message: "fixed primary fixture" } },
        { name: "secondary", contract: "example.v1", data: { message: "fixed secondary fixture" } },
      ] },
    });
    expect(readProviderCalls(logPath)).toHaveLength(1);

    const status = await getRunStatus(project, run.envelope.runId);
    expect(status.metrics?.calls).toHaveLength(1);
    const call = status.metrics!.calls![0]!;
    expect(call.launched).toBe(true);
    const runRoot = path.join(project, ".nodulus", "runs", run.envelope.runId);
    const callRoot = path.join(runRoot, "calls", call.callId!);
    const attemptRoot = path.join(runRoot, "nodes", "example", "attempt-001");
    const prompt = readFileSync(path.join(attemptRoot, "prompt.md"), "utf8");
    const stdin = readFileSync(path.join(callRoot, "stdin.txt"), "utf8");
    const transport = JSON.parse(readFileSync(path.join(callRoot, "transport.json"), "utf8"));
    const validation = JSON.parse(readFileSync(path.join(attemptRoot, "validation.json"), "utf8"));
    const attemptResult = JSON.parse(readFileSync(path.join(attemptRoot, "result.json"), "utf8"));
    expect(transport).toMatchObject({ exitCode: 0, timedOut: false, outputLimitExceeded: false });
    expect(validation.valid).toBe(true);
    expect(attemptResult.status).toBe("success");
    expect(existsSync(path.join(runRoot, "nodes", "example", "artifacts", "primary.json"))).toBe(true);
    expect(existsSync(path.join(runRoot, "nodes", "example", "artifacts", "secondary.json"))).toBe(true);

    expect(prompt).toContain("## Expected output names and contracts");
    const expectedOutputs = parsePromptSection(prompt, "## Expected output names and contracts", "\n\n## System outcome schemas");
    expect(expectedOutputs).toEqual([
      { name: "primary", contract: "example.v1" },
      { name: "secondary", contract: "example.v1" },
    ]);
    expect(stdin).toContain("## Expected output names and contracts");
    expect(stdin).toContain("## System outcome schemas");

    const schemas = parsePromptSection(prompt, "## System outcome schemas", "\n\nReturn one JSON object");
    expect(schemas).toMatchObject({ success: expect.any(Object), needsInput: expect.any(Object), error: expect.any(Object) });
    const ajv = new Ajv2020({ strict: false });
    const validateSuccess = ajv.compile((schemas as Record<string, object>).success!);
    const validateNeedsInput = ajv.compile((schemas as Record<string, object>).needsInput!);
    const validateError = ajv.compile((schemas as Record<string, object>).error!);
    expect(validateSuccess(attemptResult)).toBe(true);
    expect(validateSuccess({ status: "unknown", artifacts: [] })).toBe(false);
    expect(validateNeedsInput({ status: "needs_input", request: { id: "question", questions: [{ id: "answer", message: "Provide an answer." }], answerContract: { type: "object" } } })).toBe(true);
    expect(validateNeedsInput({ status: "needs_input" })).toBe(false);
    expect(validateError({ status: "error", error: { code: "FIXTURE_ERROR", message: "Fixture failure." } })).toBe(true);
    expect(validateError({ status: "error", error: { code: "FIXTURE_ERROR" } })).toBe(false);
  } finally {
    cleanupProviderProject(project);
  }
}, 30_000);

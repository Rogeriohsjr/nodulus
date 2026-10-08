import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import { getRunStatus } from "../../src/application/resume-workflow.js";
import { cleanupProviderProject, createProviderScenario, readProviderCalls, runDefaultProviderCli } from "../support/provider-adapter-scenarios.js";

test("PROV-008 selects the final complete Cursor assistant message from stream-json", async () => {
  const { project, logPath } = await createProviderScenario("cursor", "stream-multiple-blocks");
  try {
    const result = await runDefaultProviderCli(project, "Return the final streamed outcome");
    expect(result.code, JSON.stringify(result.envelope)).toBe(0);
    expect(result.envelope.result.artifacts[0].data.message).toBe("joined blocks");
    const runRoot = path.join(project, ".nodulus", "runs", result.envelope.runId);
    const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
    expect(JSON.parse(readFileSync(path.join(fixtureDirectory, "provider-artifact.json"), "utf8"))).toEqual({ message: "joined blocks" });
    expect(readFileSync(path.join(fixtureDirectory, "validator-ran.txt"), "utf8")).toBe("validator executed");
    expect(readFileSync(path.join(runRoot, "nodes", "example", "attempt-001", "response.raw.txt"), "utf8")).toContain("joined blocks");
    const transport = JSON.parse(readFileSync(path.join(runRoot, "provider", "example", "attempt-001", "transport.json"), "utf8"));
    expect(transport.stdout).toContain('"type":"assistant"');
    expect(transport.stdout).toContain('"type":"result"');
    expect(transport.stderr).toBe("");
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(1);
    assertStreamInvocation(calls[0]);
    const status = await getRunStatus(project, result.envelope.runId);
    const telemetry = status.metrics?.calls[0]?.telemetry;
    if (telemetry === undefined) throw new Error("Cursor telemetry was not persisted.");
    expect(telemetry.reported).toMatchObject({ inputTokens: 17, outputTokens: 9 });
    expect(telemetry.reportedModel).toBe("fixture-cursor-model");
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([
  { mode: "stream-final-malformed", expected: "RESPONSE_REPAIR_UNAVAILABLE", diagnostic: "Safe response-only repair is unavailable" },
  { mode: "stream-final-empty", expected: "RESPONSE_REPAIR_UNAVAILABLE", diagnostic: "Safe response-only repair is unavailable" },
  { mode: "stream-missing-terminal", expected: "PROVIDER_FAILURE", diagnostic: "missing its terminal result" },
  { mode: "stream-failed-terminal", expected: "PROVIDER_FAILURE", diagnostic: "terminal result did not report success" },
  { mode: "stream-malformed-line", expected: "PROVIDER_FAILURE", diagnostic: "malformed NDJSON" },
  { mode: "stream-nonzero", expected: "PROVIDER_FAILURE", diagnostic: "exited with code 23" },
  { mode: "stream-validator-reject", expected: "RESPONSE_REPAIR_UNAVAILABLE", diagnostic: "Safe response-only repair is unavailable" },
])("PROV-008 rejects Cursor $mode without replaying inference", async ({ mode, expected, diagnostic }) => {
  const { project, logPath } = await createProviderScenario("cursor", mode);
  try {
    const result = await runDefaultProviderCli(project, "Do not accept an invalid final outcome");
    expect(result.code).toBe(1);
    expect(result.envelope.result.error.code).toBe(expected);
    expect(result.envelope.result.error.message).toContain(diagnostic);
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(1);
    assertStreamInvocation(calls[0]);
    const runRoot = path.join(project, ".nodulus", "runs", result.envelope.runId);
    const providerRoot = path.join(runRoot, "provider", "example", "attempt-001");
    const transport = JSON.parse(readFileSync(path.join(providerRoot, "transport.json"), "utf8"));
    expect(transport.stdout).toContain('"type":"assistant"');
    expect(typeof transport.stderr).toBe("string");
    expect(existsSync(path.join(runRoot, "nodes", "successor", "attempt-001"))).toBe(false);
    if (mode === "stream-final-malformed" || mode === "stream-final-empty") {
      const attempt = path.join(runRoot, "nodes", "example", "attempt-001");
      expect(readFileSync(path.join(attempt, "validation.json"), "utf8")).toContain("INVALID_NODE_RESPONSE");
      expect(readFileSync(path.join(attempt, "response.raw.txt"), "utf8")).toBe(mode === "stream-final-empty" ? "" : "not JSON");
    }
    if (mode === "stream-validator-reject") {
      const validation = JSON.parse(readFileSync(path.join(runRoot, "nodes", "example", "attempt-001", "validation.json"), "utf8"));
      expect(validation.code).toBe("ARTIFACT_REJECTED");
      expect(validation.errors).toEqual(["fixture validator rejected disk artifact; expected artifact data to match fixture result"]);
      const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
      expect(JSON.parse(readFileSync(path.join(fixtureDirectory, "provider-artifact.json"), "utf8"))).toEqual({ message: "mismatched disk artifact" });
      expect(readFileSync(path.join(fixtureDirectory, "validator-ran.txt"), "utf8")).toBe("validator executed");
    }
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-008 validator fixture runs and reports a semantic rejection", async () => {
  const { project } = await createProviderScenario("cursor", "stream-validator-reject");
  try {
    const validator = path.join(project, ".nodulus", "validators", "reject.mjs");
    const checked = spawnSync(process.execPath, [validator], { input: JSON.stringify({ message: "fixture result" }), encoding: "utf8" });
    expect(checked.error).toBeUndefined();
    expect(checked.status).toBe(0);
    expect(JSON.parse(checked.stdout)).toEqual({ valid: false, errors: ["fixture validator rejected disk artifact; expected artifact data to match fixture result"] });
    expect(readFileSync(path.join(project, ".nodulus", "fixtures", "validator-ran.txt"), "utf8")).toBe("validator executed");
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([
  { mode: "stream-needs-input", code: 2, status: "needs_input" },
  { mode: "stream-error", code: 1, status: "error" },
])("PROV-008 preserves Cursor $status outcomes", async ({ mode, code, status }) => {
  const { project, logPath } = await createProviderScenario("cursor", mode);
  try {
    const result = await runDefaultProviderCli(project, "Return a terminal outcome");
    expect(result.code).toBe(code);
    expect(result.envelope.status).toBe(status);
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(1);
    assertStreamInvocation(calls[0]);
    expect(existsSync(path.join(project, ".nodulus", "runs", result.envelope.runId, "nodes", "successor", "attempt-001"))).toBe(false);
    if (mode === "stream-error") expect(result.envelope.result.error.code).toBe("FIXTURE_ERROR");
  } finally {
    cleanupProviderProject(project);
  }
});

function assertStreamInvocation(call: any): void {
  expect(call.argv).toContain("--output-format");
  expect(call.argv[call.argv.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(call.argv).not.toContain("--stream-partial-output");
}

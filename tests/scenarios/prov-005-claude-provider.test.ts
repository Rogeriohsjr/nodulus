import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import { getRunStatus } from "../../src/application/resume-workflow.js";
import { parseProviderTelemetry } from "../../src/adapters/providers/provider-telemetry.js";
import { cleanupProviderProject, createProviderScenario, readProviderCalls } from "../support/provider-adapter-scenarios.js";

test("PROV-005 reports Claude JSON usage through the shared telemetry contract", () => {
  const telemetry = parseProviderTelemetry("claude", JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    model: "claude-sonnet-fixture",
    structured_output: { status: "success", artifacts: [] },
    usage: { input_tokens: 17, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.001,
  }), "2.1.294");
  expect(telemetry).toMatchObject({
    provider: "claude",
    reportedModel: "claude-sonnet-fixture",
    coverage: "complete",
    reported: { inputTokens: 17, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: null, costUsd: 0.001 },
    normalized: { inputTokens: 20, outputTokens: 8 },
  });
});

test("PROV-005 does not infer zero cache creation when Claude omits that counter", () => {
  const telemetry = parseProviderTelemetry("claude", JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    usage: { input_tokens: 17, output_tokens: 8, cache_read_input_tokens: 3 },
    total_cost_usd: 0.001,
  }), "2.1.294");
  expect(telemetry).toMatchObject({
    provider: "claude",
    coverage: "partial",
    reported: { inputTokens: 17, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: null, reasoningTokens: null, costUsd: 0.001 },
    normalized: { inputTokens: null, outputTokens: 8 },
  });
});

test("PROV-005 prefers a valid top-level Claude model over modelUsage metadata", () => {
  const telemetry = parseProviderTelemetry("claude", JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    model: "claude-haiku-5-5",
    modelUsage: { "claude-sonnet-4-5": { canonicalModel: "claude-sonnet-4-5" } },
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.001,
  }), "2.1.295");
  expect(telemetry.reportedModel).toBe("claude-haiku-5-5");
});

test("PROV-005 keeps Claude normalization unknown outside the verified CLI version", () => {
  const telemetry = parseProviderTelemetry("claude", JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    model: "claude-sonnet-fixture",
    usage: { input_tokens: 17, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.001,
  }), "2.1.296");
  expect(telemetry).toMatchObject({
    provider: "claude",
    cliVersion: "2.1.296",
    coverage: "complete",
    reported: { inputTokens: 17, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: 0.001 },
    normalized: { inputTokens: null, outputTokens: null },
    semantics: { inputCache: "unknown", outputReasoning: "unknown", evidence: null },
  });
});

test.each([
  ["missing", undefined],
  ["empty", {}],
  ["multiple", {
    "claude-haiku-5-5": { canonicalModel: "claude-haiku-5-5" },
    "claude-sonnet-4-5": { canonicalModel: "claude-sonnet-4-5" },
  }],
] as const)("PROV-005 keeps the reported Claude model null when modelUsage is %s", (_label, modelUsage) => {
  const telemetry = parseProviderTelemetry("claude", JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    ...(modelUsage === undefined ? {} : { modelUsage }),
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.001,
  }), "2.1.296");
  expect(telemetry.reportedModel).toBeNull();
});

test("PROV-005 replays captured Haiku success through the compiled CLI with observed usage", async () => {
  const { project, logPath } = await createProviderScenario("claude", "observed-success", { model: "haiku", maxTurns: 3, maxBudgetUsd: 0.05, tools: "", safeMode: true });
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Replay captured Haiku success", "--json"]);
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("success");
    expect(envelope.result.artifacts[0].data.message).toBe("CLAUDE-HAIKU-PING");
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv[calls[0].argv.indexOf("--model") + 1]).toBe("haiku");
    expect(calls[0].argv[calls[0].argv.indexOf("--max-turns") + 1]).toBe("3");
    expect(calls[0].argv[calls[0].argv.indexOf("--max-budget-usd") + 1]).toBe("0.05");
    expect(calls[0].argv[calls[0].argv.indexOf("--tools") + 1]).toBe("");
    expect(calls[0].argv[calls[0].argv.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }));
    expect(calls[0].argv).toContain("--strict-mcp-config");
    expect(calls[0].argv).toContain("--safe-mode");
    const status = await getRunStatus(project, envelope.runId);
    expect(status.metrics?.calls[0]?.telemetry).toMatchObject({
      cliVersion: "2.1.295",
      reportedModel: "claude-haiku-5-5",
      reported: { inputTokens: 2, outputTokens: 106, cacheReadTokens: 0, cacheWriteTokens: 5208, reasoningTokens: 0, costUsd: 0.0007042 },
      normalized: { inputTokens: 5210, outputTokens: 106 },
      semantics: { inputCache: "excluded", outputReasoning: "included" },
    });
    expect(status.metrics?.calls[0]?.usage).toEqual({ inputTokens: 5210, outputTokens: 106, cacheReadTokens: 0, costUsd: 0.0007042 });
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-005 replays captured Haiku controlled error and reports inclusive reasoning without successor", async () => {
  const { project, logPath } = await createProviderScenario("claude", "observed-controlled-error", { model: "haiku", maxTurns: 3, maxBudgetUsd: 0.05, tools: "", safeMode: true });
  configureTwoNodes(project);
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Replay captured controlled Haiku error", "--json"]);
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.result.error).toEqual({ code: "SMOKE_EXPECTED_FAILURE", message: "ControlledHaiku failurefixture" });
    expect(envelope.result.artifacts).toBeUndefined();
    expect(readProviderCalls(logPath)).toHaveLength(1);
    expect(existsSync(path.join(project, ".nodulus", "runs", envelope.runId, "nodes", "second", "attempt-001"))).toBe(false);
    expect(existsSync(path.join(project, ".nodulus", "runs", envelope.runId, "nodes", "second", "artifacts", "example.json"))).toBe(false);
    const status = await getRunStatus(project, envelope.runId);
    expect(status.metrics?.calls[0]?.telemetry).toMatchObject({
      cliVersion: "2.1.295",
      reportedModel: "claude-haiku-5-5",
      reported: { inputTokens: 2, outputTokens: 273, cacheReadTokens: 2477, cacheWriteTokens: 2931, reasoningTokens: 170, costUsd: 0.000527845 },
      normalized: { inputTokens: 5410, outputTokens: 273 },
      semantics: { inputCache: "excluded", outputReasoning: "included" },
    });
    expect(status.metrics?.calls[0]?.usage).toEqual({ inputTokens: 5410, outputTokens: 273, cacheReadTokens: 2477, costUsd: 0.000527845 });
    const [call] = readProviderCalls(logPath);
    expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(call.argv[call.argv.indexOf("--max-turns") + 1]).toBe("3");
    expect(call.argv[call.argv.indexOf("--max-budget-usd") + 1]).toBe("0.05");
    expect(call.argv[call.argv.indexOf("--tools") + 1]).toBe("");
    expect(call.argv[call.argv.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }));
    expect(call.argv).toContain("--strict-mcp-config");
    expect(call.argv).toContain("--safe-mode");
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-005 replays captured Claude MCP startup failure and starts no successor", async () => {
  const { project, logPath } = await createProviderScenario("claude", "observed-mcp-startup-failure", { model: "haiku", maxTurns: 3, maxBudgetUsd: 0.05, tools: "", safeMode: true });
  configureTwoNodes(project);
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Replay captured MCP startup error", "--json"]);
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("error");
    expect(envelope.result.error.code).toBe("PROVIDER_PROCESS_FAILED");
    expect(envelope.result.error.message).toContain("Invalid MCP configuration");
    expect(envelope.result.error.message).toContain("mcpServers: Invalid input: expected record, received undefined");
    expect(readProviderCalls(logPath)).toHaveLength(1);
    expect(existsSync(path.join(project, ".nodulus", "runs", envelope.runId, "nodes", "second", "attempt-001"))).toBe(false);
    const [call] = readProviderCalls(logPath);
    expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(call.argv[call.argv.indexOf("--max-turns") + 1]).toBe("3");
    expect(call.argv[call.argv.indexOf("--max-budget-usd") + 1]).toBe("0.05");
    expect(call.argv[call.argv.indexOf("--tools") + 1]).toBe("");
    expect(call.argv[call.argv.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }));
    expect(call.argv).toContain("--strict-mcp-config");
    expect(call.argv).toContain("--safe-mode");
    const status = await getRunStatus(project, envelope.runId);
    expect(status.metrics?.calls[0]?.telemetry?.coverage).toBe("unavailable");
    expect(status.metrics?.calls[0]?.usage).toBeNull();
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-005 captured Haiku API counters normalize from actual CLI payload shape", () => {
  const fixture = JSON.parse(readFileSync(path.resolve("tests/fixtures/providers/claude/haiku-controlled-error.json"), "utf8"));
  const telemetry = parseProviderTelemetry("claude", JSON.stringify(fixture.payload), fixture.cliVersion);
  expect(telemetry).toMatchObject({
    cliVersion: "2.1.295",
    reportedModel: "claude-haiku-5-5",
    reported: { inputTokens: 2, outputTokens: 273, cacheReadTokens: 2477, cacheWriteTokens: 2931, reasoningTokens: 170, costUsd: 0.000527845 },
    normalized: { inputTokens: 5410, outputTokens: 273 },
    semantics: { inputCache: "excluded", outputReasoning: "included" },
  });
});

test("PROV-005 Claude maps Haiku to Sonnet across a two-node compiled CLI workflow", async () => {
  const { project, logPath } = await createProviderScenario("claude", "success", { model: "haiku", maxTurns: 3, maxBudgetUsd: 0.05, tools: "", safeMode: true });
  const workflowPath = path.join(project, ".nodulus", "workflows", "example.json");
  const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
  workflow.nodes = ["example", "second"];
  writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
  const second = JSON.parse(readFileSync(nodePath, "utf8"));
  second.id = "second";
  second.providerProfile = "sonnet";
  second.inputs = { previous: { from: "example.example", contract: "example.v1" } };
  writeFileSync(path.join(project, ".nodulus", "nodes", "second.json"), `${JSON.stringify(second, null, 2)}\n`, "utf8");
  writeFileSync(path.join(project, ".nodulus", "instructions", "second.md"), "Produce the second artifact.\n", "utf8");
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles.sonnet = { ...settings.providerProfiles.fixture, model: "sonnet", maxTurns: 3, maxBudgetUsd: 0.05, tools: "", safeMode: true };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Run both Claude nodes", "--json"]);
    const capturedRunId = JSON.parse(result.stdout).runId;
    const startup = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", capturedRunId, "provider", "example", "attempt-001", "transport.json"), "utf8"));
    const observedTransport = { exitCode: startup.exitCode, stdout: startup.stdout, stderr: startup.stderr };
    const actualFailure = JSON.parse(readFileSync(path.resolve("tests/fixtures/providers/claude/mcp-empty-config-startup-failure.json"), "utf8"));
    expect(actualFailure).toEqual({
      cliVersion: "2.1.295",
      exitCode: 1,
      stdout: "",
      stderr: "Error: Invalid MCP configuration:\nmcpServers: Invalid input: expected record, received undefined\n",
    });
    expect(observedTransport).not.toEqual({ exitCode: actualFailure.exitCode, stdout: actualFailure.stdout, stderr: actualFailure.stderr });
    const calls = readProviderCalls(logPath);
    const mcpConfigIndex = calls[0].argv.indexOf("--mcp-config");
    expect(calls[0].argv[mcpConfigIndex + 1], JSON.stringify({ status: result.status, transport: observedTransport })).toBe(JSON.stringify({ mcpServers: {} }));
    expect(result.status, JSON.stringify(JSON.parse(result.stdout))).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("success");
    expect(calls).toHaveLength(2);
    expect(calls[0].argv).toContain("--model");
    expect(calls[0].argv[calls[0].argv.indexOf("--model") + 1]).toBe("haiku");
    expect(calls[1].argv[calls[1].argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(calls[1].stdin).toContain("haiku accepted artifact");
    for (const call of calls) {
      expect(call.argv).toContain("--max-turns");
      expect(call.argv[call.argv.indexOf("--max-turns") + 1]).toBe("3");
      expect(call.argv).toContain("--max-budget-usd");
      expect(call.argv[call.argv.indexOf("--max-budget-usd") + 1]).toBe("0.05");
      expect(call.argv).toContain("--tools");
      expect(call.argv[call.argv.indexOf("--tools") + 1]).toBe("");
      expect(call.argv).toContain("--safe-mode");
      expect(call.argv).toContain("--mcp-config");
      expect(call.argv[call.argv.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }));
      expect(call.argv).toContain("--strict-mcp-config");
    }
    const captured = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", JSON.parse(result.stdout).runId, "context", "definitions.json"), "utf8"));
    expect(captured.providerProfiles.fixture).toMatchObject({ kind: "claude", model: "haiku", maxTurns: 3, maxBudgetUsd: 0.05, tools: "", safeMode: true });
    expect(JSON.stringify(captured.providerProfiles)).not.toContain("fixture-secret-must-not-be-captured");
    const runId = JSON.parse(result.stdout).runId;
    const finalStatus = await getRunStatus(project, runId);
    expect(JSON.parse(result.stdout).result.artifacts[0].data.message).toBe("sonnet final result");
    expect(finalStatus.metrics?.calls).toHaveLength(2);
    expect(finalStatus.metrics?.calls[0]?.usage).toEqual({ inputTokens: 20, outputTokens: 8, cacheReadTokens: 3, costUsd: 0.001 });
    expect(finalStatus.metrics?.calls[1]?.usage).toBeNull();
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-005 successful Claude transport preserves a Nodulus error and stops successors", async () => {
  const { project, logPath } = await createProviderScenario("claude", "error-response");
  configureTwoNodes(project);
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Stop after first node", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).result.error.code).toBe("FIXTURE_STOP");
    expect(readProviderCalls(logPath)).toHaveLength(1);
    const runId = JSON.parse(result.stdout).runId;
    expect(existsSync(path.join(project, ".nodulus", "runs", runId, "nodes", "second", "attempt-001"))).toBe(false);
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-005 Claude clarification resumes in a new compiled CLI process with isolated attempts", async () => {
  const { project, logPath } = await createProviderScenario("claude", "pause-then-success", { maxTurns: 3, maxBudgetUsd: 0.05, tools: "", safeMode: true });
  try {
    const initial = runCompiledCli(project, ["run", "--project", project, "--request", "Ask then resume", "--json"]);
    expect(initial.status).toBe(2);
    const paused = JSON.parse(initial.stdout);
    const answers = path.join(project, "answers.json");
    writeFileSync(answers, JSON.stringify({ confirmed: true }), "utf8");
    const resumed = runCompiledCli(project, ["resume", paused.runId, "--project", project, "--request-id", paused.result.request.id, "--answers-file", answers, "--json"]);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout).status).toBe("success");
    expect(readProviderCalls(logPath)).toHaveLength(2);
    const providerRoot = path.join(project, ".nodulus", "runs", paused.runId, "provider", "example");
    expect(readFileSync(path.join(providerRoot, "attempt-001", "transport.json"), "utf8")).toContain("structured_output");
    expect(readFileSync(path.join(providerRoot, "attempt-002", "transport.json"), "utf8")).toContain("structured_output");
    expect(readFileSync(path.join(project, ".nodulus", "runs", paused.runId, "nodes", "example", "attempt-002", "prompt.md"), "utf8")).toContain("Answers to clarification questions");
    const captured = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", paused.runId, "context", "definitions.json"), "utf8"));
    expect(captured.providerProfiles.fixture).toMatchObject({ kind: "claude", maxTurns: 3, maxBudgetUsd: 0.05, tools: "", safeMode: true });
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([
  ["provider error", "auth-failure", /auth|login/i],
  ["signed out with successful auth command", "signed-out", /auth|logged in|login/i],
  ["unrecognized version", "unsupported-version", /version.*unrecognized/i],
  ["version below supported floor", "old-version", /version.*unsupported|minimum.*2\.1\.294/i],
] as const)("PROV-005 Claude readiness stops before inference for %s", async (_label, mode, expectedCode) => {
  const { project, logPath } = await createProviderScenario("claude", mode);
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Do not infer", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).result.error.message).toMatch(expectedCode);
    expect(readProviderCalls(logPath)).toHaveLength(0);
  } finally {
    cleanupProviderProject(project);
  }
});

test.each(["disabled", "missing-executable"] as const)("PROV-005 Claude %s profile stops before any provider probe", async (mode) => {
  const { project, probePath, logPath } = await createProviderScenario("claude", "success");
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (mode === "disabled") settings.providerProfiles.fixture.enabled = false;
  else settings.providerProfiles.fixture.executable = path.join(project, "missing claude executable.cmd");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Do not probe", "--json"]);
    expect(result.status).toBe(1);
    expect(readProviderCalls(logPath)).toHaveLength(0);
    expect(existsSync(probePath)).toBe(false);
    const envelope = JSON.parse(result.stdout);
    const message = mode === "disabled" ? envelope.result.message : envelope.result.error.message;
    expect(message).toMatch(mode === "disabled" ? /disabled/i : /could not be started|executable/i);
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([["haiku"], ["sonnet"], ["claude-sonnet-4-5"], [undefined]] as const)("PROV-005 forwards optional Claude model selection %s", async (model) => {
  const { project, logPath } = await createProviderScenario("claude", "success", { model });
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Check model option", "--json"]);
    expect(result.status).toBe(0);
    const [call] = readProviderCalls(logPath);
    expect(call.argv.includes("--model")).toBe(model !== undefined);
    if (model !== undefined) expect(call.argv[call.argv.indexOf("--model") + 1]).toBe(model);
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([["invalid turns", { maxTurns: 0 }], ["negative budget", { maxBudgetUsd: -0.01 }], ["non-finite budget", { maxBudgetUsd: Number.NaN }]] as const)("PROV-005 rejects Claude %s before inference", async (_label, options) => {
  const { project, logPath } = await createProviderScenario("claude", "success", options);
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Reject unsafe options", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.stringify(JSON.parse(result.stdout).result)).toMatch(/maxTurns|maxBudgetUsd|budget|turn/i);
    expect(readProviderCalls(logPath)).toHaveLength(0);
  } finally {
    cleanupProviderProject(project);
  }
});

test.each(["invalid-response", "invalid-outcome", "invalid-artifact", "missing-structured-output", "api-failure", "budget-failure", "provider-rejected-model"] as const)("PROV-005 Claude transport case %s stops before successors without replay", async (mode) => {
  const { project, logPath } = await createProviderScenario("claude", mode);
  configureTwoNodes(project);
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Validate transport once", "--json"]);
    expect(result.status).toBe(1);
    expect(readProviderCalls(logPath)).toHaveLength(1);
    expect(JSON.parse(result.stdout).status).toBe("error");
    const runId = JSON.parse(result.stdout).runId;
    expect(existsSync(path.join(project, ".nodulus", "runs", runId, "nodes", "second", "attempt-001"))).toBe(false);
    expect(existsSync(path.join(project, ".nodulus", "runs", runId, "nodes", "second", "artifacts", "example.json"))).toBe(false);
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-005 timeout kills the Claude fixture and its spawned descendant", async () => {
  const { project, logPath } = await createProviderScenario("claude", "timeout", { timeoutMs: 750 });
  const childPidPath = path.join(project, ".nodulus", "fixtures", "timeout-child.pid");
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Bound the provider", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).result.error.message).toMatch(/timeout|exceeded/i);
    const [call] = readProviderCalls(logPath);
    expect(call).toBeDefined();
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(await waitForProcessExit(call.pid)).toBe(true);
    expect(await waitForProcessExit(childPid)).toBe(true);
  } finally {
    await cleanupProviderProjectEventually(project);
  }
}, 20000);

test("PROV-005 bounds Claude output overflow", async () => {
  const { project, logPath } = await createProviderScenario("claude", "overflow", { timeoutMs: 5000 });
  try {
    const result = runCompiledCli(project, ["run", "--project", project, "--request", "Bound the provider", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).result.error.message).toMatch(/output.*limit|exceeded/i);
    const [call] = readProviderCalls(logPath);
    expect(call).toBeDefined();
    expect(await waitForProcessExit(call.pid)).toBe(true);
  } finally {
    await cleanupProviderProjectEventually(project);
  }
});

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true;
      if (code !== "EPERM") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function cleanupProviderProjectEventually(project: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { cleanupProviderProject(project); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function configureTwoNodes(project: string): void {
  const workflowPath = path.join(project, ".nodulus", "workflows", "example.json");
  const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
  workflow.nodes = ["example", "second"];
  writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  const node = JSON.parse(readFileSync(path.join(project, ".nodulus", "nodes", "example.json"), "utf8"));
  node.id = "second";
  node.inputs = { previous: { from: "example.example", contract: "example.v1" } };
  writeFileSync(path.join(project, ".nodulus", "nodes", "second.json"), `${JSON.stringify(node, null, 2)}\n`, "utf8");
  writeFileSync(path.join(project, ".nodulus", "instructions", "second.md"), "Produce the second artifact.\n", "utf8");
}

function runCompiledCli(project: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.resolve("dist/bin.js"), ...args], { cwd: project, encoding: "utf8", timeout: 15000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

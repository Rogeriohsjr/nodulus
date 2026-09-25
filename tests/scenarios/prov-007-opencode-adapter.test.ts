import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { cleanupProviderProject, createProviderScenario, readProviderCalls, runDefaultProviderCli } from "../support/provider-adapter-scenarios.js";

test("PROV-007 selects nested text parts from the final stopped OpenCode assistant message", async () => {
  const { project, logPath, probePath, invocationPath } = await createProviderScenario("opencode");
  try {
    const request = "Return the exact Nodulus result; do not interpolate $HOME, `unsafe`, or ${literal}.";
    const result = await runDefaultProviderCli(project, request);

    const probes = readFileSync(probePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(probes.map((probe) => probe.argv)).toEqual(expect.arrayContaining([
      ["--version"],
      ["models", "ollama"],
    ]));
    expect(probes.map((probe) => probe.argv)).not.toContainEqual(["models", "--format", "json"]);
    expect(result.code).toBe(0);
    expect(result.envelope).toMatchObject({ status: "success", result: { artifacts: [{ name: "example", data: { message: "fixture result" } }] } });
    const [call] = readProviderCalls(logPath);
    expect(call.kind).toBe("opencode");
    expect(call.argv).toEqual(["run", "--format", "json", "--thinking", "--model", "ollama/qwen3.5:9b", "--agent", "build", "--dir", project]);
    const runRoot = path.join(project, ".nodulus", "runs", result.envelope.runId);
    const originalPrompt = readFileSync(path.join(runRoot, "nodes", "example", "attempt-001", "prompt.md"), "utf8");
    const transportSuffix = "OpenCode transport instruction: Return exactly one complete Nodulus system outcome JSON object as your final assistant response. Do not return an artifact data value alone or write the outcome to a file. A success outcome has this shape: {\"status\":\"success\",\"artifacts\":[{\"name\":\"node-supplied name\",\"contract\":\"node-supplied contract\",\"data\":{}}]}. The node prompt supplies the actual expected names and contracts.";
    expect(call.stdin).toBe(`${originalPrompt}\n\n${transportSuffix}`);
    expect(call.stdin).toContain(request);
    expect(call.stdin.endsWith(transportSuffix)).toBe(true);
    expect(call.argv.join(" ")).not.toContain(request);
    const invocations = readFileSync(invocationPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(invocations.map((invocation) => [invocation.type, invocation.argv])).toEqual([
      ["probe", ["--version"]],
      ["probe", ["models", "ollama"]],
      ["run", call.argv],
    ]);
    const transport = JSON.parse(readFileSync(path.join(runRoot, "provider", "example", "attempt-001", "transport.json"), "utf8"));
    expect(transport).toMatchObject({ provider: "opencode", exitCode: 0 });
    expect(transport.stdout).toContain('"type":"step_start"');
    expect(transport.stdout).toContain('"type":"text"');
    expect(transport.stdout).toContain('"messageID":"fixture-final-assistant"');
    expect(transport.stdout).toContain('"type":"reasoning"');
    expect(transport.stdout).toContain('\\"message\\":\\"final reasoning distractor\\"');
    expect(transport.stdout).toContain('\\"message\\":\\"fixture result\\"');
    expect(transport.stdout).toContain('"messageID":"fixture-earlier-tool"');
    expect(transport.stdout).toContain('"reason":"tool-calls"');
    expect(transport.stdout).toContain('\\"message\\":\\"earlier text distractor\\"');
    expect(transport.stderr).toBe("");
    const definitions = JSON.parse(readFileSync(path.join(runRoot, "context", "definitions.json"), "utf8"));
    expect(definitions.providerProfiles.fixture).toEqual({
      kind: "opencode",
      enabled: true,
      executable: expect.any(String),
      model: "ollama/qwen3.5:9b",
      timeoutMs: 5000,
      capabilities: [],
    });
    expect(JSON.stringify(definitions.providerProfiles.fixture)).not.toContain("fixture-secret-must-not-be-captured");
    expect(definitions.providerProfiles.fixture).not.toHaveProperty("credentials");
    expect(definitions.providerProfiles.fixture).not.toHaveProperty("arguments");
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-007 falls back to reasoning parts only for the final stopped OpenCode assistant message", async () => {
  const { project, logPath } = await createProviderScenario("opencode", "reasoning-only");
  try {
    const result = await runDefaultProviderCli(project, "Use the final stopped reasoning outcome only.");

    expect(result.code).toBe(0);
    expect(result.envelope).toMatchObject({ status: "success", result: { artifacts: [{ name: "example", data: { message: "fixture result" } }] } });
    expect(readProviderCalls(logPath)).toHaveLength(1);
    const transport = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", result.envelope.runId, "provider", "example", "attempt-001", "transport.json"), "utf8"));
    expect(transport.stdout).toContain('"type":"reasoning"');
    expect(transport.stdout).toContain('"reason":"stop"');
    expect(transport.stdout).not.toContain('"type":"text","text"');
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-007 repairs malformed final JSON through the captured OpenCode session without replaying build", async () => {
  const { project, logPath } = await createProviderScenario("opencode", "repair-malformed-response");
  try {
    const result = await runDefaultProviderCli(project, "Repair only the final response after the writing action completed.");
    expect(result.code).toBe(0);
    expect(result.envelope).toMatchObject({ status: "success", result: { artifacts: [{ name: "example", data: { message: "fixture repaired result" } }] } });

    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(2);
    expect(calls[0].argv).toEqual(["run", "--format", "json", "--thinking", "--model", "ollama/qwen3.5:9b", "--agent", "build", "--dir", project]);
    expect(calls[1].argv).toEqual(["run", "--format", "json", "--thinking", "--model", "ollama/qwen3.5:9b", "--agent", "nodulus-response", "--session", "fixture-response-only-session", "--dir", project]);
    expect(calls[1].stdin).toMatch(/INVALID_NODE_RESPONSE/);
    expect(calls[1].stdin).toMatch(/fixture result/);
    expect(calls[1].stdin).toContain('{"status":"success","artifacts":[{"name":"node-supplied name","contract":"node-supplied contract","data":{}}]}');
    expect(calls[1].stdin).toMatch(/Do not write the outcome to a file/i);
    expect(calls.filter((call) => call.argv.includes("build"))).toHaveLength(1);

    const providerAttempt = path.join(project, ".nodulus", "runs", result.envelope.runId, "provider", "example", "attempt-001");
    const initialTransport = JSON.parse(readFileSync(path.join(providerAttempt, "transport.json"), "utf8"));
    const repairTransport = JSON.parse(readFileSync(path.join(providerAttempt, "repair-001", "transport.json"), "utf8"));
    expect(initialTransport.stdout).toContain('"sessionID":"fixture-response-only-session"');
    expect(repairTransport.stdout).toContain('"messageID":"fixture-repair-earlier-tool"');
    expect(repairTransport.stdout).toContain('\\"message\\":\\"earlier repair text distractor\\"');
    expect(repairTransport.stdout).toContain('"messageID":"fixture-repair-final-1"');
    expect(repairTransport.stdout).toContain('"reason":"stop"');
    expect(repairTransport.stdout).toContain('\\"code\\":\\"REPAIR_REASONING\\"');
    expect(repairTransport.stdout).not.toContain('"type":"tool"');
    expect(repairTransport.stderr).toBe("");
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-007 retains separate response-only transports across two repairs without replaying build", async () => {
  const { project, logPath } = await createProviderScenario("opencode", "repair-multiple");
  try {
    const result = await runDefaultProviderCli(project, "Repair the malformed response twice without repeating the completed writing action.");

    expect(result.code).toBe(0);
    expect(result.envelope).toMatchObject({ status: "success", result: { artifacts: [{ name: "example", data: { message: "fixture second repair result" } }] } });
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.argv.includes("build"))).toHaveLength(1);
    expect(calls.filter((call) => call.argv.includes("nodulus-response"))).toHaveLength(2);
    expect(calls.slice(1).map((call) => call.argv)).toEqual([
      ["run", "--format", "json", "--thinking", "--model", "ollama/qwen3.5:9b", "--agent", "nodulus-response", "--session", "fixture-response-only-session", "--dir", project],
      ["run", "--format", "json", "--thinking", "--model", "ollama/qwen3.5:9b", "--agent", "nodulus-response", "--session", "fixture-response-only-session", "--dir", project],
    ]);
    const providerAttempt = path.join(project, ".nodulus", "runs", result.envelope.runId, "provider", "example", "attempt-001");
    const initialTransport = JSON.parse(readFileSync(path.join(providerAttempt, "transport.json"), "utf8"));
    const firstRepair = JSON.parse(readFileSync(path.join(providerAttempt, "repair-001", "transport.json"), "utf8"));
    const secondRepair = JSON.parse(readFileSync(path.join(providerAttempt, "repair-002", "transport.json"), "utf8"));
    expect(initialTransport.stdout).toContain('"messageID":"fixture-final-assistant"');
    expect(firstRepair.stdout).toContain('"messageID":"fixture-repair-final-1"');
    expect(secondRepair.stdout).toContain('"messageID":"fixture-repair-final-2"');
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-007 surfaces a response-only OpenCode repair transport failure without a new build", async () => {
  const { project, logPath } = await createProviderScenario("opencode", "repair-process-failure");
  try {
    const result = await runDefaultProviderCli(project, "Do not replay the completed writing action.");
    expect(result.code).toBe(1);
    expect(result.envelope.result.error.code).toBe("RESPONSE_REPAIR_FAILED");
    expect(result.envelope.result.error.message).toMatch(/response-only repair failed/i);
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => call.argv.includes("build"))).toHaveLength(1);
    expect(calls[1].argv).toContain("nodulus-response");
    expect(calls[1].argv).toContain("--session");
    const providerAttempt = path.join(project, ".nodulus", "runs", result.envelope.runId, "provider", "example", "attempt-001");
    const originalTransport = JSON.parse(readFileSync(path.join(providerAttempt, "transport.json"), "utf8"));
    const repairTransport = JSON.parse(readFileSync(path.join(providerAttempt, "repair-001", "transport.json"), "utf8"));
    expect(originalTransport.stdout).toContain('"messageID":"fixture-final-assistant"');
    expect(originalTransport.stdout).not.toContain("fixture response-only repair stdout");
    expect(repairTransport).toMatchObject({ exitCode: 24, stdout: "fixture response-only repair stdout", stderr: "fixture response-only repair stderr" });
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-007 snapshots only safe OpenCode profile fields and rejects arbitrary argument arrays before probes", async () => {
  const { project, logPath, probePath } = await createProviderScenario("opencode");
  try {
    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.providerProfiles.fixture.arguments = ["--unsafe-custom-flag", "value"];
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const result = await runDefaultProviderCli(project, "Reject unapproved OpenCode arguments");
    expect(result.code).toBe(1);
    expect(result.envelope).toMatchObject({ status: "error", runId: null, result: { code: "CONFIGURATION_INVALID" } });
    expect(JSON.stringify(result.envelope.result)).toMatch(/opencode.*arguments|arguments.*opencode/i);
    expect(readProviderCalls(logPath)).toEqual([]);
    expect(existsSync(probePath)).toBe(false);
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([
  ["unsupported-version", "PROVIDER_VERSION_UNSUPPORTED"],
  ["unrecognized-version", "PROVIDER_VERSION_UNRECOGNIZED"],
  ["model-unavailable", "PROVIDER_MODEL_UNAVAILABLE"],
  ["timeout", "PROVIDER_TIMEOUT"],
  ["output-limit", "PROVIDER_OUTPUT_LIMIT"],
  ["nonzero-exit", "PROVIDER_PROCESS_FAILED"],
  ["malformed-event", "PROVIDER_TRANSPORT_INVALID"],
  ["missing-text", "PROVIDER_RESPONSE_MISSING"],
] as const)("PROV-008 maps OpenCode %s to an actionable error without response repair", async (mode, expectedCode) => {
  const { project, logPath, probePath } = await createProviderScenario("opencode", mode);
  try {
    if (mode === "timeout") {
      const settingsPath = path.join(project, ".nodulus", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      settings.providerProfiles.fixture.timeoutMs = 10;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    }
    const result = await runDefaultProviderCli(project, `Exercise OpenCode ${mode}`);
    expect(result.code).toBe(1);
    expect(result.envelope.result.error.code).toBe(expectedCode);
    expect(readProviderCalls(logPath)).toHaveLength(["unsupported-version", "unrecognized-version", "model-unavailable"].includes(mode) ? 0 : 1);
    if (mode === "unsupported-version" || mode === "unrecognized-version") {
      const probes = readFileSync(probePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(probes.map((probe) => probe.argv)).toEqual([["--version"]]);
    }
    if (mode === "model-unavailable") {
      const probes = readFileSync(probePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(probes.map((probe) => probe.argv)).toEqual([["--version"], ["models", "ollama"]]);
      expect(probes.map((probe) => probe.argv)).not.toContainEqual(["models", "--format", "json"]);
    }
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-008 does not replay a writing OpenCode action when valid NDJSON contains an invalid Nodulus outcome", async () => {
  const { project, logPath } = await createProviderScenario("opencode", "invalid-outcome");
  try {
    const result = await runDefaultProviderCli(project, "Return a malformed Nodulus outcome after writing.");
    expect(result.code).toBe(1);
    expect(result.envelope.result.error.code).toBe("RESPONSE_REPAIR_UNAVAILABLE");
    expect(readProviderCalls(logPath)).toHaveLength(1);
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([
  ["timeout", "fixture OpenCode timeout stderr", "fixture OpenCode timeout stdout"],
  ["output-limit", "", expect.stringMatching(/^x+$/)],
  ["nonzero-exit", "fixture OpenCode failure", ""],
  ["malformed-event", "", "{not JSON}\n"],
  ["missing-text", "", expect.stringContaining('"type":"step_finish"')],
] as const)("PROV-008 saves %s raw transport evidence and does not start a successor", async (mode, expectedStderr, expectedStdout) => {
  const { project, logPath } = await createProviderScenario("opencode", mode);
  try {
    if (mode === "timeout") {
      const settingsPath = path.join(project, ".nodulus", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      settings.providerProfiles.fixture.timeoutMs = 10;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    }
    const workflowPath = path.join(project, ".nodulus", "workflows", "example.json");
    const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
    workflow.nodes.push("successor");
    writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
    const exampleNode = JSON.parse(readFileSync(path.join(project, ".nodulus", "nodes", "example.json"), "utf8"));
    writeFileSync(path.join(project, ".nodulus", "nodes", "successor.json"), `${JSON.stringify({ ...exampleNode, id: "successor" }, null, 2)}\n`, "utf8");

    const result = await runDefaultProviderCli(project, `Preserve ${mode} evidence and stop.`);
    expect(result.code).toBe(1);
    expect(readProviderCalls(logPath)).toHaveLength(1);
    const transport = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", result.envelope.runId, "provider", "example", "attempt-001", "transport.json"), "utf8"));
    expect(transport.provider).toBe("opencode");
    if (mode === "timeout") {
      expect(transport.stderr).toContain("fixture OpenCode timeout stderr");
      expect(transport.stdout).toContain("fixture OpenCode timeout stdout");
    } else {
      expect(transport.stderr).toBe(expectedStderr);
      expect(transport.stdout).toEqual(expectedStdout);
    }
  } finally {
    cleanupProviderProject(project);
  }
});

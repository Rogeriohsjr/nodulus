import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { cleanupProviderProject, createProviderScenario, readProviderCalls, runDefaultProviderCli, type FixtureProviderKind } from "../support/provider-adapter-scenarios.js";
import { resumeDefaultProviderCli } from "../support/provider-adapter-scenarios.js";

const providers: FixtureProviderKind[] = ["codex", "cursor"];

test.each(providers)("PROV-001 translates Nodulus execution through the default %s adapter", async (kind) => {
  const { project, logPath } = await createProviderScenario(kind);
  try {
    const result = await runDefaultProviderCli(project, `Translate this ${kind} fixture response.`);
    expect(result.code).toBe(0);
    expect(result.envelope).toMatchObject({ schemaVersion: 1, status: "success", result: { artifacts: [{ name: "example", contract: "example.v1", data: { message: "fixture result" } }] } });

    const [call] = readProviderCalls(logPath);
    expect(call).toBeDefined();
    expect(call.kind).toBe(kind);
    expect(realpathSync(call.cwd)).toBe(realpathSync(project));
    if (kind === "codex") {
      expect(call.argv).toContain("exec");
      expect(call.argv).toContain("--json");
      expect(call.argv).toContain("--ephemeral");
      expect(call.argv.at(-1)).toBe("-");
      expect(realpathSync(call.argv[call.argv.indexOf("--cd") + 1])).toBe(realpathSync(project));
      expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("fixture-model");
      expect(call.stdin).toContain(`Translate this ${kind} fixture response.`);
      const outputPath = call.argv[call.argv.indexOf("--output-last-message") + 1];
      const schemaPath = call.argv[call.argv.indexOf("--output-schema") + 1];
      const lastMessage = JSON.parse(readFileSync(outputPath, "utf8"));
      expect(JSON.parse(lastMessage.response)).toMatchObject({ status: "success", artifacts: [{ data: { message: "fixture result" } }] });
      expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toBeDefined();
    } else {
      expect(call.argv).toContain("-p");
      expect(call.argv).toContain("--output-format");
      expect(call.argv[call.argv.indexOf("--output-format") + 1]).toBe("json");
      expect(realpathSync(call.argv[call.argv.indexOf("--workspace") + 1])).toBe(realpathSync(project));
      expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("fixture-model");
      expect(call.argv[call.argv.indexOf("-p") + 1].length).toBeLessThan(512);
      expect(call.promptFile).toBeDefined();
      expect(path.isAbsolute(call.promptFile)).toBe(true);
      expect(call.promptContents).toContain(`Translate this ${kind} fixture response.`);
    }

    const definitions = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", result.envelope.runId, "context", "definitions.json"), "utf8"));
    expect(definitions.providerProfiles.fixture).toMatchObject({ kind, enabled: true, model: "fixture-model", timeoutMs: 5000, capabilities: [] });
    expect(JSON.stringify(definitions.providerProfiles.fixture)).not.toContain("fixture-secret-must-not-be-captured");
  } finally {
    cleanupProviderProject(project);
  }
});

test.each(providers)("PROV-001 keeps each %s resume invocation transport in its own node attempt", async (kind) => {
  const { project, logPath } = await createProviderScenario(kind, "pause-then-success");
  try {
    const paused = await runDefaultProviderCli(project, "Ask before producing the artifact");
    expect(paused.code).toBe(2);
    const pendingId = paused.envelope.result.request.id;
    const answersPath = path.join(project, "answers.json");
    writeFileSync(answersPath, JSON.stringify({ confirmed: true }), "utf8");
    const resumed = await resumeDefaultProviderCli(project, paused.envelope.runId, pendingId, answersPath);
    expect(resumed.code).toBe(0);

    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(2);
    const providerRoot = path.join(project, ".nodulus", "runs", paused.envelope.runId, "provider", "example");
    const transport1 = path.join(providerRoot, "attempt-001", "transport.json");
    const transport2 = path.join(providerRoot, "attempt-002", "transport.json");
    const first = readFileSync(transport1, "utf8");
    const second = readFileSync(transport2, "utf8");
    const runRoot = path.join(project, ".nodulus", "runs", paused.envelope.runId);
    expect(readFileSync(path.join(runRoot, "nodes", "example", "attempt-001", "prompt.md"), "utf8")).not.toContain("Answers to clarification questions");
    expect(readFileSync(path.join(runRoot, "nodes", "example", "attempt-002", "prompt.md"), "utf8")).toContain("Answers to clarification questions");
    if (kind === "codex") {
      expect(first).toContain("turn.completed");
      expect(second).toContain("turn.completed");
      const firstMessage = JSON.parse(readFileSync(path.join(providerRoot, "attempt-001", "last-message.txt"), "utf8"));
      const secondMessage = JSON.parse(readFileSync(path.join(providerRoot, "attempt-002", "last-message.txt"), "utf8"));
      expect(JSON.parse(firstMessage.response).status).toBe("needs_input");
      expect(JSON.parse(secondMessage.response).status).toBe("success");
    } else {
      expect(first).toContain("needs_input");
      expect(second).toContain("success");
      expect(readFileSync(path.join(providerRoot, "attempt-001", "prompt.md"), "utf8")).not.toContain("Answers to clarification questions");
      expect(readFileSync(path.join(providerRoot, "attempt-002", "prompt.md"), "utf8")).toContain("Answers to clarification questions");
    }
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-003 preserves split UTF-8 characters from the Cursor JSON transport", async () => {
  const { project } = await createProviderScenario("cursor", "split-unicode-response");
  try {
    const result = await runDefaultProviderCli(project, "Return a Unicode artifact");
    expect(result.code).toBe(0);
    expect(result.envelope.result.artifacts[0].data.message).toBe("split Ω 🦊 response");
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([
  { sandbox: "read-only", reasoningEffort: "low" },
  { sandbox: "workspace-write", reasoningEffort: "high" },
])("PROV-005 translates Codex sandbox '$sandbox' and reasoning effort '$reasoningEffort' without approval bypass", async ({ sandbox, reasoningEffort }) => {
  const { project, logPath } = await createProviderScenario("codex");
  try {
    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    Object.assign(settings.providerProfiles.fixture, { sandbox, reasoningEffort });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const result = await runDefaultProviderCli(project, "Use the selected Codex profile policy");
    expect(result.code).toBe(0);
    const [call] = readProviderCalls(logPath);
    expect(call.kind).toBe("codex");
    expect(call.argv).toContain("--sandbox");
    expect(call.argv[call.argv.indexOf("--sandbox") + 1]).toBe(sandbox);
    expect(call.argv).toContain("-c");
    expect(call.argv).toContain(`model_reasoning_effort=${reasoningEffort}`);
    expect(call.argv).toContain("approval_policy=never");
    expect(call.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-005 defaults Codex sandbox to read-only and preserves captured policy on resume", async () => {
  const { project, logPath } = await createProviderScenario("codex", "pause-then-success");
  try {
    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    delete settings.providerProfiles.fixture.sandbox;
    settings.providerProfiles.fixture.reasoningEffort = "low";
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const paused = await runDefaultProviderCli(project, "Pause and retain this provider policy");
    expect(paused.code).toBe(2);
    const runRoot = path.join(project, ".nodulus", "runs", paused.envelope.runId);
    const definitionsPath = path.join(runRoot, "context", "definitions.json");
    const definitions = JSON.parse(readFileSync(definitionsPath, "utf8"));
    expect(definitions.providerProfiles.fixture).toMatchObject({ sandbox: "read-only", reasoningEffort: "low" });
    const firstCall = readProviderCalls(logPath)[0]!;
    expect(firstCall.argv.slice(firstCall.argv.indexOf("--sandbox"), firstCall.argv.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
    expect(firstCall.argv).toContain("model_reasoning_effort=low");

    const changedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    Object.assign(changedSettings.providerProfiles.fixture, { sandbox: "workspace-write", reasoningEffort: "high" });
    writeFileSync(settingsPath, `${JSON.stringify(changedSettings, null, 2)}\n`, "utf8");
    const answersPath = path.join(project, "answers.json");
    writeFileSync(answersPath, JSON.stringify({ confirmed: true }), "utf8");
    const resumed = await resumeDefaultProviderCli(project, paused.envelope.runId, paused.envelope.result.request.id, answersPath);
    expect(resumed.code).toBe(0);
    expect(readFileSync(definitionsPath, "utf8")).toContain('"sandbox": "read-only"');
    expect(readFileSync(definitionsPath, "utf8")).toContain('"reasoningEffort": "low"');
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.argv.slice(calls[1]!.argv.indexOf("--sandbox"), calls[1]!.argv.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
    expect(calls[1]!.argv).toContain("model_reasoning_effort=low");
    expect(calls[1]!.argv).toContain("approval_policy=never");
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([
  { field: "sandbox", value: "danger-full-access" },
  { field: "reasoningEffort", value: "arbitrary-untrusted-value" },
])("PROV-005 rejects invalid Codex $field before provider probes or inference", async ({ field, value }) => {
  const { project, logPath, probePath } = await createProviderScenario("codex");
  try {
    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.providerProfiles.fixture[field] = value;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const result = await runDefaultProviderCli(project, "Invalid policy must not reach Codex");
    expect(result.code).toBe(1);
    expect(result.envelope).toMatchObject({ status: "error", runId: null, result: { code: "CONFIGURATION_INVALID" } });
    expect(readProviderCalls(logPath)).toEqual([]);
    expect(existsSync(probePath)).toBe(false);
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-006 uses a strict Codex response-string schema and unwraps the exact Nodulus success outcome", async () => {
  const { project, logPath } = await createProviderScenario("codex", "strict-envelope-success");
  try {
    const result = await runDefaultProviderCli(project, "Return the requested artifact through Codex's strict transport envelope");
    const [call] = readProviderCalls(logPath);
    expect(call.schemaValid).toBe(true);
    expect(call.stdin).toContain("Codex transport envelope: return exactly one JSON object with a string property named response. Its string value must be the exact Nodulus outcome JSON text.");
    expect(result.code).toBe(0);
    expect(result.envelope).toMatchObject({ status: "success", result: { artifacts: [{ data: { message: "fixture result" } }] } });

    const schemaPath = call.argv[call.argv.indexOf("--output-schema") + 1];
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toMatchObject({
      type: "object",
      properties: { response: { type: "string" } },
      required: ["response"],
      additionalProperties: false,
    });
    const lastMessagePath = call.argv[call.argv.indexOf("--output-last-message") + 1];
    const providerEnvelope = JSON.parse(readFileSync(lastMessagePath, "utf8"));
    expect(JSON.parse(providerEnvelope.response)).toMatchObject({ status: "success", artifacts: [{ name: "example" }] });
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-006 resumes after a strict Codex response-string needs_input envelope", async () => {
  const { project, logPath } = await createProviderScenario("codex", "strict-envelope-pause-then-success");
  try {
    const paused = await runDefaultProviderCli(project, "Pause through the strict transport envelope");
    expect(paused.code).toBe(2);
    const requestId = paused.envelope.result.request.id;
    const answersPath = path.join(project, "answers.json");
    writeFileSync(answersPath, JSON.stringify({ confirmed: true }), "utf8");
    const resumed = await resumeDefaultProviderCli(project, paused.envelope.runId, requestId, answersPath);
    expect(resumed.code).toBe(0);
    expect(resumed.envelope.status).toBe("success");
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.schemaValid)).toBe(true);
    const firstMessage = JSON.parse(readFileSync(calls[0]!.argv[calls[0]!.argv.indexOf("--output-last-message") + 1], "utf8"));
    const secondMessage = JSON.parse(readFileSync(calls[1]!.argv[calls[1]!.argv.indexOf("--output-last-message") + 1], "utf8"));
    expect(JSON.parse(firstMessage.response).status).toBe("needs_input");
    expect(JSON.parse(secondMessage.response).status).toBe("success");
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-006 preserves error outcomes inside a strict Codex response-string envelope", async () => {
  const { project, logPath } = await createProviderScenario("codex", "strict-envelope-error");
  try {
    const result = await runDefaultProviderCli(project, "Return a fixture error outcome");
    expect(result.code).toBe(1);
    expect(result.envelope.result.error.code).toBe("FIXTURE_ERROR");
    expect(readProviderCalls(logPath)[0]!.schemaValid).toBe(true);
  } finally {
    cleanupProviderProject(project);
  }
});

test.each([
  "strict-envelope-invalid",
  "strict-envelope-malformed",
])("PROV-006 rejects $mode Codex transport responses", async (mode) => {
  const { project, logPath } = await createProviderScenario("codex", mode);
  try {
    const result = await runDefaultProviderCli(project, "Reject a malformed transport response");
    expect(result.code).toBe(1);
    if (mode === "strict-envelope-invalid") {
      expect(result.envelope.result.error.code).toBe("PROVIDER_FAILURE");
      expect(result.envelope.result.error.message).toContain("response envelope must contain exactly one string property named 'response'");
    } else {
      expect(result.envelope.result.error.code).toBe("RESPONSE_REPAIR_UNAVAILABLE");
      const runRoot = path.join(project, ".nodulus", "runs", result.envelope.runId);
      expect(readFileSync(path.join(runRoot, "nodes", "example", "attempt-001", "response.raw.txt"), "utf8")).toBe("not JSON");
      expect(JSON.parse(readFileSync(path.join(runRoot, "nodes", "example", "attempt-001", "validation.json"), "utf8")).code).toBe("INVALID_NODE_RESPONSE");
    }
    expect(readProviderCalls(logPath)).toHaveLength(1);
  } finally {
    cleanupProviderProject(project);
  }
});

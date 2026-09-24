import { readFileSync, writeFileSync } from "node:fs";
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
    expect(call.cwd).toBe(project);
    if (kind === "codex") {
      expect(call.argv).toContain("exec");
      expect(call.argv).toContain("--json");
      expect(call.argv).toContain("--ephemeral");
      expect(call.argv.at(-1)).toBe("-");
      expect(call.argv[call.argv.indexOf("--cd") + 1]).toBe(project);
      expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("fixture-model");
      expect(call.stdin).toContain(`Translate this ${kind} fixture response.`);
      const outputPath = call.argv[call.argv.indexOf("--output-last-message") + 1];
      const schemaPath = call.argv[call.argv.indexOf("--output-schema") + 1];
      expect(readFileSync(outputPath, "utf8")).toContain('"fixture result"');
      expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toBeDefined();
    } else {
      expect(call.argv).toContain("-p");
      expect(call.argv).toContain("--output-format");
      expect(call.argv[call.argv.indexOf("--output-format") + 1]).toBe("json");
      expect(call.argv[call.argv.indexOf("--workspace") + 1]).toBe(project);
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
      expect(readFileSync(path.join(providerRoot, "attempt-001", "last-message.txt"), "utf8")).toContain("needs_input");
      expect(readFileSync(path.join(providerRoot, "attempt-002", "last-message.txt"), "utf8")).toContain("success");
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

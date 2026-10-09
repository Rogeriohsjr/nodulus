import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import type { ProviderInvocation } from "../../src/core/ports/provider.js";
import { createInitializedProject } from "../support/intake-project.js";

test("PROV-005 additive smoke definitions preserve project settings and validate ping/pong locally", async () => {
  const project = createInitializedProject("prov-005-smoke-definitions");
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const exampleDefinitions = path.join(repositoryRoot, "examples", "claude-smoke", ".nodulus");
  const relativeDirectories = ["workflows", "nodes", "instructions", "contracts", "validators"];
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const originalSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  originalSettings.providerProfiles.existing = { enabled: true, executable: "preserved-tool", kind: "codex" };
  writeFileSync(settingsPath, `${JSON.stringify(originalSettings, null, 2)}\n`, "utf8");
  for (const relative of relativeDirectories) cpSync(path.join(exampleDefinitions, relative), path.join(project, ".nodulus", relative), { recursive: true });
  const settingsAfterCopy = JSON.parse(readFileSync(settingsPath, "utf8"));
  settingsAfterCopy.providerProfiles["claude-haiku"] = claudeProfile("haiku");
  settingsAfterCopy.providerProfiles["claude-sonnet"] = claudeProfile("sonnet");
  writeFileSync(settingsPath, `${JSON.stringify(settingsAfterCopy, null, 2)}\n`, "utf8");
  const invocations: ProviderInvocation[] = [];
  try {
    const installedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(installedSettings.defaultWorkflow).toBe("example");
    expect(installedSettings.providerProfiles.existing).toEqual(originalSettings.providerProfiles.existing);
    expect(installedSettings.providerProfiles["claude-haiku"]).toMatchObject({ kind: "claude", executable: "C:/fixture/claude.exe", model: "haiku", maxTurns: 3, maxBudgetUsd: 0.05, tools: "", safeMode: true });
    expect(installedSettings.providerProfiles["claude-sonnet"].model).toBe("sonnet");

    let stdout = "";
    const code = await runCli(
      ["node", "nodulus", "run", "--project", project, "--workflow", "claude-smoke", "--request", "Run ping/pong", "--json"],
      { writeOut: (text) => { stdout += text; }, writeErr: () => undefined },
      {
        cwd: project,
        provider: {
          async invoke(invocation) {
            invocations.push(invocation);
            const message = invocation.nodeId === "ping" ? "ping" : "pong";
            const name = invocation.nodeId;
            return JSON.stringify({ status: "success", artifacts: [{ name, contract: `${name}.v1`, data: { message } }] });
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout).status).toBe("success");
    expect(invocations.map((invocation) => invocation.nodeId)).toEqual(["ping", "pong"]);
    expect(invocations[1]?.inputs).toEqual({ ping: { message: "ping" } });
    expect(JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", JSON.parse(stdout).runId, "result.json"), "utf8")).status).toBe("success");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

function claudeProfile(model: string): Record<string, unknown> {
  return {
    kind: "claude",
    enabled: true,
    executable: "C:/fixture/claude.exe",
    model,
    timeoutMs: 60000,
    capabilities: [],
    maxTurns: 3,
    maxBudgetUsd: 0.05,
    tools: "",
    safeMode: true,
  };
}

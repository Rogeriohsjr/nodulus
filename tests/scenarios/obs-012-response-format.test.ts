import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { cleanupProviderProject, createProviderScenario, readProviderCalls, runDefaultProviderCli } from "../support/provider-adapter-scenarios.js";

test.each(["codex", "cursor", "opencode"] as const)("OBS-012 %s prompt explicitly requires an unfenced raw JSON outcome", async (kind) => {
  const { project, logPath } = await createProviderScenario(kind);
  try {
    const result = await runDefaultProviderCli(project, "Return the configured artifact.");
    expect(result.code).toBe(0);
    expect(result.envelope.status).toBe("success");

    const runRoot = path.join(project, ".nodulus", "runs", result.envelope.runId);
    const prompt = readFileSync(path.join(runRoot, "nodes", "example", "attempt-001", "prompt.md"), "utf8");
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(1);
    expect(prompt).toContain("Return only the raw JSON outcome.");
    expect(prompt).toContain("Do not wrap it in Markdown fences or add explanatory text.");
    expect(calls[0].stdin).toContain("Return only the raw JSON outcome.");
    expect(calls[0].stdin).toContain("Do not wrap it in Markdown fences or add explanatory text.");
  } finally {
    cleanupProviderProject(project);
  }
}, 30_000);

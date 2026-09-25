import { expect, test } from "vitest";
import { realpathSync } from "node:fs";
import { cleanupProviderProject, createProviderScenario, readProviderCalls, runDefaultProviderCli, type FixtureProviderKind } from "../support/provider-adapter-scenarios.js";

const providers: FixtureProviderKind[] = ["codex", "cursor"];

test.each(providers)("PROV-003 preserves long %s context across Unicode and shell-sensitive paths", async (kind) => {
  const { project, logPath } = await createProviderScenario(kind);
  const uniqueTail = `complete-long-context-tail-${kind}-Ω-&-%-literal`;
  const request = `${"Full UTF-8 context; shell metacharacters & % must stay literal. Ω\n".repeat(800)}${uniqueTail}`;
  try {
    expect(project).toMatch(/[&%]/);
    expect(project).toContain("ü");
    const result = await runDefaultProviderCli(project, request);
    expect(result.code).toBe(0);
    const [call] = readProviderCalls(logPath);
    expect(realpathSync(call.cwd)).toBe(realpathSync(project));
    if (kind === "codex") {
      expect(realpathSync(call.argv[call.argv.indexOf("--cd") + 1])).toBe(realpathSync(project));
      expect(call.stdin).toContain(uniqueTail);
      expect(call.stdin).toContain("Ω");
      expect(call.stdin).toContain("& % must stay literal");
    } else {
      expect(call.argv[call.argv.indexOf("-p") + 1]).toBe("--output-format");
      expect(call.stdin).toContain(uniqueTail);
      expect(call.stdin).toContain("Ω");
      expect(call.stdin).toContain("& % must stay literal");
      expect(call.promptFile).toBeUndefined();
    }
  } finally {
    cleanupProviderProject(project);
  }
});

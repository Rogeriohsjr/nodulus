import { expect, test } from "vitest";
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
    expect(call.cwd).toBe(project);
    if (kind === "codex") {
      expect(call.argv[call.argv.indexOf("--cd") + 1]).toBe(project);
      expect(call.stdin).toContain(uniqueTail);
      expect(call.stdin).toContain("Ω");
      expect(call.stdin).toContain("& % must stay literal");
    } else {
      const promptArgument = call.argv[call.argv.indexOf("-p") + 1];
      expect(promptArgument).toMatch(/^Read the complete captured prompt at /);
      expect(promptArgument.length).toBeLessThan(512);
      expect(call.promptFile).toBeDefined();
      expect(call.promptContents).toContain(uniqueTail);
      expect(call.promptContents).toContain("Ω");
      expect(call.promptContents).toContain("& % must stay literal");
    }
  } finally {
    cleanupProviderProject(project);
  }
});

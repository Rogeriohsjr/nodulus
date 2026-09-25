import { expect, test } from "vitest";
import { getRunStatus } from "../../src/application/resume-workflow.js";
import { cleanupProviderProject, createProviderScenario, readProviderCalls, runDefaultProviderCli, type FixtureProviderKind } from "../support/provider-adapter-scenarios.js";

const providers: FixtureProviderKind[] = ["codex", "cursor"];

test.each(providers)("PROV-004 reports unavailable %s usage as null", async (kind) => {
  const { project, logPath } = await createProviderScenario(kind);
  try {
    const result = await runDefaultProviderCli(project, "Usage is not inferred");
    expect(result.code).toBe(0);
    const status = await getRunStatus(project, result.envelope.runId);
    expect(status.metrics?.calls).toHaveLength(1);
    expect(status.metrics?.calls[0]).toMatchObject({ nodeId: "example", attempt: 1, usage: null });
    expect(status.metrics?.calls[0].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(status.metrics?.totals).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null });
    expect(readProviderCalls(logPath)).toHaveLength(1);
  } finally {
    cleanupProviderProject(project);
  }
});

test.each(providers)("PROV-004 invalid %s output cannot trigger an unsupported full-action repair", async (kind) => {
  const { project, logPath } = await createProviderScenario(kind, "invalid-response");
  try {
    const result = await runDefaultProviderCli(project, "No full action retry");
    expect(result.code).toBe(1);
    expect(result.envelope.status).toBe("error");
    expect(result.envelope.result.error.code).toBe("RESPONSE_REPAIR_UNAVAILABLE");
    expect(result.envelope.result.error.message).toMatch(/response.only|full provider action.*not be replayed/i);
    expect(readProviderCalls(logPath)).toHaveLength(1);
  } finally {
    cleanupProviderProject(project);
  }
});

import { expect, test } from "vitest";
import { getRunStatus, runWorkflow } from "../../src/index.js";
import type { ProviderPort, ProviderUsage } from "../../src/index.js";
import { cleanupClarificationProject } from "../support/clarification-resume.js";
import { createRecoveryProject, recoveryRequest, successfulNodeResponse } from "../support/recovery-scenarios.js";

test("OBS-011 keeps invoke-only custom providers compatible through the public API", async () => {
  const { project } = createRecoveryProject("obs-011-invoke-only");
  let invocations = 0;
  const provider: ProviderPort = {
    async invoke(invocation) {
      invocations += 1;
      return successfulNodeResponse(invocation);
    },
  };
  try {
    const completed = await runWorkflow(recoveryRequest(project), provider);
    expect(completed.status).toBe("success");
    expect(invocations).toBe(3);
    const status = await getRunStatus(project, completed.runId);
    const metrics = status.metrics;
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("Expected persisted metrics.");
    expect(metrics.calls).toHaveLength(3);
    expect(metrics.calls.every((call) => call.usage === null && call.telemetry === undefined)).toBe(true);
    expect(metrics.origins).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(metrics.estimates).toBeUndefined();
    expect(metrics.estimateCoverage).toBeUndefined();
    await getRunStatus(project, completed.runId);
    expect(invocations).toBe(3);
  } finally {
    cleanupClarificationProject(project);
  }
});

test("OBS-011 labels legacy usage hooks without inventing telemetry", async () => {
  const { project } = createRecoveryProject("obs-011-legacy-usage");
  let invocations = 0;
  const usage: ProviderUsage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, costUsd: 0 };
  const provider: ProviderPort = {
    async invoke(invocation) {
      invocations += 1;
      return successfulNodeResponse(invocation);
    },
    usageForLastCall() {
      return usage;
    },
  };
  try {
    const completed = await runWorkflow(recoveryRequest(project), provider);
    expect(completed.status).toBe("success");
    expect(invocations).toBe(3);
    const status = await getRunStatus(project, completed.runId);
    const metrics = status.metrics;
    expect(metrics).toBeDefined();
    if (!metrics) throw new Error("Expected persisted metrics.");
    expect(metrics.calls).toHaveLength(3);
    expect(metrics.calls.every((call) => call.telemetry === undefined)).toBe(true);
    expect(metrics.calls.map((call) => call.usage)).toEqual([usage, usage, usage]);
    expect(metrics.origins).toEqual(["legacy_adapter", "legacy_adapter", "legacy_adapter"]);
    expect(metrics.totals).toEqual({ inputTokens: 30, outputTokens: 6, cacheReadTokens: null, costUsd: 0 });
    expect(metrics.coverage.costUsd).toEqual({ knownCalls: 3, totalCalls: 3, knownSubtotal: 0, total: 0 });
    expect(metrics.groups.every((group) => group.provider === null && group.reportedModel === null)).toBe(true);
    expect(metrics.estimates).toBeUndefined();
    expect(metrics.estimateCoverage).toBeUndefined();
    await getRunStatus(project, completed.runId);
    expect(invocations).toBe(3);
  } finally {
    cleanupClarificationProject(project);
  }
});

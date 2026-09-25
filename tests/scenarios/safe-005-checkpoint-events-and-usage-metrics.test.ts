import { appendFileSync } from "node:fs";
import { expect, test } from "vitest";
import { getRunStatus } from "../../src/application/resume-workflow.js";
import { runWorkflow } from "../../src/application/run-workflow.js";
import type { ProviderUsage } from "../../src/core/ports/provider.js";
import { cleanupClarificationProject } from "../support/clarification-resume.js";
import { createRecoveryProject, directProvider, recoveryRequest, runFile, successfulNodeResponse } from "../support/recovery-scenarios.js";

test("SAFE-005 status keeps checkpoint authoritative and reports known, unknown, and partial event data honestly", async () => {
  const { project } = createRecoveryProject("safe-005");
  const usage: Record<string, ProviderUsage | null> = {
    analyze: { inputTokens: 12, outputTokens: 4, cacheReadTokens: null, costUsd: null },
    build: null,
    review: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 2, costUsd: 0.01 },
  };
  try {
    const provider = directProvider((invocation) => successfulNodeResponse(invocation)) as ReturnType<typeof directProvider> & { usageForLastCall(): ProviderUsage | null };
    let lastNode = "";
    provider.invoke = async (invocation) => {
      lastNode = invocation.nodeId;
      return successfulNodeResponse(invocation);
    };
    provider.usageForLastCall = () => usage[lastNode] ?? null;
    const completed = await runWorkflow(recoveryRequest(project), provider);
    expect(completed.status).toBe("success");

    const eventFile = runFile(project, completed.runId, "events.jsonl");
    appendFileSync(eventFile, '{"event":"truncated trailing entry"', "utf8");
    const status = await getRunStatus(project, completed.runId);
    expect(status.status).toBe("success");
    expect(status.checkpoint).toMatchObject({ status: "success", runId: completed.runId });
    expect(status.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "run.intake.completed" }),
      expect.objectContaining({ event: "node.succeeded", nodeId: "analyze" }),
    ]));
    expect(status.events?.some((event) => JSON.stringify(event).includes("truncated trailing entry"))).toBe(false);
    expect(status.diagnostics).toMatchObject({ incompleteTrailingEvent: true });
    expect(status.metrics?.calls.map(({ nodeId, attempt, usage }) => ({ nodeId, attempt, usage }))).toEqual([
      { nodeId: "analyze", attempt: 1, usage: usage.analyze },
      { nodeId: "build", attempt: 1, usage: null },
      { nodeId: "review", attempt: 1, usage: usage.review },
    ]);
    expect(status.metrics?.calls.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0)).toBe(true);
    expect(status.metrics?.totals).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null });
  } finally {
    cleanupClarificationProject(project);
  }
});

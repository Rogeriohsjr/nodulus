import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { cleanupClarificationProject } from "../support/clarification-resume.js";
import { createRecoveryProject, directProvider, recoveryRequest, runFile, setRepairCapability } from "../support/recovery-scenarios.js";

test("SAFE-002 allows one initial response and at most two response-only repairs", async () => {
  const { project } = createRecoveryProject("safe-002-budget");
  const calls: string[] = [];
  try {
    const result = await runWorkflow(recoveryRequest(project), directProvider(
      (invocation) => { calls.push(`invoke:${invocation.nodeId}`); return "not JSON"; },
      (invocation, prior) => {
        calls.push(`repair:${invocation.nodeId}:${prior}`);
        return "still not JSON";
      },
    ));
    expect(result.status).toBe("error");
    expect(result.result).toMatchObject({ error: { code: "REPAIR_EXHAUSTED" } });
    expect(calls).toEqual(["invoke:analyze", "repair:analyze:not JSON", "repair:analyze:still not JSON"]);
    for (const [attempt, raw] of [["001", "not JSON"], ["002", "still not JSON"], ["003", "still not JSON"]]) {
      expect(existsSync(runFile(project, result.runId, `nodes/analyze/attempt-${attempt}/response.raw.txt`))).toBe(true);
      expect(readFileSync(runFile(project, result.runId, `nodes/analyze/attempt-${attempt}/response.raw.txt`), "utf8")).toBe(raw);
      expect(JSON.parse(readFileSync(runFile(project, result.runId, `nodes/analyze/attempt-${attempt}/validation.json`), "utf8")).valid).toBe(false);
    }
    expect(existsSync(runFile(project, result.runId, "nodes/build/attempt-001/invocation.json"))).toBe(false);
  } finally {
    cleanupClarificationProject(project);
  }
});

test.each([
  { name: "enabled capability but missing repair method", enabled: true, hasRepairMethod: false },
  { name: "disabled capability despite available repair method", enabled: false, hasRepairMethod: true },
])("SAFE-002 refuses unsafe repair: $name", async ({ name, enabled, hasRepairMethod }) => {
  const { project } = createRecoveryProject(`safe-002-${name.replaceAll(/[^a-z]+/gi, "-").toLowerCase()}`);
  setRepairCapability(project, enabled);
  let invocations = 0;
  let repairs = 0;
  const provider = directProvider(
    () => { invocations += 1; return "not JSON"; },
    hasRepairMethod ? () => { repairs += 1; return "still not JSON"; } : undefined,
  );
  try {
    const result = await runWorkflow(recoveryRequest(project), provider);
    expect(result.status).toBe("error");
    expect(result.result).toMatchObject({ error: { code: "RESPONSE_REPAIR_UNAVAILABLE" } });
    expect((result.result as any).error.message).toMatch(/response.only|replay|repair/i);
    expect(invocations).toBe(1);
    expect(repairs).toBe(0);
    expect(readFileSync(runFile(project, result.runId, "nodes/analyze/attempt-001/response.raw.txt"), "utf8")).toBe("not JSON");
    expect(existsSync(runFile(project, result.runId, "nodes/build/attempt-001/invocation.json"))).toBe(false);
  } finally {
    cleanupClarificationProject(project);
  }
});

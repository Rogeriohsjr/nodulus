import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { getRunStatus, resumeWorkflow } from "../../src/application/resume-workflow.js";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { cleanupClarificationProject, createClarificationProject, createClarificationRunRequest, fixtureProvider } from "../support/clarification-resume.js";
import { runFile, spawnRecoveryResume, waitForChildClose, waitForFile } from "../support/recovery-scenarios.js";

test("SAFE-006 an interrupted active node is not replayed and earlier accepted artifacts survive", async () => {
  const { project } = createClarificationProject("safe-006-crash");
  const answers = path.join(project, "answers.json");
  const entered = path.join(project, "provider-entered.json");
  const release = path.join(project, "provider-release");
  const callLog = path.join(project, ".nodulus", "fixtures", "calls.jsonl");
  writeFileSync(answers, '{"confirmed":true}\n', "utf8");
  let child: ReturnType<typeof spawnRecoveryResume> | undefined;
  let childClosed: ReturnType<typeof waitForChildClose> | undefined;
  try {
    const initial = await runWorkflow(createClarificationRunRequest(project), fixtureProvider(project));
    expect(initial.status).toBe("needs_input");
    const pending = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", initial.runId, "pending", "request.json"), "utf8"));
    const acceptedArtifactPath = runFile(project, initial.runId, "nodes/analyze/artifacts/findings.json");
    const acceptedArtifact = readFileSync(acceptedArtifactPath, "utf8");
    const attemptRoot = runFile(project, initial.runId, "nodes/build/attempt-002");
    child = spawnRecoveryResume(project, initial.runId, pending.id, answers, entered, release, callLog);
    childClosed = waitForChildClose(child, 12_000);
    await waitForFile(entered, 4000);
    const checkpointBeforeCrash = JSON.parse(readFileSync(runFile(project, initial.runId, "run.json"), "utf8"));
    expect(checkpointBeforeCrash).toMatchObject({ status: "running", activeNode: "build", attempt: 2 });
    expect(JSON.parse(readFileSync(path.join(attemptRoot, "invocation.json"), "utf8"))).toMatchObject({ nodeId: "build", attempt: 2 });

    child.kill();
    const processEnd = await childClosed;
    expect(processEnd.code).not.toBe(0);
    expect(readFileSync(acceptedArtifactPath, "utf8")).toBe(acceptedArtifact);
    const callsBeforeRecoveryAttempt = readFileSync(callLog, "utf8");
    const status = await getRunStatus(project, initial.runId);
    expect(status.checkpoint).toMatchObject({ status: "running", activeNode: "build", completedNodes: ["analyze"] });

    let replayInvocations = 0;
    const recoveryError = await resumeWorkflow({
      projectRoot: project,
      runId: initial.runId,
      requestId: pending.id,
      answers: { confirmed: true },
    }, { async invoke() { replayInvocations += 1; return "unexpected replay"; } }).then(() => null, (error: unknown) => error as { code?: string; message?: string });
    expect(recoveryError).toMatchObject({ code: "RUN_RECOVERY_REQUIRED" });
    expect(recoveryError?.message).toMatch(/uncertain|interrupted|recovery/i);
    expect(replayInvocations).toBe(0);
    expect(readFileSync(callLog, "utf8")).toBe(callsBeforeRecoveryAttempt);
    expect(readFileSync(acceptedArtifactPath, "utf8")).toBe(acceptedArtifact);
    expect(existsSync(runFile(project, initial.runId, "nodes/review/attempt-001/invocation.json"))).toBe(false);
  } finally {
    writeFileSync(release, "continue\n", "utf8");
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (childClosed) await childClosed.catch(() => undefined);
    cleanupClarificationProject(project);
  }
});

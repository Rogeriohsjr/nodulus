import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { createClarificationProject, runFreshWorkflowDriver, readCalls } from "../support/clarification-resume.js";

test("ASK-002 resumes twice in fresh processes without replaying a completed node", () => {
  const { project, callLog } = createClarificationProject("ask-002");
  const callerInputs = path.join(project, ".nodulus", "caller-inputs.json");
  writeFileSync(callerInputs, `${JSON.stringify({ goal: { target: "release notes" } })}\n`, "utf8");
  const answers1 = path.join(project, ".nodulus", "answers-1.json");
  const answers2 = path.join(project, ".nodulus", "answers-2.json");
  const staleAnswers = path.join(project, ".nodulus", "stale-answers.json");
  const replayAnswers = path.join(project, ".nodulus", "replay-answers.json");
  writeFileSync(answers1, `${JSON.stringify({ confirmed: true })}\n`, "utf8");
  writeFileSync(answers2, `${JSON.stringify({ revision: "v1" })}\n`, "utf8");
  writeFileSync(staleAnswers, `${JSON.stringify({ confirmed: false })}\n`, "utf8");
  writeFileSync(replayAnswers, `${JSON.stringify({ revision: "overwrite" })}\n`, "utf8");
  try {
    const initialProcess = runFreshWorkflowDriver(["run", project, callerInputs], project);
    expect(initialProcess.error).toBeUndefined();
    const initial = JSON.parse(initialProcess.stdout);
    expect(initial.result.status).toBe("needs_input");
    const runId = initial.result.runId;
    const firstRequest = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "pending", "request.json"), "utf8"));

    const firstResumeProcess = runFreshWorkflowDriver(["resume", project, runId, firstRequest.id, answers1], project);
    const firstResume = JSON.parse(firstResumeProcess.stdout);
    expect(firstResume.result.status).toBe("needs_input");
    const secondRequest = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "pending", "request.json"), "utf8"));
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const beforeConsumedReplay = readFileSync(callLog, "utf8");
    const firstAnswerPath = path.join(project, ".nodulus", "runs", runId, "answers", `${firstRequest.id}.json`);
    const acceptedFirstAnswer = readFileSync(firstAnswerPath, "utf8");
    const consumedReplay = runFreshWorkflowDriver(["resume", project, runId, firstRequest.id, staleAnswers], project);
    expect(JSON.parse(consumedReplay.stdout)).toMatchObject({ ok: false, error: { code: "PENDING_REQUEST_MISMATCH" } });
    expect(readFileSync(callLog, "utf8")).toBe(beforeConsumedReplay);
    expect(readFileSync(firstAnswerPath, "utf8")).toBe(acceptedFirstAnswer);

    const secondResumeProcess = runFreshWorkflowDriver(["resume", project, runId, secondRequest.id, answers2], project);
    const secondResume = JSON.parse(secondResumeProcess.stdout);
    expect(secondResume.result.status).toBe("success");
    expect(secondResume.result.runId).toBe(runId);
    expect(existsSync(firstAnswerPath)).toBe(true);
    const secondAnswerPath = path.join(project, ".nodulus", "runs", runId, "answers", `${secondRequest.id}.json`);
    expect(existsSync(secondAnswerPath)).toBe(true);

    const beforeTerminalReplay = readFileSync(callLog, "utf8");
    const acceptedSecondAnswer = readFileSync(secondAnswerPath, "utf8");
    const terminalReplay = runFreshWorkflowDriver(["resume", project, runId, secondRequest.id, replayAnswers], project);
    expect(JSON.parse(terminalReplay.stdout)).toMatchObject({ ok: false, error: { code: "RUN_NOT_PAUSED" } });
    expect(readFileSync(callLog, "utf8")).toBe(beforeTerminalReplay);
    expect(readFileSync(secondAnswerPath, "utf8")).toBe(acceptedSecondAnswer);

    const calls = readCalls(callLog);
    expect(calls.map((call) => call.nodeId)).toEqual(["analyze", "build", "build", "build", "review"]);
    expect(calls[1].inputs).toEqual({ findings: { text: "analysis findings" } });
    expect(calls[2].inputs).toEqual(calls[1].inputs);
    expect(calls[2].answers).toEqual({ confirmed: true });
    expect(calls[3].answers).toEqual({ confirmed: true, revision: "v1" });
    expect(readFileSync(path.join(project, ".nodulus", "runs", runId, "nodes", "analyze", "attempt-001", "response.raw.txt"), "utf8")).toContain("analysis findings");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

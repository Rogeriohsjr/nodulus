import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { runCli } from "../../src/cli.js";
import { runProductionCli } from "../support/production-cli.js";
import { cleanupClarificationProject, configureSinglePauseNode, createClarificationProject, createClarificationRunRequest, fixtureProvider, readCalls, runFreshWorkflowDriver } from "../support/clarification-resume.js";

test("ASK-004 status reports a real persisted needs_input checkpoint", async () => {
  const { project } = createClarificationProject("ask-004-status");
  configureSinglePauseNode(project);
  try {
    const initial = await runWorkflow(createClarificationRunRequest(project), fixtureProvider(project));
    expect(initial.status).toBe("needs_input");
    const checkpoint = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", initial.runId, "run.json"), "utf8"));
    expect(checkpoint.status).toBe("needs_input");

    const status = runProductionCli(["status", initial.runId, "--project", project, "--json"], { cwd: project });
    expect(status.status).toBe(0);
    const envelope = JSON.parse(status.stdout);
    expect(envelope).toMatchObject({ schemaVersion: 1, status: "success", runId: initial.runId, result: { status: "needs_input" } });
    expect(envelope.result.pendingRequest.id).toBe(JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", initial.runId, "pending", "request.json"), "utf8")).id);

    writeFileSync(path.join(project, "answers.json"), '{"confirmed":true}\n', "utf8");
    let resumeOutput = "";
    const resumeStatus = await runCli([
      "node", "nodulus", "resume", initial.runId, "--request-id", envelope.result.pendingRequest.id,
      "--answers-file", "answers.json", "--project", project, "--json",
    ], { writeOut: (text) => { resumeOutput += text; }, writeErr: () => {} }, { provider: fixtureProvider(project), cwd: project });
    expect(resumeStatus, resumeOutput).toBe(2);
    expect(JSON.parse(resumeOutput)).toMatchObject({ schemaVersion: 1, status: "needs_input", runId: initial.runId });
  } finally {
    cleanupClarificationProject(project);
  }
});

test("ASK-004 production resume command continues the same run", async () => {
  const { project } = createClarificationProject("ask-004-resume");
  configureSinglePauseNode(project);
  try {
    const initial = await runWorkflow(createClarificationRunRequest(project), fixtureProvider(project));
    expect(initial.status).toBe("needs_input");
    const pending = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", initial.runId, "pending", "request.json"), "utf8"));
    writeFileSync(path.join(project, "answers.json"), '{"confirmed":true}\n', "utf8");
    let stdout = "";
    const status = await runCli([
      "node", "nodulus", "resume", initial.runId, "--request-id", pending.id,
      "--answers-file", "answers.json", "--project", project, "--json",
    ], { writeOut: (text) => { stdout += text; }, writeErr: () => {} }, { provider: fixtureProvider(project), cwd: project });
    expect(status, stdout).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, status: "needs_input", runId: initial.runId });
  } finally {
    cleanupClarificationProject(project);
  }
});

test("ASK-004 rejects consumed and terminal request replays without changing accepted answers", () => {
  const { project, callLog } = createClarificationProject("ask-004-replay");
  const callerInputs = path.join(project, ".nodulus", "caller-inputs.json");
  const firstAnswers = path.join(project, ".nodulus", "first-answers.json");
  const secondAnswers = path.join(project, ".nodulus", "second-answers.json");
  const replayAnswers = path.join(project, ".nodulus", "replay-answers.json");
  writeFileSync(callerInputs, '{"goal":{"target":"release notes"}}\n', "utf8");
  writeFileSync(firstAnswers, '{"confirmed":true}\n', "utf8");
  writeFileSync(secondAnswers, '{"revision":"v1"}\n', "utf8");
  writeFileSync(replayAnswers, '{"confirmed":false,"revision":"overwrite"}\n', "utf8");
  try {
    const initial = JSON.parse(runFreshWorkflowDriver(["run", project, callerInputs], project).stdout);
    expect(initial.result.status).toBe("needs_input");
    const runId = initial.result.runId;
    const runDirectory = path.join(project, ".nodulus", "runs", runId);
    const firstRequest = JSON.parse(readFileSync(path.join(runDirectory, "pending", "request.json"), "utf8"));
    const firstResume = JSON.parse(runFreshWorkflowDriver(["resume", project, runId, firstRequest.id, firstAnswers], project).stdout);
    expect(firstResume.result.status).toBe("needs_input");
    const secondRequest = JSON.parse(readFileSync(path.join(runDirectory, "pending", "request.json"), "utf8"));
    const firstAcceptedPath = path.join(runDirectory, "answers", `${firstRequest.id}.json`);
    const firstAccepted = readFileSync(firstAcceptedPath, "utf8");
    const beforeConsumedReplay = readFileSync(callLog, "utf8");

    const consumedReplay = JSON.parse(runFreshWorkflowDriver(["resume", project, runId, firstRequest.id, replayAnswers], project).stdout);
    expect(consumedReplay).toMatchObject({ ok: false, error: { code: "PENDING_REQUEST_MISMATCH" } });
    expect(readFileSync(firstAcceptedPath, "utf8")).toBe(firstAccepted);
    expect(readFileSync(callLog, "utf8")).toBe(beforeConsumedReplay);

    const completed = JSON.parse(runFreshWorkflowDriver(["resume", project, runId, secondRequest.id, secondAnswers], project).stdout);
    expect(completed.result.status).toBe("success");
    const secondAcceptedPath = path.join(runDirectory, "answers", `${secondRequest.id}.json`);
    const secondAccepted = readFileSync(secondAcceptedPath, "utf8");
    const beforeTerminalReplay = readFileSync(callLog, "utf8");
    const terminalReplay = JSON.parse(runFreshWorkflowDriver(["resume", project, runId, secondRequest.id, replayAnswers], project).stdout);
    expect(terminalReplay).toMatchObject({ ok: false, error: { code: "RUN_NOT_PAUSED" } });
    expect(readFileSync(secondAcceptedPath, "utf8")).toBe(secondAccepted);
    expect(readFileSync(callLog, "utf8")).toBe(beforeTerminalReplay);
    expect(readCalls(callLog).map((call) => call.nodeId)).toEqual(["analyze", "build", "build", "build", "review"]);
    expect(existsSync(path.join(runDirectory, "result.json"))).toBe(true);
  } finally {
    cleanupClarificationProject(project);
  }
});

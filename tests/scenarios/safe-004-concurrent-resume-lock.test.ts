import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { cleanupClarificationProject } from "../support/clarification-resume.js";
import { createClarificationProject, createClarificationRunRequest, fixtureProvider } from "../support/clarification-resume.js";
import { runFile, spawnRecoveryResume, waitForChildClose, waitForFile } from "../support/recovery-scenarios.js";

test("SAFE-004 concurrent resume permits one owner and rejects the second process", async () => {
  const { project } = createClarificationProject("safe-004-lock");
  const callLog = path.join(project, ".nodulus", "fixtures", "calls.jsonl");
  const answers = path.join(project, "answers.json");
  const firstEntered = path.join(project, "first-entered.json");
  const secondEntered = path.join(project, "second-entered.json");
  const release = path.join(project, "release-provider");
  let first: ReturnType<typeof spawnRecoveryResume> | undefined;
  let second: ReturnType<typeof spawnRecoveryResume> | undefined;
  let firstClosed: ReturnType<typeof waitForChildClose> | undefined;
  let secondClosed: ReturnType<typeof waitForChildClose> | undefined;
  try {
    const initial = await runWorkflow(createClarificationRunRequest(project), fixtureProvider(project));
    expect(initial.status).toBe("needs_input");
    const pending = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", initial.runId, "pending", "request.json"), "utf8"));
    writeFileSync(answers, '{"confirmed":true}\n', "utf8");

    first = spawnRecoveryResume(project, initial.runId, pending.id, answers, firstEntered, release, callLog);
    firstClosed = waitForChildClose(first, 12_000);
    await waitForFile(firstEntered, 4000);
    second = spawnRecoveryResume(project, initial.runId, pending.id, answers, secondEntered, release, callLog);
    secondClosed = waitForChildClose(second, 4000);
    const secondExit = await secondClosed;
    writeFileSync(release, "continue\n", "utf8");
    const firstExit = await firstClosed;
    expect(firstExit.code).toBe(0);
    expect(JSON.parse(firstExit.stdout)).toMatchObject({ ok: true, result: { status: "success" } });
    const calls = readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const ownerPid = JSON.parse(readFileSync(firstEntered, "utf8")).pid;
    const ownerCalls = calls.filter((call) => call.pid === ownerPid);
    expect(ownerCalls.map((call) => call.nodeId)).toEqual(["build", "review"]);
    expect(ownerCalls.filter((call) => call.nodeId === "build")).toHaveLength(1);
    expect(ownerCalls.find((call) => call.nodeId === "build").answers).toEqual({ confirmed: true });
    expect(JSON.parse(secondExit.stdout)).toMatchObject({ ok: false, error: { code: "RUN_LOCKED" } });
    expect(existsSync(secondEntered)).toBe(false);
  } finally {
    writeFileSync(release, "continue\n", "utf8");
    if (second && second.exitCode === null && second.signalCode === null) second.kill();
    if (firstClosed) await firstClosed.catch(() => undefined);
    if (secondClosed) await secondClosed.catch(() => undefined);
    cleanupClarificationProject(project);
  }
});

test("SAFE-004 two processes refuse a stale lock without deleting it or mutating the paused run", async () => {
  const { project } = createClarificationProject("safe-004-stale-lock");
  const answers = path.join(project, "answers.json");
  const firstEntered = path.join(project, "stale-first-entered.json");
  const secondEntered = path.join(project, "stale-second-entered.json");
  const release = path.join(project, "stale-release-provider");
  const callLog = path.join(project, ".nodulus", "fixtures", "calls.jsonl");
  let first: ReturnType<typeof spawnRecoveryResume> | undefined;
  let second: ReturnType<typeof spawnRecoveryResume> | undefined;
  let firstClosed: ReturnType<typeof waitForChildClose> | undefined;
  let secondClosed: ReturnType<typeof waitForChildClose> | undefined;
  try {
    const initial = await runWorkflow(createClarificationRunRequest(project), fixtureProvider(project));
    expect(initial.status).toBe("needs_input");
    const pending = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", initial.runId, "pending", "request.json"), "utf8"));
    writeFileSync(answers, '{"confirmed":true}\n', "utf8");
    const lockPath = runFile(project, initial.runId, ".resume.lock");
    const staleLockContents = `${JSON.stringify({ pid: findDeadPid(), token: "stale-owner" })}\n`;
    writeFileSync(lockPath, staleLockContents, "utf8");
    const checkpointBefore = readFileSync(runFile(project, initial.runId, "run.json"), "utf8");
    const callsBefore = readFileSync(callLog, "utf8");

    first = spawnRecoveryResume(project, initial.runId, pending.id, answers, firstEntered, release, callLog);
    second = spawnRecoveryResume(project, initial.runId, pending.id, answers, secondEntered, release, callLog);
    firstClosed = waitForChildClose(first, 5000);
    secondClosed = waitForChildClose(second, 5000);
    const [firstExit, secondExit] = await Promise.all([firstClosed, secondClosed]);
    expect(JSON.parse(firstExit.stdout)).toMatchObject({ ok: false, error: { code: "RUN_RECOVERY_REQUIRED" } });
    expect(JSON.parse(secondExit.stdout)).toMatchObject({ ok: false, error: { code: "RUN_RECOVERY_REQUIRED" } });
    expect(existsSync(firstEntered)).toBe(false);
    expect(existsSync(secondEntered)).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe(staleLockContents);
    expect(readFileSync(runFile(project, initial.runId, "run.json"), "utf8")).toBe(checkpointBefore);
    expect(readFileSync(callLog, "utf8")).toBe(callsBefore);
    expect(existsSync(runFile(project, initial.runId, `answers/${pending.id}.json`))).toBe(false);
  } finally {
    writeFileSync(release, "continue\n", "utf8");
    if (first && first.exitCode === null && first.signalCode === null) first.kill();
    if (second && second.exitCode === null && second.signalCode === null) second.kill();
    if (firstClosed) await firstClosed.catch(() => undefined);
    if (secondClosed) await secondClosed.catch(() => undefined);
    cleanupClarificationProject(project);
  }
});

function findDeadPid(): number {
  let candidate = process.pid + 100_000;
  while (candidate < 2_000_000_000) {
    try { process.kill(candidate, 0); candidate += 1; }
    catch { return candidate; }
  }
  throw new Error("Could not find an unused process ID for the stale lock fixture.");
}

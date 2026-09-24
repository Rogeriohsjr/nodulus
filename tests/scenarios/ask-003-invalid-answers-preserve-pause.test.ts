import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { resumeWorkflow } from "../../src/application/resume-workflow.js";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { cleanupClarificationProject, configureSinglePauseNode, createClarificationProject, createClarificationRunRequest, fixtureProvider } from "../support/clarification-resume.js";

const invalidAnswers = [
  { label: "wrong request id", requestId: "not-the-pending-id", answers: { confirmed: true }, code: "PENDING_REQUEST_MISMATCH" },
  { label: "missing required answer", requestId: "pending", answers: {}, code: "ANSWERS_INVALID" },
  { label: "invalid answer value", requestId: "pending", answers: { confirmed: false }, code: "ANSWERS_INVALID" },
];

test.each(invalidAnswers)("ASK-003 rejects $label without changing the paused run", async ({ requestId, answers, code }) => {
  const { project, callLog } = createClarificationProject("ask-003");
  configureSinglePauseNode(project);
  try {
    const initial = await runWorkflow(createClarificationRunRequest(project), fixtureProvider(project));
    expect(initial.status).toBe("needs_input");
    const runDirectory = path.join(project, ".nodulus", "runs", initial.runId);
    const pending = JSON.parse(readFileSync(path.join(runDirectory, "pending", "request.json"), "utf8"));
    const before = snapshot(runDirectory, pending.id);
    const callLogBefore = readFileSync(callLog, "utf8");
    const failure = await resumeWorkflow({
      projectRoot: project,
      runId: initial.runId,
      requestId: requestId === "pending" ? pending.id : requestId,
      answers,
    }, fixtureProvider(project)).then(() => null, (error: unknown) => error as { code?: string; message?: string });
    expect(failure).toMatchObject({ code });
    expect(failure?.message).toMatch(/request|answer|pending/i);
    expect(snapshot(runDirectory, pending.id)).toEqual(before);
    expect(readFileSync(callLog, "utf8")).toBe(callLogBefore);
    expect(readFileSync(path.join(runDirectory, "pending", "request.json"), "utf8")).toBe(JSON.stringify(pending, null, 2) + "\n");
    expect(snapshotAnswers(runDirectory)).toEqual([]);
  } finally {
    cleanupClarificationProject(project);
  }
});

function snapshot(runDirectory: string, requestId: string): Record<string, string | null> {
  const paths = ["run.json", "pending/request.json", `answers/${requestId}.json`, "events.jsonl"];
  return Object.fromEntries(paths.map((relative) => {
    try { return [relative, readFileSync(path.join(runDirectory, relative), "utf8")]; }
    catch { return [relative, null]; }
  }));
}

function snapshotAnswers(runDirectory: string): string[] {
  const answersDirectory = path.join(runDirectory, "answers");
  try {
    return readdirSync(answersDirectory).sort().map((name) => `${name}:${readFileSync(path.join(answersDirectory, name), "utf8")}`);
  } catch { return []; }
}

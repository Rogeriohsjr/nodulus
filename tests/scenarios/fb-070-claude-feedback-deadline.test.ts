import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import { resumeWorkflow, getRunStatus } from "../../src/application/resume-workflow.js";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { createFeedbackProject } from "../support/feedback-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

const claudeFixturePath = fileURLToPath(new URL("../fixtures/fb-070-claude-feedback-cli.mjs", import.meta.url));
const request = (projectRoot: string) => ({ projectRoot, cwd: projectRoot, workflow: "example", sources: [{ kind: "inline" as const, text: "Exercise bounded local Claude routing." }] });

type FixtureFiles = { control: string; probes: string; calls: string; authStarted: string; authCompleted: string; inferenceStarted: string; inferenceCompleted: string };

function installClaudeFixture(project: string, mode: string, timeoutMs: number, delayMs = 15_000, maxElapsedMs = 2_000): FixtureFiles {
  const directory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(directory, { recursive: true });
  const wrapperPath = path.join(directory, process.platform === "win32" ? "claude-feedback.cmd" : "claude-feedback.sh");
  copyFileSync(claudeFixturePath, path.join(directory, "fb-070-claude-feedback-cli.mjs"));
  if (process.platform === "win32") {
    writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\fb-070-claude-feedback-cli.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    writeFileSync(wrapperPath, `#!/bin/sh\nexec '${process.execPath}' '.nodulus/fixtures/fb-070-claude-feedback-cli.mjs' "$@"\n`, "utf8");
    chmodSync(wrapperPath, 0o755);
  }
  const settings = readProjectJson(project, ".nodulus/settings.json");
  settings.providerProfiles.fixture = { enabled: true, kind: "claude", executable: wrapperPath, model: "fixture-model", timeoutMs, maxTurns: 2, tools: "", safeMode: true };
  writeJson(project, ".nodulus/settings.json", settings);
  const workflow = readProjectJson(project, ".nodulus/workflows/example.json");
  const routing = workflow.feedbackRouting as Record<string, unknown>;
  workflow.feedbackRouting = { ...routing, limits: { maxIterations: 3, maxProviderCalls: 20, maxElapsedMs } };
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  const files = {
    control: path.join(directory, "fb-070-control.json"),
    probes: path.join(directory, "fb-070-probes.jsonl"),
    calls: path.join(directory, "fb-070-invocations.jsonl"),
    authStarted: path.join(directory, "fb-070-auth-started"),
    authCompleted: path.join(directory, "fb-070-auth-completed"),
    inferenceStarted: path.join(directory, "fb-070-invocation-started"),
    inferenceCompleted: path.join(directory, "fb-070-invocation-completed"),
  };
  setClaudeControl(files, mode, delayMs);
  return files;
}

function setClaudeControl(files: FixtureFiles, mode: string, delayMs = 15_000): void {
  writeFileSync(files.control, JSON.stringify({ mode, delayMs }), "utf8");
}

function treeDigest(root: string): string {
  const rows: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else rows.push(path.relative(root, absolute).replaceAll("\\", "/") + ":" + createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    }
  };
  visit(root);
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

async function waitForMarker(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fixture did not create marker '${path.basename(filePath)}' within ${timeoutMs}ms.`);
}

function errorCode(result: { result: unknown }): unknown {
  return (result.result as { error?: { code?: unknown } }).error?.code;
}

test("FB-070 Claude auth readiness is cancelled by the active feedback deadline before launch", async () => {
  const fixture = createFeedbackProject("fb-070-claude-auth-deadline");
  const files = installClaudeFixture(fixture.project, "slow-auth", 12_000);
  const provider = createDefaultProviderPort(fixture.project);
  try {
    const operationStartedAt = Date.now();
    const result = await runWorkflow(request(fixture.project), provider);
    const checkpoint = JSON.parse(await new LocalIntakeStorage().readRunFile(fixture.project, result.runId, "run.json")) as { feedbackRouting: { regions: Record<string, { uncertainCalls?: Array<Record<string, unknown>> }> } };
    const runCheckpoint = JSON.parse(await new LocalIntakeStorage().readRunFile(fixture.project, result.runId, "run.json")) as { feedbackRouting: { regions: Record<string, { deadlineAtMs?: number }> } };
    const deadlineAtMs = runCheckpoint.feedbackRouting.regions["content-review"].deadlineAtMs;
    const runRoot = path.join(fixture.project, ".nodulus", "runs", result.runId);
    expect({
      status: result.status,
      errorCode: errorCode(result),
      authStarted: existsSync(files.authStarted),
      authCompleted: existsSync(files.authCompleted),
      inferenceStarted: existsSync(files.inferenceStarted),
      uncertainCalls: checkpoint.feedbackRouting.regions["content-review"].uncertainCalls,
    }).toEqual({
      status: "error", errorCode: "FEEDBACK_LIMIT_EXCEEDED", authStarted: true, authCompleted: false, inferenceStarted: false,
      uncertainCalls: [expect.objectContaining({ nodeId: "prepare", operation: "invoke", launchStatus: "not_launched" })],
    });
    expect(Number.isFinite(deadlineAtMs)).toBe(true);
    expect(Date.now()).toBeLessThanOrEqual(Number(deadlineAtMs) + 1_500);
    expect(Date.now() - operationStartedAt).toBeLessThan(5_000);
    const callsDirectory = path.join(runRoot, "calls");
    expect(existsSync(callsDirectory) ? readdirSync(callsDirectory) : []).toEqual([]);
  } finally { fixture.cleanup(); }
}, 20000);

test("FB-070 Claude inference is cancelled and retains launched-call uncertainty at the feedback deadline", async () => {
  const fixture = createFeedbackProject("fb-070-claude-inference-deadline");
  const files = installClaudeFixture(fixture.project, "slow-inference", 8_000);
  const provider = createDefaultProviderPort(fixture.project);
  try {
    const result = await runWorkflow(request(fixture.project), provider);
    const runRoot = path.join(fixture.project, ".nodulus", "runs", result.runId);
    const callId = readdirSync(path.join(runRoot, "calls"))[0]!;
    const transport = JSON.parse(readFileSync(path.join(runRoot, "calls", callId, "transport.json"), "utf8")) as { cancelled: boolean; timedOut: boolean };
    const checkpoint = JSON.parse(await new LocalIntakeStorage().readRunFile(fixture.project, result.runId, "run.json")) as { feedbackRouting: { regions: Record<string, { uncertainCalls?: Array<Record<string, unknown>> }> } };
    expect({ status: result.status, errorCode: errorCode(result), inferenceStarted: existsSync(files.inferenceStarted), inferenceCompleted: existsSync(files.inferenceCompleted) }).toEqual({
      status: "error", errorCode: "FEEDBACK_LIMIT_EXCEEDED", inferenceStarted: true, inferenceCompleted: false,
    });
    expect(transport).toMatchObject({ cancelled: true, timedOut: false });
    expect(checkpoint.feedbackRouting.regions["content-review"].uncertainCalls).toEqual([expect.objectContaining({ nodeId: "prepare", operation: "invoke", launchStatus: "launched" })]);
  } finally { fixture.cleanup(); }
}, 20000);

test("FB-070 a fresh Claude resume shares the saved region deadline with readiness probes", async () => {
  const fixture = createFeedbackProject("fb-070-claude-resume-readiness-deadline");
  const files = installClaudeFixture(fixture.project, "pause-first", 8_000, 15_000, 5_000);
  const provider = createDefaultProviderPort(fixture.project);
  try {
    const initial = await runWorkflow(request(fixture.project), provider);
    expect(initial.status).toBe("needs_input");
    const status = await getRunStatus(fixture.project, initial.runId);
    const pending = status.pendingRequest as { id: string };
    const checkpoint = status.checkpoint as { feedbackRouting: { regions: Record<string, { deadlineAtMs?: number }> } };
    const deadlineAtMs = checkpoint.feedbackRouting.regions["content-review"].deadlineAtMs;
    expect(Number.isFinite(deadlineAtMs)).toBe(true);
    const runRoot = path.join(fixture.project, ".nodulus", "runs", initial.runId);
    const before = treeDigest(runRoot);
    const priorCallLog = readFileSync(files.calls, "utf8");
    rmSync(files.authStarted, { force: true });
    rmSync(files.authCompleted, { force: true });
    setClaudeControl(files, "slow-auth");
    const remainingMs = Number(deadlineAtMs) - Date.now();
    expect(remainingMs).toBeGreaterThan(2_000);
    await new Promise((resolve) => setTimeout(resolve, remainingMs - 2_000));
    const resumeStartedAt = Date.now();
    const resumed = await resumeWorkflow({ projectRoot: fixture.project, runId: initial.runId, requestId: pending.id, answers: { detail: "Continue before the stored deadline." } }, provider);
    const resumeCompletedAt = Date.now();
    await waitForMarker(files.authStarted, 100);
    expect({ status: resumed.status, errorCode: errorCode(resumed), authCompleted: existsSync(files.authCompleted), invocationLog: readFileSync(files.calls, "utf8") })
      .toEqual({ status: "error", errorCode: "FEEDBACK_LIMIT_EXCEEDED", authCompleted: false, invocationLog: priorCallLog });
    expect(resumeCompletedAt).toBeLessThanOrEqual(Number(deadlineAtMs) + 2_500);
    expect(resumeCompletedAt - resumeStartedAt).toBeLessThan(4_500);
    expect(treeDigest(runRoot)).toBe(before);
    const after = await getRunStatus(fixture.project, initial.runId);
    expect(after.status).toBe("needs_input");
    expect(readFileSync(path.join(runRoot, "events.jsonl"), "utf8")).not.toContain('"event":"run.resumed"');
    expect(existsSync(path.join(runRoot, "answers", pending.id + ".json"))).toBe(false);
  } finally { fixture.cleanup(); }
}, 20000);

test("FB-070 Claude configured provider timeout remains primary before the region deadline", async () => {
  const fixture = createFeedbackProject("fb-070-claude-provider-timeout");
  const files = installClaudeFixture(fixture.project, "slow-inference", 5_000, 30_000, 20_000);
  let executing: ReturnType<typeof runWorkflow> | undefined;
  try {
    executing = runWorkflow(request(fixture.project), createDefaultProviderPort(fixture.project));
    await waitForMarker(files.inferenceStarted, 10_000);
    const result = await executing;
    const runRoot = path.join(fixture.project, ".nodulus", "runs", result.runId);
    const callId = readdirSync(path.join(runRoot, "calls"))[0]!;
    const transport = JSON.parse(readFileSync(path.join(runRoot, "calls", callId, "transport.json"), "utf8")) as { cancelled: boolean; timedOut: boolean };
    expect({ status: result.status, errorCode: errorCode(result) }).toEqual({ status: "error", errorCode: "PROVIDER_TIMEOUT" });
    expect(transport).toMatchObject({ cancelled: false, timedOut: true });
    expect(existsSync(files.inferenceStarted)).toBe(true);
    expect(existsSync(files.inferenceCompleted)).toBe(false);
  } finally {
    if (executing) await executing.catch(() => undefined);
    fixture.cleanup();
  }
}, 20000);

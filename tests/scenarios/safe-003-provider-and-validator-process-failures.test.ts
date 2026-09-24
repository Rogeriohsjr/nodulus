import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { ProcessArtifactValidator } from "../../src/adapters/validation/process-artifact-validator.js";
import type { ArtifactValidator } from "../../src/core/ports/artifact-validator.js";
import { cleanupClarificationProject } from "../support/clarification-resume.js";
import { createRecoveryProject, directProvider, recoveryRequest, runFile, successfulNodeResponse, updateBuildValidator } from "../support/recovery-scenarios.js";

const validatorFailures = [
  { name: "timeout", code: "VALIDATOR_TIMEOUT", script: "import { writeFileSync } from 'node:fs'; writeFileSync('.nodulus/fixtures/validator-started', String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {});" },
  { name: "nonzero exit", code: "VALIDATOR_EXECUTION_FAILED", script: "process.stderr.write('validator diagnostic'); process.exit(7);" },
  { name: "malformed response", code: "VALIDATOR_INVALID_RESPONSE", script: "process.stdout.write('{ malformed');" },
];

test.each(validatorFailures)("SAFE-003 turns validator $name into a runtime error with saved diagnostics", async ({ name, code, script }) => {
  const { project } = createRecoveryProject(`safe-003-${name.replaceAll(" ", "-")}`);
  updateBuildValidator(project, script, name === "timeout" ? 350 : 1000);
  const calls: string[] = [];
  try {
    const result = await runWorkflow(recoveryRequest(project), directProvider((invocation) => {
      calls.push(invocation.nodeId);
      return successfulNodeResponse(invocation);
    }));
    expect(result.status).toBe("error");
    expect((result.result as any).error.code).toBe(code);
    expect(calls).toEqual(["analyze", "build"]);
    const validation = JSON.parse(readFileSync(runFile(project, result.runId, "nodes/build/attempt-001/validation.json"), "utf8"));
    expect(validation).toMatchObject({ valid: false, code });
    expect(existsSync(runFile(project, result.runId, "nodes/build/artifacts/implementation.json"))).toBe(false);
    expect(existsSync(runFile(project, result.runId, "nodes/review/attempt-001/invocation.json"))).toBe(false);
    if (name === "timeout") {
      const pidPath = path.join(project, ".nodulus", "fixtures", "validator-started");
      expect(existsSync(pidPath)).toBe(true);
      await waitForProcessExit(Number(readFileSync(pidPath, "utf8")), 1500);
    }
  } finally {
    cleanupClarificationProject(project);
  }
});

test("SAFE-003 cancels the production validator process on AbortSignal", async () => {
  const { project } = createRecoveryProject("safe-003-cancel");
  const started = path.join(project, ".nodulus", "fixtures", "cancel-validator-started");
  const descendantScript = path.join(project, ".nodulus", "fixtures", "validator-descendant.mjs");
  const descendantPidPath = path.join(project, ".nodulus", "fixtures", "validator-descendant.pid");
  writeFileSync(descendantScript, "setInterval(() => {}, 1000);\n", "utf8");
  writeFileSync(path.join(project, ".nodulus", "fixtures", "cancel-validator.mjs"), [
    "import { writeFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    `const descendant = spawn(process.execPath, [${JSON.stringify(descendantScript)}], { windowsHide: true, stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    "writeFileSync('.nodulus/fixtures/cancel-validator-started', String(process.pid));",
    "setInterval(() => {}, 1000);",
    "await new Promise(() => {});",
  ].join("\n"), "utf8");
  const controller = new AbortController();
  const validator: ArtifactValidator = new ProcessArtifactValidator();
  try {
    const executing = validator.execute(project, ".nodulus/fixtures/cancel-validator.mjs", "{}", 2500, controller.signal);
    await waitForFile(started, 1500);
    await waitForFile(descendantPidPath, 1500);
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    controller.abort();
    const result = await executing;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    await waitForProcessExit(descendantPid, 1500);
  } finally {
    controller.abort();
    try {
      const pid = Number(readFileSync(descendantPidPath, "utf8"));
      if (Number.isFinite(pid) && isProcessAlive(pid)) process.kill(pid);
    } catch { /* child already exited or was reaped */ }
    cleanupClarificationProject(project);
  }
});

test("SAFE-003 persists provider crashes as runtime errors without starting successors", async () => {
  const { project } = createRecoveryProject("safe-003-provider");
  const calls: string[] = [];
  try {
    const result = await runWorkflow(recoveryRequest(project), directProvider((invocation) => {
      calls.push(invocation.nodeId);
      throw new Error("fixture provider disconnected");
    }));
    expect(result.status).toBe("error");
    expect((result.result as any).error).toMatchObject({ code: "PROVIDER_FAILURE", message: expect.stringMatching(/disconnected/) });
    expect(calls).toEqual(["analyze"]);
    expect(JSON.parse(readFileSync(runFile(project, result.runId, "run.json"), "utf8")).status).toBe("error");
  } finally {
    cleanupClarificationProject(project);
  }
});

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for fixture handshake '${filePath}'.`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} remained alive after ${timeoutMs}ms.`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd >= 0 && stat.slice(commandEnd + 1).trimStart()[0] === "Z") return false;
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "ENOENT" || code === "ESRCH") return false;
    }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { return getErrorCode(error) !== "ESRCH"; }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

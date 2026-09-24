import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderInvocation, ProviderPort } from "../../src/application/run-workflow.js";
import { createClarificationProject, createClarificationRunRequest, writeJson } from "./clarification-resume.js";

export function createRecoveryProject(label: string): { project: string; callLog: string } {
  const created = createClarificationProject(label);
  const settingsPath = path.join(created.project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles.fixture.capabilities = ["responseRepair"];
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { project: created.project, callLog: created.callLog };
}

export function setRepairCapability(project: string, enabled: boolean): void {
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles.fixture.capabilities = enabled ? ["responseRepair"] : [];
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function recoveryRequest(project: string) {
  return createClarificationRunRequest(project, { goal: { target: "safe recovery" } });
}

export function successfulNodeResponse(invocation: ProviderInvocation): string {
  const output = invocation.nodeId === "analyze"
    ? { name: "findings", contract: "finding.v1", data: { text: "findings" } }
    : invocation.nodeId === "build"
      ? { name: "implementation", contract: "implementation.v1", data: { text: "implementation" } }
      : { name: "review", contract: "review.v1", data: { text: "review" } };
  return JSON.stringify({ status: "success", artifacts: [output] });
}

export function directProvider(
  onInvoke: (invocation: ProviderInvocation) => Promise<string> | string,
  onRepair?: (invocation: ProviderInvocation, previousRaw: string, errors: string[]) => Promise<string> | string,
): ProviderPort {
  return {
    async invoke(invocation) { return onInvoke(invocation); },
    ...(onRepair ? { async repairResponse(invocation, previousRaw, errors) { return onRepair(invocation, previousRaw, errors); } } : {}),
  };
}

export function runFile(project: string, runId: string, relative: string): string {
  return path.join(project, ".nodulus", "runs", runId, relative);
}

export function updateBuildValidator(project: string, script: string, timeoutMs = 1000): void {
  const nodePath = path.join(project, ".nodulus", "nodes", "build.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  node.expectedOutputs[0].validator = ".nodulus/validators/build.mjs";
  node.expectedOutputs[0].validatorTimeoutMs = timeoutMs;
  writeJson(project, ".nodulus/nodes/build.json", node);
  mkdirSync(path.join(project, ".nodulus", "validators"), { recursive: true });
  writeFileSync(path.join(project, node.expectedOutputs[0].validator), script, "utf8");
}

export function providerProfileCapabilities(project: string): string[] {
  const settings = JSON.parse(readFileSync(path.join(project, ".nodulus", "settings.json"), "utf8"));
  return settings.providerProfiles.fixture.capabilities ?? [];
}

export function spawnRecoveryResume(
  project: string,
  runId: string,
  requestId: string,
  answersPath: string,
  enteredPath: string,
  releasePath: string,
  callLogPath: string,
): ChildProcessWithoutNullStreams {
  const driver = fileURLToPath(new URL("../fixtures/recovery-resume-driver.mjs", import.meta.url));
  return spawn(process.execPath, [driver, project, runId, requestId, answersPath, enteredPath, releasePath, callLogPath], {
    cwd: project,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for fixture handshake '${filePath}'.`);
}

export async function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child process did not close within ${timeoutMs}ms.`)), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

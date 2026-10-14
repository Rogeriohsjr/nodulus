import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { runProcess } from "../../src/adapters/providers/process-runner.js";
import { runCapturedProcess } from "../../src/adapters/providers/captured-process.js";
import { createFeedbackProject } from "../support/feedback-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";
import { runWorkflow, type ProviderInvocation } from "../../src/application/run-workflow.js";

const providerCliFixture = fileURLToPath(new URL("../fixtures/fb-080-deadline-provider-cli.mjs", import.meta.url));
const processProbeFixture = fileURLToPath(new URL("../fixtures/fb-080-process-probe.mjs", import.meta.url));
const processTreeFixture = fileURLToPath(new URL("../fixtures/fb-080-process-tree.mjs", import.meta.url));
const processTreeDescendantFixture = fileURLToPath(new URL("../fixtures/fb-080-process-tree-descendant.mjs", import.meta.url));

type InstalledProvider = { project: string; executable: string; controlPath: string; eventsPath: string; profile: Record<string, unknown> };

function installProviderFixture(project: string, options: { authDelayMs?: number; inferenceDelayMs?: number; maxElapsedMs?: number; timeoutMs?: number } = {}): InstalledProvider {
  const directory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(directory, { recursive: true });
  const wrapperPath = path.join(directory, process.platform === "win32" ? "codex-fb080.cmd" : "codex-fb080.sh");
  copyFileSync(providerCliFixture, path.join(directory, "fb-080-deadline-provider-cli.mjs"));
  if (process.platform === "win32") {
    writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\fb-080-deadline-provider-cli.mjs" ".nodulus\\fixtures\\fb-080-control.json" ".nodulus\\fixtures\\fb-080-events.jsonl" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    writeFileSync(wrapperPath, `#!/bin/sh\nexec '${process.execPath}' '.nodulus/fixtures/fb-080-deadline-provider-cli.mjs' '.nodulus/fixtures/fb-080-control.json' '.nodulus/fixtures/fb-080-events.jsonl' "$@"\n`, "utf8");
    chmodSync(wrapperPath, 0o755);
  }
  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profile = { enabled: true, kind: "codex", executable: wrapperPath, timeoutMs: options.timeoutMs ?? 5000, model: "fb080-fixture", sandbox: "read-only" };
  settings.providerProfiles.fixture = profile;
  writeJson(project, ".nodulus/settings.json", settings);
  const workflow = readProjectJson(project, ".nodulus/workflows/example.json");
  const routing = workflow.feedbackRouting as Record<string, unknown>;
  workflow.feedbackRouting = {
    ...routing,
    limits: { maxIterations: 3, maxProviderCalls: 20, maxElapsedMs: options.maxElapsedMs ?? 3_600_000 },
  };
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  const controlPath = path.join(directory, "fb-080-control.json");
  const eventsPath = path.join(directory, "fb-080-events.jsonl");
  writeFileSync(controlPath, JSON.stringify({ authDelayMs: options.authDelayMs ?? 0, inferenceDelayMs: options.inferenceDelayMs ?? 0 }), "utf8");
  return { project, executable: wrapperPath, controlPath, eventsPath, profile };
}

function invocation(fixture: InstalledProvider, deadlineAtMs: number, signal: AbortSignal): ProviderInvocation {
  return {
    runId: randomUUID(), attempt: 1, workflow: "example", nodeId: "prepare",
    prompt: "Prepare a short response for FB-080.", inputs: { request: "FB-080" },
    providerProfile: fixture.profile, providerProfileId: "fixture",
    call: { callId: randomUUID(), attempt: 1, operation: "invoke" },
    deadlineAtMs, signal,
  };
}

function readEvents(fixture: InstalledProvider): Array<{ stage: string; atMs: number; pid: number }> {
  if (!existsSync(fixture.eventsPath)) return [];
  return readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { stage: string; atMs: number; pid: number });
}

function outcomeCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`FB-080 fixture did not create '${path.basename(filePath)}' within ${timeoutMs}ms.`);
}

async function processExited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const commandEnd = stat.lastIndexOf(")");
        if (commandEnd >= 0 && stat.slice(commandEnd + 1).trimStart()[0] === "Z") return true;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code))) return true;
      }
    }
    try { process.kill(pid, 0); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && String(error.code) === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd >= 0 && stat.slice(commandEnd + 1).trimStart()[0] === "Z") return false;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code))) return false;
    }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(typeof error === "object" && error !== null && "code" in error && String(error.code) === "ESRCH"); }
}

function killProcessTreeForCleanup(pid: number | null): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } } }
}

test("FB-080 default provider rejects an expired absolute deadline before version, auth, or inference probes", async () => {
  const fixture = createFeedbackProject("fb-080-expired-provider-deadline");
  const providerFixture = installProviderFixture(fixture.project);
  const controller = new AbortController();
  try {
    const execution = await createDefaultProviderPort(fixture.project).invoke(invocation(providerFixture, Date.now() - 100, controller.signal))
      .then((response) => ({ response }), (error: unknown) => ({ error }));
    expect({ code: "error" in execution ? outcomeCode(execution.error) : null, signalAborted: controller.signal.aborted, events: readEvents(providerFixture) })
      .toEqual({ code: "FEEDBACK_LIMIT_EXCEEDED", signalAborted: false, events: [] });
  } finally { fixture.cleanup(); }
}, 15_000);

test("FB-080 late successful readiness crossing the absolute deadline cannot start inference", async () => {
  const fixture = createFeedbackProject("fb-080-late-readiness");
  const providerFixture = installProviderFixture(fixture.project, { authDelayMs: 5000, timeoutMs: 10_000 });
  const controller = new AbortController();
  const deadlineAtMs = Date.now() + 3000;
  try {
    const execution = await createDefaultProviderPort(fixture.project).invoke(invocation(providerFixture, deadlineAtMs, controller.signal))
      .then((response) => ({ response }), (error: unknown) => ({ error }));
    const events = readEvents(providerFixture);
    const stages = events.map((event) => event.stage);
    expect({
      code: "error" in execution ? outcomeCode(execution.error) : null,
      signalAborted: controller.signal.aborted,
      authStarted: stages.includes("auth-started"),
      authCompleted: events.some((event) => event.stage === "auth-completed" && event.atMs > deadlineAtMs),
      inferenceStarted: stages.includes("inference-started"),
    }).toEqual({ code: "FEEDBACK_LIMIT_EXCEEDED", signalAborted: false, authStarted: true, authCompleted: true, inferenceStarted: false });
  } finally { fixture.cleanup(); }
}, 20_000);

test("FB-080 default provider availability refuses an expired deadline without starting probes", async () => {
  const fixture = createFeedbackProject("fb-080-expired-availability");
  const providerFixture = installProviderFixture(fixture.project);
  const controller = new AbortController();
  try {
    const available = await createDefaultProviderPort(fixture.project).isAvailable!(providerFixture.profile, {
      deadlineAtMs: Date.now() - 100,
      signal: controller.signal,
    });
    expect({ available, signalAborted: controller.signal.aborted, events: readEvents(providerFixture) })
      .toEqual({ available: false, signalAborted: false, events: [] });
  } finally { fixture.cleanup(); }
}, 15_000);

test("FB-080 workflow checkpoint writes that consume the tiny budget do not dispatch provider probes", async () => {
  const fixture = createFeedbackProject("fb-080-checkpoint-write-expiry");
  const providerFixture = installProviderFixture(fixture.project, { maxElapsedMs: 1 });
  try {
    const result = await runWorkflow({ projectRoot: fixture.project, cwd: fixture.project, workflow: "example", sources: [{ kind: "inline", text: "FB-080 expired before provider dispatch" }] }, createDefaultProviderPort(fixture.project));
    expect({ status: result.status, code: (result.result as { error?: { code?: string } }).error?.code ?? null, events: readEvents(providerFixture) })
      .toEqual({ status: "error", code: "FEEDBACK_LIMIT_EXCEEDED", events: [] });
  } finally { fixture.cleanup(); }
}, 15_000);

test("FB-080 pre-aborted runProcess does not launch a real fixture child", async () => {
  const temporary = mkdtempForProcessFixture();
  const startedPath = path.join(temporary, "process-started.json");
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await runProcess(process.execPath, [processProbeFixture, startedPath], { cwd: temporary, timeoutMs: 5000, signal: controller.signal });
    expect({ cancelled: result.cancelled, timedOut: result.timedOut, started: existsSync(startedPath) }).toEqual({ cancelled: true, timedOut: false, started: false });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 10_000);

test("FB-080 captured process persists explicit not-launched evidence for a pre-aborted call", async () => {
  const fixture = createFeedbackProject("fb-080-captured-pre-aborted");
  const providerFixture = installProviderFixture(fixture.project);
  const controller = new AbortController();
  controller.abort();
  const providerInvocation = invocation(providerFixture, Date.now() + 10_000, controller.signal);
  const port = createDefaultProviderPort(fixture.project);
  try {
    const result = await runCapturedProcess(providerFixture.executable, ["--version"], {
      cwd: fixture.project, stdin: "", timeoutMs: 5000, signal: controller.signal,
    }, providerInvocation);
    const transportPath = path.join(fixture.project, ".nodulus", "runs", providerInvocation.runId, "calls", result.callId, "transport.json");
    const transport = JSON.parse(readFileSync(transportPath, "utf8")) as { cancelled: boolean; started?: boolean };
    expect({ started: result.started, persistedStarted: transport.started, cancelled: result.cancelled, events: readEvents(providerFixture) })
      .toEqual({ started: false, persistedStarted: false, cancelled: true, events: [] });
    const adapterInvocation = { ...providerInvocation, runId: randomUUID(), call: { callId: randomUUID(), attempt: 1, operation: "invoke" as const } };
    await expect(port.invoke(adapterInvocation)).rejects.toMatchObject({ code: "FEEDBACK_LIMIT_EXCEEDED" });
    expect(port.launchForCall?.(adapterInvocation.call.callId)).toBe(false);
  } finally { fixture.cleanup(); }
}, 10_000);

test("FB-080 captured process refuses an expired deadline at dispatch after writing call inputs", async () => {
  const fixture = createFeedbackProject("fb-080-captured-expired-deadline");
  const providerFixture = installProviderFixture(fixture.project);
  const controller = new AbortController();
  const providerInvocation = invocation(providerFixture, Date.now() - 100, controller.signal);
  try {
    const result = await runCapturedProcess(providerFixture.executable, ["--version"], {
      cwd: fixture.project, stdin: "", timeoutMs: 5000, signal: controller.signal,
    }, providerInvocation);
    const transportPath = path.join(fixture.project, ".nodulus", "runs", providerInvocation.runId, "calls", result.callId, "transport.json");
    const transport = JSON.parse(readFileSync(transportPath, "utf8")) as { started?: boolean };
    expect({ started: result.started, persistedStarted: transport.started, events: readEvents(providerFixture) })
      .toEqual({ started: false, persistedStarted: false, events: [] });
  } finally { fixture.cleanup(); }
}, 10_000);

function mkdtempForProcessFixture(): string {
  const root = path.join(os.tmpdir(), "nodulus-fb-080-process-");
  return mkdtempSync(root);
}

test("FB-080 runProcess cancellation waits until a nested real child tree is quiescent", async () => {
  const temporary = mkdtempForProcessFixture();
  const parentStartedPath = path.join(temporary, "parent-started.json");
  const descendantStartedPath = path.join(temporary, "descendant-started.json");
  const descendantPidPath = path.join(temporary, "descendant.pid");
  const eventsPath = path.join(temporary, "process-events.jsonl");
  const controller = new AbortController();
  let parentPid: number | null = null;
  let descendantPid: number | null = null;
  let abortAtMs: number | null = null;
  let deadlineAtMs = 0;
  const onAbort = () => {
    abortAtMs = Date.now();
    appendFileSync(eventsPath, JSON.stringify({ stage: "abort", atMs: abortAtMs }) + "\n", "utf8");
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const executing = runProcess(process.execPath, [processTreeFixture, processTreeDescendantFixture, parentStartedPath, descendantStartedPath, descendantPidPath, eventsPath], {
      cwd: temporary, timeoutMs: 10_000, signal: controller.signal,
    });
    await waitForFile(parentStartedPath, 3000);
    await waitForFile(descendantStartedPath, 3000);
    parentPid = Number((JSON.parse(readFileSync(parentStartedPath, "utf8")) as { pid: number }).pid);
    descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    deadlineAtMs = Date.now() + 300;
    writeFileSync(eventsPath, JSON.stringify({ stage: "deadline", atMs: deadlineAtMs }) + "\n", { flag: "a" });
    const untilDeadline = Math.max(0, deadlineAtMs - Date.now());
    await new Promise((resolve) => setTimeout(resolve, untilDeadline));
    controller.abort();
    const result = await executing;
    const returnedAtMs = Date.now();
    const parentAliveAtReturn = isProcessAlive(parentPid);
    const descendantAliveAtReturn = isProcessAlive(descendantPid);
    const parentStopped = await processExited(parentPid, 2000);
    const descendantStopped = await processExited(descendantPid, 2000);
    const events = readFileSync(eventsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { stage: string; atMs: number; pid?: number });
    const diagnostic = {
      deadlineAtMs,
      abortAtMs,
      returnedAtMs,
      parentStartAtMs: events.find((event) => event.stage === "parent-started")?.atMs,
      descendantStartAtMs: events.find((event) => event.stage === "descendant-started")?.atMs,
      parentAliveAtReturn,
      descendantAliveAtReturn,
      parentStopped,
      descendantStopped,
    };
    expect({ cancelled: result.cancelled, timedOut: result.timedOut, parentAliveAtReturn, descendantAliveAtReturn, parentStopped, descendantStopped, diagnostic }).toEqual({
      cancelled: true, timedOut: false, parentAliveAtReturn: false, descendantAliveAtReturn: false, parentStopped: true, descendantStopped: true, diagnostic: expect.objectContaining({
        deadlineAtMs, abortAtMs: expect.any(Number), returnedAtMs: expect.any(Number), parentStartAtMs: expect.any(Number), descendantStartAtMs: expect.any(Number), parentAliveAtReturn: false, descendantAliveAtReturn: false, parentStopped: true, descendantStopped: true,
      }),
    });
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
    killProcessTreeForCleanup(parentPid);
    killProcessTreeForCleanup(descendantPid);
    if (parentPid !== null) await processExited(parentPid, 2000);
    if (descendantPid !== null) await processExited(descendantPid, 2000);
    await removeProcessFixtureDirectory(temporary);
  }
}, 15_000);

async function removeProcessFixtureDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      if (process.platform !== "win32" || code !== "EPERM" || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

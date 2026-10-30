import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const lockerScript = fileURLToPath(new URL("../fixtures/par-windows-file-lock.ps1", import.meta.url));
const powershell = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

export type WindowsFileLock = {
  target: string;
  pid: number;
  entryPath: string;
  startedPath: string;
  releasePath: string;
  waitForAcquired(timeoutMs?: number): Promise<void>;
  releaseAndWait(timeoutMs?: number): Promise<void>;
  isSafeToRemove(): boolean;
};

export function startWindowsFileLock(project: string, target: string, watchdogMs = 12_000): WindowsFileLock {
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "windows-file-lock");
  mkdirSync(stateDirectory, { recursive: true });
  const entryPath = path.join(stateDirectory, "entry.json");
  const startedPath = path.join(stateDirectory, "started.json");
  const releasePath = path.join(stateDirectory, "release");
  const spawnedAt = performance.now();
  const child = spawn(powershell, [
    "-NoProfile", "-NonInteractive", "-File", lockerScript,
    "-Target", target, "-Entry", entryPath, "-Started", startedPath, "-Release", releasePath, "-WatchdogMilliseconds", String(watchdogMs),
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const childPid = child.pid;
  if (typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid <= 0) throw new Error("PowerShell lock process did not expose a valid PID.");
  const pid: number = childPid;
  let exitError: unknown;
  let stderr = "";
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-1200); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1200); });
  const exited = processExit(child).catch((error: unknown) => { exitError = error; });
  let verified = false;
  let stopped = false;

  return {
    target,
    pid,
    entryPath,
    startedPath,
    releasePath,
    async waitForAcquired(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(startedPath)) {
        if (stopped || Date.now() >= deadline) throw new Error(`Timed out waiting for PowerShell lock PID ${pid} to acquire '${target}'; ${processDetails()}`);
        await delay(10);
      }
      const marker = readMarkerMetadata(startedPath);
      if (marker.pid !== pid || marker.target !== target) throw new Error(`PowerShell lock marker does not match owned PID ${pid} and target.`);
      if (!isProcessAlive(pid)) throw new Error(`PowerShell lock PID ${pid} exited after acquiring '${target}'.`);
      verified = true;
    },
    async releaseAndWait(timeoutMs = 4_000) {
      writeFileSync(releasePath, "release\n", "utf8");
      const deadline = Date.now() + timeoutMs;
      while (!stopped && Date.now() < deadline) await delay(10);
      if (!stopped) {
        child.kill();
        const killDeadline = Date.now() + 2_000;
        while (!stopped && Date.now() < killDeadline) await delay(10);
      }
      if (!stopped) throw new Error(`Could not confirm PowerShell lock PID ${pid} exited; fixture project must be retained.`);
      await exited;
      if (exitError !== undefined) throw exitError;
      if (!verified) throw new Error(`PowerShell lock PID ${pid} was never verified; fixture project must be retained. ${processDetails()}`);
      if (isProcessAlive(pid)) throw new Error(`PowerShell lock PID ${pid} may still be alive; fixture project must be retained.`);
    },
    isSafeToRemove: () => verified && stopped && !isProcessAlive(pid),
  };

  function processExit(process: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      process.once("error", (error) => { stopped = true; reject(error); });
      process.once("exit", (code, signal) => {
        stopped = true;
        if (code !== 0) reject(new Error(`PowerShell lock PID ${pid} exited with code ${String(code)} and signal ${String(signal)}; ${processDetails()}`));
        else resolve();
      });
    });
  }

  function processDetails(): string {
    return JSON.stringify({
      spawnElapsedMs: Math.max(0, performance.now() - spawnedAt),
      stopped,
      exitError: exitError === undefined ? null : safeErrorMessage(exitError),
      pidAlive: isProcessAlive(pid),
      markers: [entryPath, `${entryPath}.${pid}.tmp`, startedPath, `${startedPath}.${pid}.tmp`].map((markerPath) => ({ path: path.basename(markerPath), ...markerSummary(markerPath) })),
      stdout,
      stderr,
    });
  }
}

function readMarkerMetadata(file: string): { pid?: unknown; target?: unknown } {
  const summary = markerSummary(file);
  if (summary.metadata === undefined) {
    const diagnostic = typeof summary.error === "string" ? summary.error : "metadata unavailable";
    throw new Error(`Could not read complete lock marker '${path.basename(file)}': ${diagnostic}.`);
  }
  return summary.metadata as { pid?: unknown; target?: unknown };
}

function markerSummary(file: string): Record<string, unknown> {
  let descriptor: number | undefined;
  try {
    const beforeOpen = lstatSync(file);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) return { present: true, type: beforeOpen.isSymbolicLink() ? "symlink" : "other", size: beforeOpen.size };
    descriptor = openSync(file, "r");
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 2048) return { present: true, type: opened.isFile() ? "file" : "other", size: opened.size, error: "marker exceeds safe read limit or is not a regular file" };
    const bytes = Buffer.alloc(2048);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    const metadata = JSON.parse(bytes.subarray(0, count).toString("utf8")) as unknown;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return { present: true, type: "file", size: opened.size, error: "marker JSON is not an object" };
    const value = metadata as Record<string, unknown>;
    return { present: true, type: "file", size: opened.size, metadata: { ...(typeof value.pid === "number" ? { pid: value.pid } : {}), ...(typeof value.target === "string" ? { target: value.target } : {}) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    return { present: true, error: safeErrorMessage(error) };
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Marker diagnostics must not replace the observed lock error. */ }
    }
  }
}

function safeErrorMessage(error: unknown): string {
  try { return error instanceof Error ? error.message.slice(0, 500) : "non-Error process diagnostic"; }
  catch { return "uninspectable process diagnostic"; }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

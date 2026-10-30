import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lockerScript = fileURLToPath(new URL("../fixtures/par-windows-file-lock.ps1", import.meta.url));
const powershell = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

export type WindowsFileLock = {
  target: string;
  pid: number;
  startedPath: string;
  releasePath: string;
  waitForAcquired(timeoutMs?: number): Promise<void>;
  releaseAndWait(timeoutMs?: number): Promise<void>;
  isSafeToRemove(): boolean;
};

export function startWindowsFileLock(project: string, target: string, watchdogMs = 12_000): WindowsFileLock {
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "windows-file-lock");
  mkdirSync(stateDirectory, { recursive: true });
  const startedPath = path.join(stateDirectory, "started.json");
  const releasePath = path.join(stateDirectory, "release");
  const child = spawn(powershell, [
    "-NoProfile", "-NonInteractive", "-File", lockerScript,
    "-Target", target, "-Started", startedPath, "-Release", releasePath, "-WatchdogMilliseconds", String(watchdogMs),
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("PowerShell lock process did not expose a valid PID.");
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
    startedPath,
    releasePath,
    async waitForAcquired(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(startedPath)) {
        if (stopped || Date.now() >= deadline) throw new Error(`Timed out waiting for PowerShell lock PID ${pid} to acquire '${target}'; ${processDetails()}`);
        await delay(10);
      }
      const marker = JSON.parse(readFileSync(startedPath, "utf8")) as { pid?: unknown; target?: unknown };
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
    return `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

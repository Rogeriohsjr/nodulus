import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { PhysicalTerminationCause, ProcessCleanupUnverified } from "../../core/ports/physical-process.js";

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  started: boolean;
  outputLimitExceeded: boolean;
  terminationCause?: PhysicalTerminationCause;
  cleanupUnverified?: ProcessCleanupUnverified;
};
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const processGroupShutdownTimeoutMs = 2000;
const processGroupPollIntervalMs = 10;

type TerminationCause = PhysicalTerminationCause;

/** Runs an executable without shell interpolation and bounds time and captured output. */
export function runProcess(executable: string, args: string[], options: {
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}): Promise<ProcessResult> {
  if (options.signal?.aborted || (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)) {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, cancelled: options.signal?.aborted === true, started: false, outputLimitExceeded: false });
  }
  return new Promise((resolve, reject) => {
    const child = crossSpawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let cancelled = false;
    let started = false;
    let outputLimitExceeded = false;
    let settled = false;
    let terminationCause: TerminationCause | undefined;
    let termination: Promise<void> | undefined;
    let windowsTerminationAttempted = false;
    const beginTermination = (cause: TerminationCause) => {
      if (settled || terminationCause !== undefined) return;
      terminationCause = cause;
      cancelled = cause === "cancelled";
      timedOut = cause === "timedOut";
      outputLimitExceeded = cause === "outputLimitExceeded";
      termination = Promise.resolve().then(() => {
        if (process.platform === "win32" && child.pid !== undefined) windowsTerminationAttempted = true;
        return killTree(child, cause);
      });
      void termination.catch(() => undefined);
    };
    const timer = setTimeout(() => beginTermination("timedOut"), Math.max(1, options.timeoutMs));
    const onAbort = () => {
      beginTermination("cancelled");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.once("spawn", () => { started = true; });
    const receive = (target: "stdout" | "stderr", chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        outputLimitExceeded = true;
        beginTermination("outputLimitExceeded");
        return;
      }
      if (target === "stdout") stdoutChunks.push(Buffer.from(chunk));
      else stderrChunks.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", (chunk: Buffer) => receive("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => receive("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      void finishClose(exitCode);
    });
    child.stdin?.once("error", () => undefined);
    child.stdin?.end(options.stdin ?? "");
    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    async function finishClose(exitCode: number | null): Promise<void> {
      let cleanupUnverified: ProcessCleanupUnverified | undefined;
      try {
        await termination;
      } catch (error) {
        if (terminationCause === undefined) {
          reject(error);
          return;
        }
        cleanupUnverified = {
          code: "PROCESS_TREE_UNVERIFIED",
          message: `Process-tree cleanup could not be verified after ${terminationCause}: ${boundedError(error)}`.slice(0, 1200),
          operationCause: terminationCause,
        };
      }
      if (cleanupUnverified === undefined && windowsTerminationAttempted && terminationCause !== undefined) {
        cleanupUnverified = {
          code: "PROCESS_TREE_UNVERIFIED",
          message: "Windows root termination was attempted and the root closed, but descendant exit could not be verified.",
          operationCause: terminationCause,
        };
      }
      if (!settled) return;
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        timedOut,
        cancelled,
        started,
        outputLimitExceeded,
        ...(terminationCause === undefined ? {} : { terminationCause }),
        ...(cleanupUnverified === undefined ? {} : { cleanupUnverified }),
      });
    }
  });
}

function boundedError(error: unknown): string {
  try { return (error instanceof Error ? error.message : String(error)).slice(0, 900); }
  catch { return "Cleanup failure could not be described safely."; }
}

function killTree(child: ChildProcess, cause: TerminationCause): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === "win32") {
    const killer = crossSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return new Promise((resolve, reject) => {
      killer.once("error", reject);
      killer.once("close", (exitCode) => {
        if (exitCode === 0) resolve();
        else reject(new Error(`taskkill failed to terminate process ${child.pid} (exit ${exitCode}).`));
      });
    });
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
  return waitForProcessGroupExit(child.pid, cause);
}

async function waitForProcessGroupExit(pid: number, cause: TerminationCause): Promise<void> {
  const deadline = performance.now() + processGroupShutdownTimeoutMs;
  while (true) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      const error = new Error(`Could not confirm owned process group ${pid} stopped within ${processGroupShutdownTimeoutMs} ms after ${cause}.`) as Error & { code: string; terminationCause: TerminationCause };
      error.code = "PROCESS_TREE_CLEANUP_FAILED";
      error.terminationCause = cause;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(processGroupPollIntervalMs, remainingMs)));
  }
}

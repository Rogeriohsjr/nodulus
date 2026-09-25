import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";

export type ProcessResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; cancelled: boolean; outputLimitExceeded: boolean };
const OUTPUT_LIMIT = 2 * 1024 * 1024;

/** Runs an executable without shell interpolation and bounds time and captured output. */
export function runProcess(executable: string, args: string[], options: {
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProcessResult> {
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
    let outputLimitExceeded = false;
    let settled = false;
    const kill = () => killTree(child);
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, options.timeoutMs));
    const onAbort = () => { cancelled = true; kill(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const receive = (target: "stdout" | "stderr", chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) { outputLimitExceeded = true; kill(); return; }
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
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        timedOut,
        cancelled,
        outputLimitExceeded,
      });
    });
    child.stdin?.once("error", () => undefined);
    child.stdin?.end(options.stdin ?? "");
    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  });
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = crossSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
}

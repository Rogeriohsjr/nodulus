import { spawn } from "node:child_process";
import path from "node:path";
import type { ArtifactValidator, ValidatorProcessResult } from "../../core/ports/artifact-validator.js";

const outputLimitBytes = 1024 * 1024;

export class ProcessArtifactValidator implements ArtifactValidator {
  execute(projectRoot: string, scriptPath: string, artifactJson: string, timeoutMs: number, signal?: AbortSignal): Promise<ValidatorProcessResult> {
    const absoluteScript = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(projectRoot, scriptPath);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [absoluteScript], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let cancelled = false;
      let outputLimitExceeded = false;
      let settled = false;
      const terminate = (reason: "timeout" | "output" | "cancel") => {
        if (reason === "timeout") timedOut = true;
        else if (reason === "output") outputLimitExceeded = true;
        else cancelled = true;
        killProcessTree(child.pid);
      };
      const timer = setTimeout(() => terminate("timeout"), Math.max(1, timeoutMs));
      const onAbort = () => terminate("cancel");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > outputLimitBytes) terminate("output");
        else stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk, "utf8");
        if (stderrBytes > outputLimitBytes) terminate("output");
        else stderr += chunk;
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode, timedOut, cancelled, outputLimitExceeded });
      });
      child.stdin.once("error", () => undefined);
      child.stdin.end(artifactJson);
    });
  }
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.unref();
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch { try { process.kill(pid, "SIGKILL"); } catch { /* process already exited */ } }
}

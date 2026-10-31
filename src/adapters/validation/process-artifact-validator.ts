import { spawn, type ChildProcess } from "node:child_process";
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
      let terminationCause: ValidatorProcessResult["terminationCause"];
      let cleanupUnverified: ValidatorProcessResult["cleanupUnverified"];
      let settled = false;
      let terminating = false;
      let termination: Promise<void> = Promise.resolve();
      let childExitObserved = false;
      child.once("exit", () => { childExitObserved = true; });
      const terminate = (reason: "timeout" | "output" | "cancel") => {
        if (terminating) return;
        terminating = true;
        const cause = reason === "timeout" ? "timedOut" : reason === "output" ? "outputLimitExceeded" : "cancelled";
        terminationCause = cause;
        if (reason === "timeout") timedOut = true;
        else if (reason === "output") outputLimitExceeded = true;
        else cancelled = true;
        termination = killProcessTree(child, cause, () => childExitObserved).then((cleanup) => { cleanupUnverified = cleanup; });
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
      child.once("close", async (exitCode) => {
        if (settled) return;
        await termination;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode, timedOut, cancelled, outputLimitExceeded,
          ...(terminationCause === undefined ? {} : { terminationCause }),
          ...(cleanupUnverified === undefined ? {} : { cleanupUnverified }),
        });
      });
      child.stdin.once("error", () => undefined);
      child.stdin.end(artifactJson);
    });
  }
}

function killProcessTree(child: ChildProcess, cause: NonNullable<ValidatorProcessResult["terminationCause"]>, exitObserved: () => boolean): Promise<ValidatorProcessResult["cleanupUnverified"]> {
  const pid = child.pid;
  if (!pid) return Promise.resolve(undefined);
  if (process.platform === "win32") {
    if (exitObserved() || child.exitCode !== null || child.signalCode !== null) {
      try { child.stdout?.destroy(); } catch { /* The owned validator output stream is already closing. */ }
      try { child.stderr?.destroy(); } catch { /* The owned validator output stream is already closing. */ }
      return Promise.resolve({
        code: "PROCESS_TREE_UNVERIFIED",
        message: "Windows validator root exit was observed before tree termination; descendant exit could not be verified.",
        operationCause: cause,
      });
    }
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return new Promise((resolve) => {
      let diagnostic: string | undefined;
      killer.once("error", (error) => { diagnostic = `Validator taskkill failed: ${error.message}`; });
      killer.once("close", (code) => resolve({
        code: "PROCESS_TREE_UNVERIFIED",
        message: diagnostic ?? (code === 0
          ? "Validator root closed after taskkill; descendant process-tree termination remains unverified."
          : `Validator taskkill exited with code ${typeof code === "number" ? code : "unknown"}; descendant process-tree termination remains unverified.`),
        operationCause: cause,
      }));
    });
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch { try { process.kill(pid, "SIGKILL"); } catch { /* process already exited */ } }
  return Promise.resolve(undefined);
}

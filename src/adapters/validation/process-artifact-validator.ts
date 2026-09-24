import { spawn } from "node:child_process";
import path from "node:path";
import type { ArtifactValidator, ValidatorProcessResult } from "../../core/ports/artifact-validator.js";

const outputLimitBytes = 1024 * 1024;

export class ProcessArtifactValidator implements ArtifactValidator {
  execute(projectRoot: string, scriptPath: string, artifactJson: string, timeoutMs: number): Promise<ValidatorProcessResult> {
    const absoluteScript = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(projectRoot, scriptPath);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [absoluteScript], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let outputLimitExceeded = false;
      let settled = false;
      const terminate = (reason: "timeout" | "output") => {
        if (reason === "timeout") timedOut = true;
        else outputLimitExceeded = true;
        child.kill();
      };
      const timer = setTimeout(() => terminate("timeout"), Math.max(1, timeoutMs));

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
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, timedOut, outputLimitExceeded });
      });
      child.stdin.once("error", () => undefined);
      child.stdin.end(artifactJson);
    });
  }
}

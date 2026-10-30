import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

export function createInitializedProject(label: string): string {
  const project = mkdtempSync(path.join(tmpdir(), `nodulus-${label}-`));
  const result = spawnSync(process.execPath, [cliPath, "init", "--project", project], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    const spawnError = result.error as NodeJS.ErrnoException | undefined;
    const diagnostic = {
      project,
      pid: result.pid ?? null,
      status: result.status,
      signal: result.signal,
      error: spawnError ? {
        name: typeof spawnError.name === "string" ? spawnError.name.slice(0, 80) : null,
        code: typeof spawnError.code === "string" || typeof spawnError.code === "number" ? String(spawnError.code).slice(0, 80) : null,
        message: typeof spawnError.message === "string" ? spawnError.message.slice(0, 240) : null,
      } : null,
      stdoutBytes: result.stdout === undefined || result.stdout === null ? 0 : Buffer.isBuffer(result.stdout) ? result.stdout.byteLength : Buffer.byteLength(result.stdout, "utf8"),
      stderrBytes: result.stderr === undefined || result.stderr === null ? 0 : Buffer.isBuffer(result.stderr) ? result.stderr.byteLength : Buffer.byteLength(result.stderr, "utf8"),
    };
    throw new Error(`Project fixture init failed: ${JSON.stringify(diagnostic)}`);
  }

  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles = {
    fixture: { enabled: true, executable: process.execPath },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  node.providerProfile = "fixture";
  node.inputs = { request: { from: "request", contract: "request.v1" } };
  writeFileSync(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");
  return project;
}

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

export function createTempProject(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `nodulus-${label}-`));
}

export function runProductionCli(
  args: string[],
  options: { cwd?: string } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
}

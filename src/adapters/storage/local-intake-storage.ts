import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IntakeStorage, RunFiles } from "../../core/ports/intake-storage.js";

export class LocalIntakeStorage implements IntakeStorage {
  async readUtf8(absolutePath: string): Promise<string> {
    return readFile(absolutePath, "utf8");
  }

  async createRun(projectRoot: string, runId: string, files: RunFiles): Promise<string> {
    const canonicalRoot = await realpath(projectRoot);
    const runsRoot = path.resolve(canonicalRoot, ".nodulus", "runs");
    if (!isInside(canonicalRoot, runsRoot)) throw new Error("Run directory must remain inside project root.");
    await mkdir(runsRoot, { recursive: true });
    const actualRunsRoot = await realpath(runsRoot);
    if (!isInside(canonicalRoot, actualRunsRoot)) throw new Error("Run storage must remain inside project root.");
    const runDirectory = path.join(runsRoot, runId);
    await mkdir(runDirectory);
    try {
      for (const [relativePath, contents] of Object.entries(files)) {
        const target = path.resolve(runDirectory, relativePath);
        if (!isInside(runDirectory, target)) throw new Error(`Run file path escapes the run directory: ${relativePath}`);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents, { encoding: "utf8", flag: "wx" });
      }
    } catch (error) {
      // A partially written intake is never advertised as a run. Best-effort cleanup
      // is deliberately local to the newly generated, exclusively named run folder.
      await rm(runDirectory, { recursive: true, force: true });
      throw error;
    }
    return runDirectory;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

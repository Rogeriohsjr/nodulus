import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

  async readRunFile(projectRoot: string, runId: string, relativePath: string): Promise<string> {
    const runDirectory = await resolveRunDirectory(projectRoot, runId);
    const target = resolveRunFile(runDirectory, relativePath);
    return readFile(target, "utf8");
  }

  async writeRunFiles(projectRoot: string, runId: string, files: RunFiles): Promise<void> {
    const runDirectory = await resolveRunDirectory(projectRoot, runId);
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = resolveRunFile(runDirectory, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    }
  }
}

async function resolveRunDirectory(projectRoot: string, runId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(runId)) throw new Error("Run ID is invalid.");
  const root = await realpath(projectRoot);
  const runDirectory = path.resolve(root, ".nodulus", "runs", runId);
  if (!isInside(root, runDirectory)) throw new Error("Run directory escapes the project root.");
  const actual = await realpath(runDirectory);
  if (!isInside(root, actual)) throw new Error("Run directory escapes the project root.");
  return actual;
}

function resolveRunFile(runDirectory: string, relativePath: string): string {
  const target = path.resolve(runDirectory, relativePath);
  if (!isInside(runDirectory, target)) throw new Error("Run file path escapes the run directory.");
  return target;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

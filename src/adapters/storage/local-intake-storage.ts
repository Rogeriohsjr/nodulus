import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { IntakeStorage, RunFiles } from "../../core/ports/intake-storage.js";
import { NodulusError } from "../../core/shared/nodulus-error.js";

export class LocalIntakeStorage implements IntakeStorage {
  async acquireRunLock(projectRoot: string, runId: string) {
    const runDirectory = await resolveRunDirectory(projectRoot, runId);
    const lockPath = path.join(runDirectory, ".resume.lock");
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx");
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8"); }
      finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockContents = await readFile(lockPath, "utf8").catch(() => "");
      let ownerPid: number | undefined;
      try {
        const value = JSON.parse(lockContents) as { pid?: unknown };
        if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) ownerPid = value.pid;
      } catch { /* partial or malformed lock is conservatively treated as owned */ }
      if (ownerPid !== undefined && !isProcessAlive(ownerPid)) {
        throw new NodulusError("RUN_RECOVERY_REQUIRED", `Run '${runId}' has a stale resume lock; inspect its checkpoint and attempts, then remove '${lockPath}' manually only after deciding recovery is safe.`);
      }
      throw new NodulusError("RUN_LOCKED", `Run '${runId}' is locked by another or unreadable resume owner${ownerPid ? ` (process ${ownerPid})` : ""}.`);
    }
    return {
      async release() {
        const current = await readFile(lockPath, "utf8").catch(() => "");
        try {
          const value = JSON.parse(current) as { token?: unknown };
          if (value.token === token) await rm(lockPath, { force: true });
        } catch { /* do not remove a lock whose ownership cannot be verified */ }
      },
    };
  }

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
      await renameWithWindowsShareRetry(temporary, target);
    }
  }
}

const windowsRenameRetryBudgetMs = 1000;
const windowsRenameRetryDelayMs = 25;
const windowsShareErrorCodes = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWithWindowsShareRetry(temporary: string, target: string): Promise<void> {
  let renameAttempts = 0;
  let initialError: unknown;
  renameAttempts += 1;
  try {
    await rename(temporary, target);
    return;
  } catch (error) {
    initialError = error;
    const initialFailureAt = performance.now();
    if (process.platform !== "win32") throw error;
    if (!isWindowsShareError(error)) {
      throwWithWindowsRenameDiagnostic(error, {
        phase: "initial_ineligible",
        renameAttempts,
        elapsedMs: performance.now() - initialFailureAt,
        budgetMs: windowsRenameRetryBudgetMs,
        initialCode: errorCode(error),
      });
    }

    const deadline = performance.now() + windowsRenameRetryBudgetMs;
    let inspectionCode: string | undefined;
    let lastRetryCode: string | undefined;
    let targetKind: string | undefined;
    while (performance.now() < deadline) {
      let targetStat;
      try {
        targetStat = await stat(target);
      } catch (inspectionError) {
        inspectionCode = errorCode(inspectionError);
        if (inspectionCode !== "ENOENT") {
          await removeOwnedTemporary(temporary);
          throwWithWindowsRenameDiagnostic(initialError, {
            phase: "inspection_failed",
            renameAttempts,
            elapsedMs: performance.now() - initialFailureAt,
            budgetMs: windowsRenameRetryBudgetMs,
            initialCode: errorCode(initialError),
            inspectionCode,
            ...(lastRetryCode === undefined ? {} : { lastRetryCode }),
            ...(targetKind === undefined ? {} : { targetKind }),
          });
        }
        targetKind = "missing";
      }

      if (targetStat) {
        targetKind = targetStat.isDirectory() ? "directory" : targetStat.isFile() ? "file" : "other";
        if (targetKind !== "file") {
          await removeOwnedTemporary(temporary);
          throwWithWindowsRenameDiagnostic(initialError, {
            phase: "target_not_file",
            renameAttempts,
            elapsedMs: performance.now() - initialFailureAt,
            budgetMs: windowsRenameRetryBudgetMs,
            initialCode: errorCode(initialError),
            ...(inspectionCode === undefined ? {} : { inspectionCode }),
            ...(lastRetryCode === undefined ? {} : { lastRetryCode }),
            targetKind,
          });
        }
      }

      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await delay(Math.min(windowsRenameRetryDelayMs, remaining));
      if (performance.now() >= deadline) break;
      renameAttempts += 1;
      try {
        await rename(temporary, target);
        return;
      } catch (retryError) {
        lastRetryCode = errorCode(retryError);
        if (!isWindowsShareError(retryError)) {
          await removeOwnedTemporary(temporary);
          throwWithWindowsRenameDiagnostic(retryError, {
            phase: "retry_ineligible",
            renameAttempts,
            elapsedMs: performance.now() - initialFailureAt,
            budgetMs: windowsRenameRetryBudgetMs,
            initialCode: errorCode(initialError),
            ...(inspectionCode === undefined ? {} : { inspectionCode }),
            lastRetryCode,
            ...(targetKind === undefined ? {} : { targetKind }),
          });
        }
      }
    }

    await removeOwnedTemporary(temporary);
    throwWithWindowsRenameDiagnostic(initialError, {
      phase: "budget_exhausted",
      renameAttempts,
      elapsedMs: performance.now() - initialFailureAt,
      budgetMs: windowsRenameRetryBudgetMs,
      initialCode: errorCode(initialError),
      ...(inspectionCode === undefined ? {} : { inspectionCode }),
      ...(lastRetryCode === undefined ? {} : { lastRetryCode }),
      ...(targetKind === undefined ? {} : { targetKind }),
    });
  }
}

type WindowsRenameDiagnostic = {
  phase: string;
  renameAttempts: number;
  elapsedMs: number;
  budgetMs: number;
  initialCode: string;
  inspectionCode?: string;
  lastRetryCode?: string;
  targetKind?: string;
};

function throwWithWindowsRenameDiagnostic(error: unknown, diagnostic: WindowsRenameDiagnostic): never {
  if (error instanceof Error && !error.message.includes("[windowsAtomicRename=")) {
    error.message = `${error.message} [windowsAtomicRename=${JSON.stringify(diagnostic)}]`;
  }
  throw error;
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function isWindowsShareError(error: unknown): boolean {
  return process.platform === "win32" && error !== null && typeof error === "object" &&
    "code" in error && typeof error.code === "string" && windowsShareErrorCodes.has(error.code);
}

async function removeOwnedTemporary(temporary: string): Promise<void> {
  try { await rm(temporary, { force: true }); }
  catch { /* preserve the original rename or inspection error */ }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
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

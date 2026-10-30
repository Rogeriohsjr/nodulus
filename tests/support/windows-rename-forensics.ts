import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import type { IntakeStorage, RunFiles } from "../../src/core/ports/intake-storage.js";

export type WindowsRenameForensicReport = {
  runId: string;
  target: string;
  status: "unavailable" | "available";
  reason?: string;
  observedFailure?: { code: string | null; message: string };
  targetEvidence?: { sha256: string; type: string; attributes: number; size?: number; owner?: string | null; aclSha256?: string | null };
  deleteAccessProbe?: { win32ErrorCode: number };
  restartManager?: { processes: Array<{ pid: number; applicationName?: string; processStartFileTime?: string }> };
  temporaryEvidence?: Array<{ exists: boolean; type?: string; size?: number; sha256?: string }>;
  queryError?: string;
};

export type WindowsRenameForensicStorage = {
  storage: IntakeStorage;
  reports: WindowsRenameForensicReport[];
  probeProcessId?: number;
  close(): Promise<void>;
};

/**
 * Decorates LocalIntakeStorage with a bounded, read-only Windows evidence probe.
 */
export async function createWindowsRenameForensicStorage(
  projectRoot: string,
  reportDirectory: string,
): Promise<WindowsRenameForensicStorage> {
  const root = path.resolve(projectRoot);
  const reportRoot = path.resolve(reportDirectory);
  if (!isInside(root, reportRoot)) throw new Error("Windows forensic report directory must stay inside the owned project.");
  mkdirSync(reportRoot, { recursive: true });

  const actual = new LocalIntakeStorage();
  const reports: WindowsRenameForensicReport[] = [];
  const helper = process.platform === "win32" ? await startForensicHelper(root, reportRoot) : undefined;
  const storage: IntakeStorage = {
    readUtf8: (absolutePath) => actual.readUtf8(absolutePath),
    createRun: (project, runId, files) => actual.createRun(project, runId, files),
    readRunFile: (project, runId, relativePath) => actual.readRunFile(project, runId, relativePath),
    async writeRunFiles(project, runId, files: RunFiles) {
      try {
        await actual.writeRunFiles(project, runId, files);
      } catch (error) {
        const target = path.resolve(project, ".nodulus", "runs", runId, "run.json");
        if (process.platform === "win32" && path.resolve(project) === root && Object.hasOwn(files, "run.json") && isTargetRenameFailure(error, target)) {
          const runDirectory = path.dirname(target);
          const temporaryPaths = findOwnedTemporaryPaths(runDirectory, target, error);
          let report: WindowsRenameForensicReport = {
            runId,
            target,
            status: "unavailable",
            observedFailure: {
              code: errorCode(error),
              message: error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200),
            },
          };
          try {
            if (!helper) throw new Error("Prewarmed PowerShell forensic helper is unavailable.");
            const evidence = await helper.query({ projectRoot: root, runId, runDirectory, target, temporaryPaths });
            report = { ...report, ...evidence, runId, target };
            if (report.status === "unavailable") {
              report.reason = [report.reason, report.queryError].filter(Boolean).join(": ").slice(0, 1200) || "forensic query unavailable";
            }
          } catch (probeError) {
            report.queryError = boundedError(probeError);
            report.reason = `forensic query unavailable: ${report.queryError}`.slice(0, 1200);
          }
          reports.push(report);
          persistBoundedReport(reportRoot, report);
        }
        throw error;
      }
    },
    ...(actual.acquireRunLock === undefined ? {} : {
      acquireRunLock: (project, runId) => actual.acquireRunLock!(project, runId),
    }),
  };

  return { storage, reports, ...(helper === undefined ? {} : { probeProcessId: helper.pid }), close: async () => { if (helper) await helper.close(); } };
}

type ForensicQuery = { projectRoot: string; runId: string; runDirectory: string; target: string; temporaryPaths: string[] };
type ForensicHelper = { pid: number; stateDirectory: string; query(input: ForensicQuery): Promise<WindowsRenameForensicReport>; close(): Promise<void> };

const powershell = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const helperScript = fileURLToPath(new URL("../fixtures/par-windows-file-forensics.ps1", import.meta.url));
const startupTimeoutMs = 10_000;
const queryTimeoutMs = 2_000;
const shutdownTimeoutMs = 4_000;
const terminationConfirmMs = 2_000;
const helperLifetimeMs = 60_000;

async function startForensicHelper(projectRoot: string, reportRoot: string): Promise<ForensicHelper> {
  const stateDirectory = path.join(reportRoot, `.helper-${randomUUID()}`);
  mkdirSync(stateDirectory, { recursive: true });
  const readyPath = path.join(stateDirectory, "ready.json");
  const shutdownPath = path.join(stateDirectory, "shutdown");
  const child = spawn(powershell, [
    "-NoProfile", "-NonInteractive", "-File", helperScript,
    "-ProjectRoot", projectRoot,
    "-StateDirectory", stateDirectory,
    "-ReadyPath", readyPath,
    "-ShutdownPath", shutdownPath,
    "-ParentLifetimeMilliseconds", String(helperLifetimeMs),
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;

  let stdout = "";
  let stderr = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: unknown;
  child.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-1200); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1200); });
  child.once("error", (error) => { spawnError = error; });
  const exited = new Promise<void>((resolve) => child.once("close", (code, signal) => { exit = { code, signal }; resolve(); }));

  try {
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Forensic PowerShell process did not expose an owned PID.");
    const startupDeadline = Date.now() + startupTimeoutMs;
    while (!existsSync(readyPath)) {
      if (spawnError !== undefined) throw new Error(`Could not start forensic PowerShell helper: ${boundedError(spawnError)}`);
      if (exit !== undefined) throw new Error(`Forensic PowerShell exited before ready (code=${String(exit.code)}, signal=${String(exit.signal)}); stderr=${stderr}`);
      if (Date.now() >= startupDeadline) throw new Error(`Forensic PowerShell readiness exceeded ${startupTimeoutMs} ms; stderr=${stderr}`);
      await delay(20);
    }
    const ready = JSON.parse(readFileSync(readyPath, "utf8")) as { pid?: unknown; ready?: unknown };
    if (ready.pid !== pid || ready.ready !== true || !isProcessAlive(pid)) throw new Error(`Forensic PowerShell readiness marker did not verify owned PID ${pid}.`);
  } catch (startupError) {
    const reason = boundedError(startupError);
    try { await stopOwnedHelper(child, pid, exited, () => exit, shutdownPath, stateDirectory); }
    catch (cleanupError) { throw new Error(`Forensic helper startup failed: ${reason}; ${boundedError(cleanupError)}; retaining '${stateDirectory}'.`); }
    rmSync(stateDirectory, { recursive: true, force: true });
    throw new Error(`Forensic helper startup failed: ${reason}; owned process stopped.`);
  }

  let closed = false;
  return {
    pid,
    stateDirectory,
    async query(input) {
      if (closed || exit !== undefined) throw new Error(`Forensic PowerShell helper PID ${pid} is not running.`);
      const id = randomUUID();
      const requestPath = path.join(stateDirectory, `request-${id}.json`);
      const responsePath = path.join(stateDirectory, `response-${id}.json`);
      validateQueryPaths(projectRoot, input);
      const requestTemporary = `${requestPath}.${randomUUID()}.tmp`;
      writeFileSync(requestTemporary, JSON.stringify({ ...input, id, responsePath }), { encoding: "utf8", flag: "wx" });
      renameSync(requestTemporary, requestPath);
      const deadline = Date.now() + queryTimeoutMs;
      while (!existsSync(responsePath)) {
        if (exit !== undefined) throw new Error(`Forensic PowerShell exited during query (code=${String(exit.code)}, signal=${String(exit.signal)}); stderr=${stderr}`);
        if (Date.now() >= deadline) throw new Error(`Forensic PowerShell query exceeded ${queryTimeoutMs} ms; stderr=${stderr}`);
        await delay(10);
      }
      let report: WindowsRenameForensicReport;
      try { report = JSON.parse(readFileSync(responsePath, "utf8")) as WindowsRenameForensicReport; }
      finally { rmSync(responsePath, { force: true }); }
      if (report.runId !== input.runId || realpathSync.native(report.target) !== realpathSync.native(input.target)) {
        throw new Error(`Forensic response identity mismatch for run '${input.runId}'.`);
      }
      if (report.status !== "available" && !report.reason) report.reason = "probe reported unavailable";
      return report;
    },
    async close() {
      if (closed) return;
      writeFileSync(shutdownPath, "shutdown\n", { encoding: "utf8", flag: "wx" });
      await stopOwnedHelper(child, pid, exited, () => exit, shutdownPath, stateDirectory);
      closed = true;
      rmSync(stateDirectory, { recursive: true, force: true });
    },
  };
}

function validateQueryPaths(projectRoot: string, input: ForensicQuery): void {
  const root = path.resolve(projectRoot);
  const runDirectory = path.resolve(input.runDirectory);
  const expectedRunRoot = path.resolve(root, ".nodulus", "runs");
  const target = path.resolve(input.target);
  if (!isInside(root, runDirectory) || !isInside(expectedRunRoot, runDirectory)) throw new Error("Forensic run directory escaped owned run storage.");
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.runId)) throw new Error("Forensic run ID was invalid.");
  if (runDirectory !== path.resolve(expectedRunRoot, input.runId)) throw new Error("Forensic run directory did not match its run ID.");
  if (target !== path.resolve(runDirectory, "run.json")) throw new Error("Forensic target was not the exact run.json checkpoint.");
  for (const temporary of input.temporaryPaths) {
    if (path.dirname(path.resolve(temporary)) !== runDirectory || !/^run\.json\.[0-9a-f-]{36}\.tmp$/i.test(path.basename(temporary))) {
      throw new Error("Forensic temporary path was not an owned sibling checkpoint temporary.");
    }
  }
}

function findOwnedTemporaryPaths(runDirectory: string, target: string, error: unknown): string[] {
  if (!/^[0-9a-f-]{36}$/i.test(path.basename(path.dirname(target)))) return [];
  const paths = new Set<string>();
  try {
    for (const name of readdirSync(runDirectory)) if (/^run\.json\.[0-9a-f-]{36}\.tmp$/i.test(name)) paths.add(path.join(runDirectory, name));
  } catch { /* absent/unreadable sibling set is reported as unavailable by the helper */ }
  if (error instanceof Error) {
    const match = error.message.match(/rename ['"](.+?)['"] -> ['"](.+?)['"]/i);
    if (match && path.resolve(match[2]) === path.resolve(target) && path.dirname(path.resolve(match[1])) === path.resolve(runDirectory) && /^run\.json\.[0-9a-f-]{36}\.tmp$/i.test(path.basename(match[1]))) paths.add(path.resolve(match[1]));
  }
  return [...paths];
}

function persistBoundedReport(reportRoot: string, report: WindowsRenameForensicReport): void {
  const reportPath = path.join(reportRoot, `run-${report.runId}-${randomUUID()}.json`);
  try { writeFileSync(reportPath, JSON.stringify(report), { encoding: "utf8", flag: "wx" }); }
  catch { /* optional evidence persistence never replaces the original storage exception */ }
}

async function stopOwnedHelper(
  child: ReturnType<typeof spawn>,
  pid: number | undefined,
  exited: Promise<void>,
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | undefined,
  shutdownPath: string,
  stateDirectory: string,
): Promise<void> {
  if (getExit() === undefined && existsSync(stateDirectory)) {
    try { writeFileSync(shutdownPath, "shutdown\n", { encoding: "utf8", flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!await waitForExit(exited, shutdownTimeoutMs)) {
    child.kill();
    if (!await waitForExit(exited, terminationConfirmMs)) throw new Error(`Could not confirm owned helper exit within ${shutdownTimeoutMs}+${terminationConfirmMs} ms.`);
  }
  if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) throw new Error(`Owned helper PID ${pid} may still be alive.`);
  const exit = getExit();
  if (!exit || exit.code !== 0 || exit.signal !== null) throw new Error(`Owned helper ended abnormally (code=${String(exit?.code)}, signal=${String(exit?.signal)}).`);
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1200);
}

function isTargetRenameFailure(error: unknown, target: string): boolean {
  if (errorCode(error) !== "EPERM" || !(error instanceof Error)) return false;
  try {
    const physicalTarget = realpathSync.native(target).toLowerCase();
    const message = error.message.toLowerCase();
    return message.includes(`-> '${physicalTarget}'`) || message.includes(`-> "${physicalTarget}"`);
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ChildClose = { code: number | null; signal: NodeJS.Signals | null };
export type WindowsProcessPinReady = { helperPid: number; rootPid: number; handlePid: number; exitCode: 259; nonce: string };
export type WindowsProcessPinExit = { helperPid: number; rootPid: number; handlePid: number; exitCode: number; nonce: string };

export type WindowsProcessPin = {
  readonly controlDirectory: string;
  readonly targetPid: number;
  readonly nonce: string;
  readonly helperPid: number | undefined;
  readonly requestSent: boolean;
  readonly pinReady: boolean;
  readonly handleHeld: boolean;
  acquire(deadline: number): Promise<WindowsProcessPinReady>;
  waitForTargetExit(deadline: number): Promise<WindowsProcessPinExit>;
  releaseAfterTargetExit(deadline: number): Promise<void>;
  stopBeforePin(deadline: number): Promise<void>;
  abortUnverified(deadline: number): Promise<void>;
  diagnostics(): string;
};

export type WindowsProcessPinOptions = { controlDirectory: string; targetPid: number; watchdogMs: number };
type ChildError = { name: string; message: string };
type Marker = Record<string, unknown>;

const pinScript = fileURLToPath(new URL("../fixtures/par-015-process-handle-pin.ps1", import.meta.url));
const maxCapturedOutputBytes = 8192;
const maxMarkerBytes = 2048;

/** Start an explicit, caller-owned PowerShell process pin. Importing this module starts no processes. */
export function startWindowsProcessPin(options: WindowsProcessPinOptions): WindowsProcessPin {
  if (process.platform !== "win32") throw new Error("Windows process pins are available only on Windows.");
  if (!path.isAbsolute(options.controlDirectory) || !Number.isSafeInteger(options.targetPid) || options.targetPid <= 0
    || !Number.isSafeInteger(options.watchdogMs) || options.watchdogMs <= 0) {
    throw new Error("Windows process pin requires an absolute control directory, safe PID and positive watchdog.");
  }

  const nonce = randomUUID();
  let child: ChildProcess | undefined;
  let childPid: number | undefined;
  let spawnError: ChildError | undefined;
  let setupError: ChildError | undefined;
  let childEventError: ChildError | undefined;
  let stdinError: ChildError | undefined;
  let closedResult: ChildClose | undefined;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverflow = false;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let requestSent = false;
  let pinReady = false;
  let handleHeld = false;
  let aborted = false;
  let targetExit: WindowsProcessPinExit | undefined;
  let resolveClosed = (_result: ChildClose): void => undefined;
  const closed = new Promise<ChildClose>((resolve) => { resolveClosed = resolve; });

  const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
    if (target === "stdout") stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    if (stdoutBytes + stderrBytes > maxCapturedOutputBytes) {
      outputOverflow = true;
      return;
    }
    (target === "stdout" ? stdoutChunks : stderrChunks).push(Buffer.from(chunk));
  };

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  try {
    if (typeof systemRoot !== "string" || systemRoot.length === 0) throw new Error("Windows system directory is unavailable.");
    mkdirSync(options.controlDirectory, { recursive: false });
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    child = spawn(powershell, [
      "-NoProfile", "-NonInteractive", "-File", pinScript,
      "-ControlDirectory", options.controlDirectory,
      "-Nonce", nonce,
      "-WatchdogMilliseconds", String(options.watchdogMs),
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.once("error", (error: Error) => {
      childEventError = boundedError(error);
      spawnError = childEventError;
    });
    child.once("exit", () => { handleHeld = false; });
    child.once("close", (code, signal) => {
      closedResult = { code, signal };
      handleHeld = false;
      resolveClosed(closedResult);
    });
    child.stdin?.once("error", (error: Error) => { stdinError = boundedError(error); });
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    if (typeof child.pid === "number" && Number.isSafeInteger(child.pid) && child.pid > 0) childPid = child.pid;
    else setupError = { name: "Error", message: "PowerShell process did not expose a safe PID." };
    child.stdin?.end();
  } catch (error) {
    setupError = boundedError(error);
    if (child === undefined) {
      closedResult = { code: null, signal: null };
      resolveClosed(closedResult);
    }
  }

  function diagnostics(): string {
    const detail = {
      control: path.basename(options.controlDirectory), targetPid: options.targetPid, helperPid: childPid ?? null, nonce,
      requestSent, pinReady, handleHeld, aborted, spawnError: spawnError ?? null, setupError: setupError ?? null,
      childEventError: childEventError ?? null, stdinError: stdinError ?? null, closed: closedResult ?? null,
      outputOverflow, stdoutBytes, stderrBytes,
      stdout: Buffer.concat(stdoutChunks).toString("utf8").slice(0, 1600),
      stderr: Buffer.concat(stderrChunks).toString("utf8").slice(0, 1600),
    };
    try { return JSON.stringify(detail); }
    catch { return "Windows process pin diagnostic serialization failed."; }
  }

  async function acquire(deadline: number): Promise<WindowsProcessPinReady> {
    throwIfSetupFailed();
    const helperReady = await waitForMarker("helper-ready.json", deadline, "helper startup");
    assertIdentity(helperReady, "helper-ready", { pid: childPid, nonce });
    writeMarker("pin-request.json", { rootPid: options.targetPid, nonce });
    requestSent = true;
    const ready = await waitForMarker("pin-ready.json", deadline, "native target pin readiness");
    assertIdentity(ready, "pin-ready", { helperPid: childPid, rootPid: options.targetPid, handlePid: options.targetPid, exitCode: 259, nonce });
    if (!helperIsLive()) throw new Error(`Windows process pin helper exited before its native handle could be retained. ${diagnostics()}`);
    pinReady = true;
    handleHeld = true;
    return ready as unknown as WindowsProcessPinReady;
  }

  async function waitForTargetExit(deadline: number): Promise<WindowsProcessPinExit> {
    if (!pinReady || !handleHeld || !helperIsLive()) throw new Error(`Cannot wait without a currently held Windows process handle. ${diagnostics()}`);
    if (targetExit) return targetExit;
    const exited = await waitForMarker("root-exited.json", deadline, "native target exit");
    assertIdentity(exited, "root-exited", { helperPid: childPid, rootPid: options.targetPid, handlePid: options.targetPid, nonce });
    if (!handleHeld || !helperIsLive()) throw new Error(`Windows pin helper exited before native target exit evidence was verified. ${diagnostics()}`);
    if (!Number.isSafeInteger(exited.exitCode) || exited.exitCode === 259) throw new Error(`Pinned Windows target exit code is invalid. ${diagnostics()}`);
    targetExit = exited as unknown as WindowsProcessPinExit;
    return targetExit;
  }

  async function releaseAfterTargetExit(deadline: number): Promise<void> {
    if (!targetExit || !handleHeld || !helperIsLive()) throw new Error(`Cannot release a Windows process handle before native target exit is verified while the handle is held. ${diagnostics()}`);
    handleHeld = false;
    const releasePath = path.join(options.controlDirectory, "release-pin");
    if (!existsSync(releasePath)) writeMarker("release-pin", { nonce });
    const closedMarker = await waitForMarker("helper-closed.json", deadline, "native handle close evidence", false);
    assertIdentity(closedMarker, "helper-closed", {
      pid: childPid, rootPid: options.targetPid, rootExitCode: targetExit.exitCode, handleClosed: true, nonce,
    });
    const processClose = await waitForChildClose(deadline, "PowerShell pin helper close");
    assertCleanChildClose(processClose);
  }

  async function stopBeforePin(deadline: number): Promise<void> {
    if (pinReady) throw new Error(`A verified native process pin cannot be stopped before its target exit. ${diagnostics()}`);
    if (child === undefined) return;
    if (!helperIsLive()) {
      const processClose = closedResult ?? await waitForChildClose(deadline, "already-exited PowerShell pin helper close");
      assertCleanChildClose(processClose);
      return;
    }
    if (!requestSent) {
      writeMarker("stop-helper", { nonce });
      const stopped = await waitForMarker("helper-stopped.json", deadline, "cooperative pre-pin stop");
      assertIdentity(stopped, "helper-stopped", { pid: childPid, nonce });
      const closedMarker = await waitForMarker("helper-closed.json", deadline, "pre-pin helper close evidence", false);
      assertIdentity(closedMarker, "helper-closed", { pid: childPid, rootPid: 0, handleClosed: true, nonce, stoppedWithoutPin: true });
      assertCleanChildClose(await waitForChildClose(deadline, "pre-pin PowerShell helper close"));
      return;
    }
    while (true) {
      if (existsSync(path.join(options.controlDirectory, "helper-error.json"))) {
        const helperError = readMarker("helper-error.json");
        assertIdentity(helperError, "helper-error", { pid: childPid, rootPid: options.targetPid, nonce });
        const releasePath = path.join(options.controlDirectory, "release-pin");
        if (!existsSync(releasePath)) writeMarker("release-pin", { nonce });
        const closedMarker = await waitForMarker("helper-closed.json", deadline, "failed-acquisition helper close evidence", false);
        assertIdentity(closedMarker, "helper-closed", { pid: childPid, rootPid: options.targetPid, handleClosed: true, nonce });
        assertCleanChildClose(await waitForChildClose(deadline, "failed-acquisition PowerShell helper close"));
        return;
      }
      if (existsSync(path.join(options.controlDirectory, "root-exited.json"))) {
        const exited = readMarker("root-exited.json");
        assertIdentity(exited, "root-exited", { helperPid: childPid, rootPid: options.targetPid, handlePid: options.targetPid, nonce });
        if (!Number.isSafeInteger(exited.exitCode) || exited.exitCode === 259) throw new Error(`Unverified Windows process pin reported an invalid exit code. ${diagnostics()}`);
        const releasePath = path.join(options.controlDirectory, "release-pin");
        if (!existsSync(releasePath)) writeMarker("release-pin", { nonce });
        const closedMarker = await waitForMarker("helper-closed.json", deadline, "late acquisition helper close evidence", false);
        assertIdentity(closedMarker, "helper-closed", { pid: childPid, rootPid: options.targetPid, rootExitCode: exited.exitCode, handleClosed: true, nonce });
        assertCleanChildClose(await waitForChildClose(deadline, "late acquisition PowerShell helper close"));
        return;
      }
      if (existsSync(path.join(options.controlDirectory, "helper-closed.json"))) {
        assertCleanChildClose(await waitForChildClose(deadline, "unverified-acquisition PowerShell helper close"));
        return;
      }
      if (closedResult) {
        assertCleanChildClose(closedResult);
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Cannot stop a pin helper after a request without target-exit or helper-error evidence. ${diagnostics()}`);
      await delay(Math.min(10, remaining));
    }
  }

  async function abortUnverified(deadline: number): Promise<void> {
    handleHeld = false;
    aborted = true;
    if (child === undefined || closedResult) return;
    let killError: unknown;
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); }
      catch (error) { killError = error; }
    }
    let closeResult: ChildClose;
    try { closeResult = await waitForChildClose(deadline, "aborted unverified PowerShell helper close"); }
    catch (error) {
      if (killError !== undefined) throw new AggregateError([boundedError(killError), boundedError(error)], `Could not abort and close the owned pin helper. ${diagnostics()}`);
      throw error;
    }
    if (killError !== undefined) throw new Error(`Owned pin helper abort failed after close ${closeResult.code ?? closeResult.signal ?? "unknown"}. ${diagnostics()}`);
  }

  function throwIfSetupFailed(): void {
    if (setupError) throw new Error(`Windows process pin setup failed: ${setupError.message}. ${diagnostics()}`);
    if (spawnError) throw new Error(`Windows process pin spawn failed: ${spawnError.message}. ${diagnostics()}`);
    if (child === undefined) throw new Error(`Windows process pin has no owned helper object. ${diagnostics()}`);
  }

  function helperIsLive(): boolean {
    return child !== undefined && !closedResult && child.exitCode === null && child.signalCode === null;
  }

  function writeMarker(name: string, value: Record<string, unknown>): void {
    const file = path.join(options.controlDirectory, name);
    writeFileSync(file, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  }

  function readMarker(name: string): Marker {
    const file = path.join(options.controlDirectory, name);
    const info = statSync(file);
    if (!info.isFile() || info.size > maxMarkerBytes) throw new Error(`Windows process pin marker '${name}' is not a bounded regular file. ${diagnostics()}`);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`Windows process pin marker '${name}' is not an object. ${diagnostics()}`);
    return parsed as Marker;
  }

  function assertIdentity(actual: Marker, markerName: string, expected: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) throw new Error(`Windows process pin ${markerName} identity mismatch at '${key}'. ${diagnostics()}`);
    }
  }

  async function waitForMarker(name: string, deadline: number, description: string, failOnHelperError = true): Promise<Marker> {
    const file = path.join(options.controlDirectory, name);
    while (true) {
      if (existsSync(file)) return readMarker(name);
      if (failOnHelperError && existsSync(path.join(options.controlDirectory, "helper-error.json"))) {
        const failure = readMarker("helper-error.json");
        assertIdentity(failure, "helper-error", { pid: childPid, rootPid: options.targetPid, nonce });
        throw new Error(`Windows process pin helper reported failure: ${safeString(failure.message)}. ${diagnostics()}`);
      }
      if (closedResult) throw new Error(`Windows process pin helper closed before ${description}. ${diagnostics()}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Windows process pin deadline expired waiting for ${description}. ${diagnostics()}`);
      await delay(Math.min(10, remaining));
    }
  }

  async function waitForChildClose(deadline: number, description: string): Promise<ChildClose> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Windows process pin deadline expired before ${description}. ${diagnostics()}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Windows process pin deadline expired during ${description}. ${diagnostics()}`)), remaining);
        }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  function assertCleanChildClose(result: ChildClose): void {
    if (spawnError || setupError || childEventError || stdinError || outputOverflow || result.code !== 0 || result.signal !== null) {
      throw new Error(`Windows process pin helper did not close cleanly. ${diagnostics()}`);
    }
  }

  return {
    controlDirectory: options.controlDirectory,
    targetPid: options.targetPid,
    nonce,
    get helperPid() { return childPid; },
    get requestSent() { return requestSent; },
    get pinReady() { return pinReady; },
    get handleHeld() { return handleHeld && helperIsLive(); },
    acquire,
    waitForTargetExit,
    releaseAfterTargetExit,
    stopBeforePin,
    abortUnverified,
    diagnostics,
  };
}

function boundedError(error: unknown): ChildError {
  try {
    if (error instanceof Error) return { name: error.name.slice(0, 64), message: error.message.slice(0, 800) };
    return { name: "UnknownError", message: "Windows process pin failed with a non-Error value." };
  } catch { return { name: "UnknownError", message: "Windows process pin error could not be read safely." }; }
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 800) : "unavailable error detail";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

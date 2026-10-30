import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { errorMonitor } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { runProcess, type ProcessResult } from "../../src/adapters/providers/process-runner.js";
import { ProcessArtifactValidator } from "../../src/adapters/validation/process-artifact-validator.js";

type AdapterMode = "provider" | "validator";
type TestMode = { adapter: AdapterMode; cancel: boolean };
type AdapterSettlement = { kind: "result"; value: ProcessResult | Awaited<ReturnType<ProcessArtifactValidator["execute"]>>; settledAt: number; descendantAliveAtReturn?: boolean; rootExitCodeAtReturn?: number | null; pinHelperAliveAtReturn?: boolean; helperClosedAtReturn?: boolean }
  | { kind: "rejection"; error: unknown; settledAt: number; descendantAliveAtReturn?: boolean; rootExitCodeAtReturn?: number | null; pinHelperAliveAtReturn?: boolean; helperClosedAtReturn?: boolean };
type NativeChildRecord = {
  kind: "root" | "taskkill";
  pid?: number;
  executable?: string;
  fixturePath?: string;
  childParentPid: number;
  spawnedAt?: number;
  exitedAt?: number;
  closedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  taskkillPid?: number;
  taskkillTree?: boolean;
  taskkillForce?: boolean;
  errorName?: string;
};
type PinHelper = { child: ChildProcess; pid: number; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; diagnostics(): string };
type RootStartedMarker = { pid: number; nonce: string; mode: string };
type RootReadyMarker = { pid: number; descendantPid: number; nonce: string; mode: string };
type PinMarker = { helperPid: number; rootPid: number; handlePid: number; exitCode: number; nonce: string };

const label = "par-015-exited-root-";
const adapterTimeoutMs = 10_000;
const helperWatchdogMs = 60_000;
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 35_000;
const powershell = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const rootFixture = fileURLToPath(new URL("../fixtures/par-015-exited-root.mjs", import.meta.url));
const pinFixture = fileURLToPath(new URL("../fixtures/par-015-process-handle-pin.ps1", import.meta.url));
test.skipIf(process.platform !== "win32")("P15 exited-root provider cancellation preserves the pinned natural exit", async () => runScenario({ adapter: "provider", cancel: true }), testCeilingMs);
test.skipIf(process.platform !== "win32")("P15 exited-root validator cancellation preserves the pinned natural exit", async () => runScenario({ adapter: "validator", cancel: true }), testCeilingMs);
test.skipIf(process.platform !== "win32")("P15 exited-root provider natural completion has no cancellation", async () => runScenario({ adapter: "provider", cancel: false }), testCeilingMs);
test.skipIf(process.platform !== "win32")("P15 exited-root validator natural completion has no cancellation", async () => runScenario({ adapter: "validator", cancel: false }), testCeilingMs);

async function runScenario({ adapter, cancel }: TestMode): Promise<void> {
  const project = mkdtempSync(path.join(os.tmpdir(), label));
  const ownedProject = realpathSync.native(project);
  assertOwnedProject(project, ownedProject);
  const controlDirectory = path.join(project, ".nodulus", "fixtures", "par-015-exited-root");
  mkdirSync(controlDirectory, { recursive: true });
  const nonce = randomUUID();
  const validatorRelative = ".nodulus/validators/par-015-exited-root.mjs";
  const validatorAbsolute = path.join(project, validatorRelative);
  let targetFixture = rootFixture;
  if (adapter === "validator") {
    mkdirSync(path.dirname(validatorAbsolute), { recursive: true });
    copyFileSync(rootFixture, validatorAbsolute);
    mkdirSync(path.join(project, ".nodulus", "fixtures"), { recursive: true });
    writeFileSync(path.join(project, ".nodulus", "fixtures", "exited-root-control.json"), JSON.stringify({ controlDirectory, nonce }), "utf8");
    targetFixture = validatorAbsolute;
  }

  const observer = observeNativeChildren([rootFixture, ...(adapter === "validator" ? [validatorAbsolute] : [])]);
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const controller = new AbortController();
  let pinHelper: PinHelper | undefined;
  let rootPid: number | undefined;
  let descendantPid: number | undefined;
  let rootExitObserved = false;
  let pinReady: PinMarker | undefined;
  let helperStopped = true;
  let settlement: AdapterSettlement | undefined;
  let adapterPromise: Promise<AdapterSettlement> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];
  const diagnostics = (): string => JSON.stringify({
    adapter, cancel, project, controlDirectory, rootPid: rootPid ?? null, descendantPid: descendantPid ?? null,
    rootExitObserved,
    rootExitCode: rootPid === undefined ? null : observer.records.find((record) => record.kind === "root" && record.pid === rootPid)?.exitCode ?? null,
    settlement: settlement === undefined ? null : settlement.kind === "result"
      ? { kind: settlement.kind, settledAt: settlement.settledAt, descendantAliveAtReturn: settlement.descendantAliveAtReturn, rootExitCodeAtReturn: settlement.rootExitCodeAtReturn }
      : { kind: settlement.kind, settledAt: settlement.settledAt, error: safeErrorText(settlement.error) },
    pinHelper: pinHelper?.diagnostics() ?? null,
    childProcesses: observer.records,
    markers: ["helper-ready.json", "root-started.json", "allow-descendant", "root-ready.json", "descendant-started.json", "descendant-exited.json", "pin-request.json", "pin-ready.json", "root-exited.json", "pin-watchdog-expired.json", "helper-error.json", "helper-stopped.json", "release-root", "release-descendant", "release-pin", "helper-closed.json"].map((name) => ({ name, present: existsSync(path.join(controlDirectory, name)) })),
  });

  try {
    pinHelper = startPinHelper(controlDirectory, nonce);
    helperStopped = false;
    await waitForJson(path.join(controlDirectory, "helper-ready.json"), scenarioDeadline, diagnostics);
    expect(readJson(path.join(controlDirectory, "helper-ready.json"))).toMatchObject({ pid: pinHelper.pid, nonce });

    const operation = adapter === "provider"
      ? runProcess(process.execPath, [rootFixture, "provider-root", controlDirectory, nonce], {
        cwd: process.cwd(), stdin: "", timeoutMs: adapterTimeoutMs, signal: controller.signal,
      })
      : new ProcessArtifactValidator().execute(project, validatorRelative, JSON.stringify({ text: "P15 validator fixture input" }), adapterTimeoutMs, controller.signal);
    adapterPromise = operation.then(
      (value) => {
        const firstExit = rootPid === undefined ? undefined : observer.records.find((record) => record.kind === "root" && record.pid === rootPid && record.exitedAt !== undefined);
        const result: AdapterSettlement = {
          kind: "result", value, settledAt: performance.now(),
          ...(descendantPid === undefined ? {} : { descendantAliveAtReturn: isProcessAlive(descendantPid) }),
          ...(firstExit === undefined ? {} : { rootExitCodeAtReturn: firstExit.exitCode }),
          ...(pinHelper === undefined ? {} : { pinHelperAliveAtReturn: isProcessAlive(pinHelper.pid), helperClosedAtReturn: existsSync(path.join(controlDirectory, "helper-closed.json")) }),
        };
        settlement = result;
        return result;
      },
      (error: unknown) => {
        const firstExit = rootPid === undefined ? undefined : observer.records.find((record) => record.kind === "root" && record.pid === rootPid && record.exitedAt !== undefined);
        const result: AdapterSettlement = {
          kind: "rejection", error, settledAt: performance.now(),
          ...(descendantPid === undefined ? {} : { descendantAliveAtReturn: isProcessAlive(descendantPid) }),
          ...(firstExit === undefined ? {} : { rootExitCodeAtReturn: firstExit.exitCode }),
          ...(pinHelper === undefined ? {} : { pinHelperAliveAtReturn: isProcessAlive(pinHelper.pid), helperClosedAtReturn: existsSync(path.join(controlDirectory, "helper-closed.json")) }),
        };
        settlement = result;
        return result;
      },
    );

    const rootMarker = await waitForJson<RootStartedMarker>(path.join(controlDirectory, "root-started.json"), scenarioDeadline, diagnostics);
    if (!Number.isSafeInteger(rootMarker.pid) || rootMarker.pid <= 0) {
      throw new Error(`Owned root fixture marker contained an invalid process identity. ${diagnostics()}`);
    }
    rootPid = rootMarker.pid;
    expect(rootMarker).toMatchObject({ nonce, mode: adapter });
    expect(rootPid).toBeGreaterThan(0);
    const observedRoot = await waitForObservedRoot(observer, targetFixture, scenarioDeadline, diagnostics);
    expect(observedRoot.pid).toBe(rootPid);
    expect(isProcessAlive(rootPid), "The actual root process must still be live before the handle is pinned.").toBe(true);
    if (!pinHelper) throw new Error("Native process-handle helper was not started.");
    writeAtomicJson(path.join(controlDirectory, "pin-request.json"), { rootPid, nonce });
    const pinCandidate = await waitForJson<PinMarker>(path.join(controlDirectory, "pin-ready.json"), scenarioDeadline, diagnostics);
    if (pinCandidate.helperPid !== pinHelper.pid || pinCandidate.rootPid !== rootPid || pinCandidate.handlePid !== rootPid || pinCandidate.exitCode !== 259 || pinCandidate.nonce !== nonce) {
      throw new Error(`Native process-handle marker did not match the requested live root and helper. ${diagnostics()}`);
    }
    if (!isProcessAlive(pinHelper.pid) || existsSync(path.join(controlDirectory, "helper-closed.json")) || existsSync(path.join(controlDirectory, "release-pin"))) {
      throw new Error(`Native process-handle helper was not live and unreleased at pin proof. ${diagnostics()}`);
    }
    if (!isProcessAlive(rootPid)) throw new Error(`Root PID ${rootPid} was not live after the native handle was acquired. ${diagnostics()}`);
    const pinnedRootRecord = observer.records.find((record) => record.kind === "root" && record.pid === rootPid && record.fixturePath === path.resolve(targetFixture).toLowerCase() && record.spawnedAt !== undefined);
    if (!pinnedRootRecord) throw new Error(`Native pin PID did not match an actually spawned ChildProcess record. ${diagnostics()}`);
    pinReady = pinCandidate;
    if (!isProcessAlive(pinHelper.pid) || existsSync(path.join(controlDirectory, "helper-closed.json")) || existsSync(path.join(controlDirectory, "release-pin"))) {
      throw new Error(`Native process handle was no longer confirmed immediately before descendant admission. ${diagnostics()}`);
    }
    touch(path.join(controlDirectory, "allow-descendant"), nonce);
    const rootReady = await waitForJson<RootReadyMarker>(path.join(controlDirectory, "root-ready.json"), scenarioDeadline, diagnostics);
    if (!Number.isSafeInteger(rootReady.descendantPid) || rootReady.descendantPid <= 0 || rootReady.pid !== rootPid || rootReady.nonce !== nonce || rootReady.mode !== adapter) {
      throw new Error(`Root readiness marker did not match the pinned root identity. ${diagnostics()}`);
    }
    descendantPid = rootReady.descendantPid;
    const descendantStarted = await waitForJson<{ pid: number; parentPid: number; nonce: string }>(path.join(controlDirectory, "descendant-started.json"), scenarioDeadline, diagnostics);
    expect(descendantStarted).toMatchObject({ pid: descendantPid, parentPid: rootPid, nonce });
    expect(isProcessAlive(descendantPid), "The inheriting descendant must be live before root release.").toBe(true);

    touch(path.join(controlDirectory, "release-root"), nonce);
    const rootExit = await waitForObservedRootExit(observer, rootPid, scenarioDeadline, diagnostics);
    rootExitObserved = true;
    expect(rootExit.exitCode).toBe(0);
    const rootExitMarker = await waitForJson<{ rootPid: number; handlePid: number; exitCode: number; nonce: string }>(path.join(controlDirectory, "root-exited.json"), scenarioDeadline, diagnostics);
    expect(rootExitMarker).toMatchObject({ rootPid, handlePid: rootPid, exitCode: rootExit.exitCode, nonce });
    expect(pinHelper && isProcessAlive(pinHelper.pid), "The actual process handle must remain open after GetExitCodeProcess observes natural root exit.").toBe(true);
    expect(existsSync(path.join(controlDirectory, "helper-closed.json"))).toBe(false);
    expect(isProcessAlive(descendantPid), "The descendant must still hold the inherited pipes after natural root exit.").toBe(true);
    expect(settlement, `The public adapter must remain pending while the pinned root has exited and its descendant still holds the pipes. ${diagnostics()}`).toBeUndefined();

    if (cancel) {
      controller.abort();
      await waitForTaskkillOrSettlement(observer, rootPid, () => settlement, scenarioDeadline, diagnostics);
      const obsoleteRootAttempts = observer.records.filter((record) => record.kind === "taskkill" && record.taskkillPid === rootPid);
      expect(obsoleteRootAttempts, `An exited, still-pinned root PID must not be sent to taskkill. ${diagnostics()}`).toHaveLength(0);
      if (settlement === undefined) {
        const settled = await waitForSettlement(adapterPromise, scenarioDeadline, diagnostics);
        expect(settled.kind).toBe("result");
      }
      if (!settlement || settlement.kind !== "result") throw settlement?.error ?? new Error(`Adapter did not return a cancellation result. ${diagnostics()}`);
      expect(settlement.descendantAliveAtReturn, "The held descendant must still be alive at public adapter settlement.").toBe(true);
      expect(settlement.rootExitCodeAtReturn).toBe(0);
      expect(settlement.pinHelperAliveAtReturn, "The native handle pin must remain alive through public adapter settlement.").toBe(true);
      expect(settlement.helperClosedAtReturn).toBe(false);
      assertCancelledResult(adapter, settlement.value);
    } else {
      touch(path.join(controlDirectory, "release-descendant"), nonce);
      const descendantExit = await waitForJson<{ pid: number; nonce: string; exitCode: number }>(path.join(controlDirectory, "descendant-exited.json"), scenarioDeadline, diagnostics);
      expect(descendantExit).toMatchObject({ pid: descendantPid, nonce, exitCode: 0 });
      await waitForPidExit(descendantPid, scenarioDeadline);
      const result = await waitForSettlement(adapterPromise, scenarioDeadline, diagnostics);
      expect(result.kind).toBe("result");
      if (result.kind !== "result") throw result.error;
      expect(result.rootExitCodeAtReturn).toBe(0);
      expect(isProcessAlive(descendantPid), "The owned descendant PID must be absent after its actual exit marker.").toBe(false);
      expect(result.pinHelperAliveAtReturn).toBe(true);
      expect(result.helperClosedAtReturn).toBe(false);
      assertNaturalResult(adapter, result.value);
      expect(observer.records.filter((record) => record.kind === "taskkill")).toHaveLength(0);
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    const cleanupDeadline = Date.now() + cleanupBudgetMs;
    let cleanupWaitedPastAdapter = false;
    if (!pinReady && existsSync(path.join(controlDirectory, "pin-ready.json"))) {
      try {
        const candidate = readJson(path.join(controlDirectory, "pin-ready.json"));
        const actualRoot = rootPid === undefined ? undefined : observer.records.find((record) => record.kind === "root" && record.pid === rootPid && record.fixturePath === path.resolve(targetFixture).toLowerCase() && record.spawnedAt !== undefined);
        const helperHasUnreleasedHandle = pinHelper !== undefined && isProcessAlive(pinHelper.pid) && !existsSync(path.join(controlDirectory, "helper-closed.json")) && !existsSync(path.join(controlDirectory, "release-pin"));
        if (pinHelper && rootPid !== undefined && actualRoot && helperHasUnreleasedHandle && candidate.helperPid === pinHelper.pid && candidate.rootPid === rootPid && candidate.handlePid === rootPid && candidate.exitCode === 259 && candidate.nonce === nonce) {
          pinReady = candidate as unknown as PinMarker;
        } else cleanupErrors.push(new Error(`Native pin marker could not be matched to the actual helper and root PIDs. ${diagnostics()}`));
      } catch (error) { cleanupErrors.push(asError(error)); }
    }
    if (pinReady) {
      if (!pinHelper || !isProcessAlive(pinHelper.pid) || existsSync(path.join(controlDirectory, "helper-closed.json")) || existsSync(path.join(controlDirectory, "release-pin"))) {
        cleanupErrors.push(new Error(`Retaining root behind its descendant gate because live native pin ownership is unconfirmed. ${diagnostics()}`));
      } else {
        try { touch(path.join(controlDirectory, "allow-descendant"), nonce); }
        catch (error) { cleanupErrors.push(asError(error)); }
      }
    }
    try { touch(path.join(controlDirectory, "release-root"), nonce); } catch (error) { cleanupErrors.push(asError(error)); }
    try { touch(path.join(controlDirectory, "release-descendant"), nonce); } catch (error) { cleanupErrors.push(asError(error)); }

    if (adapterPromise && settlement === undefined && pinReady && pinHelper && isProcessAlive(pinHelper.pid) && !existsSync(path.join(controlDirectory, "helper-closed.json")) && !existsSync(path.join(controlDirectory, "release-pin"))) {
      controller.abort();
    }

    if (adapterPromise && settlement === undefined) {
      try { await waitForSettlement(adapterPromise, cleanupDeadline, diagnostics); }
      catch (error) { cleanupErrors.push(asError(error)); cleanupWaitedPastAdapter = true; }
    }

    const canonicalTarget = path.resolve(targetFixture).toLowerCase();
    const observedRoot = observer.records.find((record) => record.kind === "root" && record.fixturePath === canonicalTarget);
    if (rootPid === undefined && observedRoot?.pid !== undefined) rootPid = observedRoot.pid;
    if (rootPid !== undefined && (observedRoot?.pid !== rootPid || observedRoot.fixturePath !== canonicalTarget)) {
      cleanupErrors.push(new Error(`The recorded root PID did not match the actual owned ChildProcess object. ${diagnostics()}`));
    }
    if (descendantPid === undefined && existsSync(path.join(controlDirectory, "descendant-started.json"))) {
      try {
        const descendantMarker = readJson(path.join(controlDirectory, "descendant-started.json"));
        if (descendantMarker.nonce !== nonce || typeof descendantMarker.pid !== "number" || !Number.isSafeInteger(descendantMarker.pid) || descendantMarker.pid <= 0) {
          cleanupErrors.push(new Error("The owned descendant marker identity is invalid."));
        } else descendantPid = descendantMarker.pid;
      } catch (error) { cleanupErrors.push(asError(error)); }
    }

    if (pinHelper) {
      try {
        if (adapterPromise === undefined || settlement !== undefined) {
          if (pinReady) touch(path.join(controlDirectory, "release-pin"), nonce);
          else {
            touch(path.join(controlDirectory, "stop-helper"), nonce);
            touch(path.join(controlDirectory, "release-pin"), nonce);
          }
          const helperExit = await waitForChildClose(pinHelper, cleanupDeadline);
          expect(helperExit.code).toBe(0);
          const helperClosed = readJson(path.join(controlDirectory, "helper-closed.json"));
          expect(helperClosed).toMatchObject({ pid: pinHelper.pid, handleClosed: true, nonce });
          if (pinReady) expect(helperClosed.rootPid).toBe(rootPid);
          await waitForPidExit(pinHelper.pid, cleanupDeadline);
          helperStopped = true;
        } else {
          cleanupErrors.push(new Error(`Retaining project and handle pin because adapter settlement is unconfirmed. ${diagnostics()}`));
        }
      } catch (error) { cleanupErrors.push(asError(error)); }
    }

    try {
      if (descendantPid !== undefined) {
        const descendantExit = await waitForJson<{ pid: number; nonce: string; exitCode: number }>(path.join(controlDirectory, "descendant-exited.json"), cleanupDeadline, diagnostics);
        if (descendantExit.pid !== descendantPid || descendantExit.nonce !== nonce || descendantExit.exitCode !== 0) {
          cleanupErrors.push(new Error("Owned descendant exit marker did not match its verified PID/nonce and natural exit code."));
        }
        await waitForPidExit(descendantPid, cleanupDeadline);
      }
      if (rootPid !== undefined) {
        const exitedRoot = rootExitObserved ? observer.records.find((record) => record.kind === "root" && record.pid === rootPid && record.exitedAt !== undefined)
          : await waitForObservedRootExit(observer, rootPid, cleanupDeadline, diagnostics);
        if (!exitedRoot) cleanupErrors.push(new Error(`Actual root process exit was not observed for owned PID ${rootPid}.`));
        else {
          rootExitObserved = true;
          await waitForPidExit(rootPid, cleanupDeadline);
        }
      }
    } catch (error) { cleanupErrors.push(asError(error)); }

    const rootsStopped = (rootPid === undefined || !isProcessAlive(rootPid)) && (descendantPid === undefined || !isProcessAlive(descendantPid));
    const adapterSettled = adapterPromise === undefined || settlement !== undefined;
    observer.stop();
    if (adapterSettled && helperStopped && rootsStopped && cleanupErrors.length === 0) {
      try {
        assertOwnedProject(project, ownedProject);
        rmSync(project, { recursive: true, force: true });
      } catch (error) { cleanupErrors.push(asError(error)); }
    } else {
      cleanupErrors.push(new Error(`Retaining owned project because process or handle cleanup is unconfirmed. ${diagnostics()}`));
    }
    if (cleanupWaitedPastAdapter && adapterPromise && pinHelper) {
      void adapterPromise.then(() => {
        try {
          touch(path.join(controlDirectory, "stop-helper"), nonce);
          touch(path.join(controlDirectory, "release-pin"), nonce);
        } catch { /* Preserve the retained project and handle if delayed safe release cannot be recorded. */ }
      }, () => {
        try {
          touch(path.join(controlDirectory, "stop-helper"), nonce);
          touch(path.join(controlDirectory, "release-pin"), nonce);
        } catch { /* Preserve the retained project and handle if delayed safe release cannot be recorded. */ }
      });
    }
  }

  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "P15 exited-root scenario and cleanup both failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P15 exited-root cleanup failed.");
}

function observeNativeChildren(targets: string[]): { records: NativeChildRecord[]; stop(): void } {
  const records: NativeChildRecord[] = [];
  const byChild = new WeakMap<object, NativeChildRecord>();
  const targetPaths = targets.map((value) => path.resolve(value).toLowerCase());
  const onChild = (message: unknown): void => {
    try {
      const child = typeof message === "object" && message !== null && "process" in message ? (message as { process?: unknown }).process : undefined;
      if (!child || typeof child !== "object" || !("once" in child) || typeof (child as ChildProcess).once !== "function") return;
      const processChild = child as ChildProcess;
      const update = (stage: "spawn" | "exit" | "close" | "error", code?: number | null, signal?: NodeJS.Signals | null, error?: unknown): void => {
        try {
          let record = byChild.get(processChild);
          const args = Array.isArray(processChild.spawnargs) ? processChild.spawnargs : [];
          const executable = typeof processChild.spawnfile === "string" ? path.basename(processChild.spawnfile).toLowerCase() : "";
          const matchedFixture = targetPaths.find((target) => args.some((argument) => typeof argument === "string" && path.resolve(argument).toLowerCase() === target));
          const fixtureTarget = matchedFixture !== undefined;
          const taskkill = executable === "taskkill" || executable === "taskkill.exe";
          if (!record && !fixtureTarget && !taskkill) return;
          if (!record) {
            const targetIndex = args.findIndex((argument) => typeof argument === "string" && argument.toLowerCase() === "/pid");
            const targetArgument = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
            const taskkillPid = typeof targetArgument === "string" && /^\d+$/u.test(targetArgument) ? Number(targetArgument) : undefined;
            record = {
              kind: taskkill ? "taskkill" : "root",
              ...(typeof processChild.pid === "number" && Number.isSafeInteger(processChild.pid) ? { pid: processChild.pid } : {}),
              executable,
              ...(matchedFixture === undefined ? {} : { fixturePath: matchedFixture }),
              childParentPid: process.pid,
              ...(taskkillPid !== undefined && Number.isSafeInteger(taskkillPid) ? { taskkillPid } : {}),
              ...(taskkill ? { taskkillTree: args.some((argument) => typeof argument === "string" && argument.toLowerCase() === "/t"), taskkillForce: args.some((argument) => typeof argument === "string" && argument.toLowerCase() === "/f") } : {}),
            };
            byChild.set(processChild, record);
            records.push(record);
          }
          const now = performance.now();
          if (stage === "spawn") record.spawnedAt = now;
          if (stage === "exit") { record.exitedAt = now; record.exitCode = code ?? null; record.signal = signal ?? null; }
          if (stage === "close") { record.closedAt = now; record.exitCode = code ?? null; record.signal = signal ?? null; }
          if (stage === "error" && error instanceof Error) record.errorName = error.name;
        } catch { /* Process observation must not affect child execution. */ }
      };
      processChild.once("spawn", () => update("spawn"));
      processChild.once("exit", (code, signal) => update("exit", code, signal));
      processChild.once("close", (code, signal) => update("close", code, signal));
      processChild.once(errorMonitor, (error) => update("error", null, null, error));
    } catch { /* Diagnostics are best-effort and read-only. */ }
  };
  const childChannel = channel("child_process");
  childChannel.subscribe(onChild);
  return { records, stop: () => childChannel.unsubscribe(onChild) };
}

function startPinHelper(controlDirectory: string, nonce: string): PinHelper {
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-File", pinFixture, "-ControlDirectory", controlDirectory, "-Nonce", nonce, "-WatchdogMilliseconds", String(helperWatchdogMs)], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => undefined);
  let stdoutTail = "";
  let stderrTail = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdoutTail = `${stdoutTail}${chunk.toString("utf8")}`.slice(-1200); });
  child.stderr?.on("data", (chunk: Buffer) => { stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-1200); });
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Native process-handle pin helper did not expose a valid PID.");
  return { child, pid, closed, diagnostics: () => JSON.stringify({ pid, alive: isProcessAlive(pid), stdoutTail, stderrTail }) };
}

function assertCancelledResult(adapter: AdapterMode, value: ProcessResult | Awaited<ReturnType<ProcessArtifactValidator["execute"]>>): void {
  expect(value).toMatchObject({ cancelled: true, timedOut: false, terminationCause: "cancelled", cleanupUnverified: { code: "PROCESS_TREE_UNVERIFIED", operationCause: "cancelled" } });
  if (adapter === "provider") {
    expect(value).toMatchObject({ started: true, exitCode: 0, outputLimitExceeded: false, stdout: "provider-ok\n" });
  } else {
    expect(value).toMatchObject({ exitCode: 0, outputLimitExceeded: false, stdout: JSON.stringify({ valid: true, errors: [] }) + "\n" });
  }
}

function assertNaturalResult(adapter: AdapterMode, value: ProcessResult | Awaited<ReturnType<ProcessArtifactValidator["execute"]>>): void {
  expect(value).toMatchObject({ cancelled: false, timedOut: false, exitCode: 0, outputLimitExceeded: false });
  expect(value).not.toHaveProperty("terminationCause");
  expect(value).not.toHaveProperty("cleanupUnverified");
  if (adapter === "provider") expect(value).toMatchObject({ started: true, stdout: "provider-ok\n" });
  else expect(value).toMatchObject({ stdout: JSON.stringify({ valid: true, errors: [] }) + "\n" });
}

async function waitForTaskkillOrSettlement(observer: { records: NativeChildRecord[] }, rootPid: number, getSettlement: () => AdapterSettlement | undefined, deadline: number, diagnostics: () => string): Promise<void> {
  while (Date.now() < deadline) {
    const attempt = observer.records.find((record) => record.kind === "taskkill");
    if (attempt || getSettlement()) return;
    await delay(10);
  }
  throw new Error(`Neither actual taskkill child nor adapter settlement was observed for pinned root PID ${rootPid}. ${diagnostics()}`);
}

async function waitForSettlement(promise: Promise<AdapterSettlement>, deadline: number, diagnostics: () => string): Promise<AdapterSettlement> {
  return raceUntilDeadline(promise, deadline, () => new Error(`Adapter did not settle before its existing scenario/cleanup deadline. ${diagnostics()}`));
}

async function waitForObservedRoot(observer: { records: NativeChildRecord[] }, target: string, deadline: number, diagnostics: () => string): Promise<NativeChildRecord> {
  const canonical = path.resolve(target).toLowerCase();
  while (Date.now() < deadline) {
    const record = observer.records.find((candidate) => candidate.kind === "root" && candidate.fixturePath === canonical && candidate.pid !== undefined);
    if (record) return record;
    await delay(10);
  }
  throw new Error(`Could not observe the actual owned root ChildProcess object for '${path.basename(target)}'. ${diagnostics()}`);
}

async function waitForObservedRootExit(observer: { records: NativeChildRecord[] }, pid: number, deadline: number, diagnostics: () => string): Promise<NativeChildRecord> {
  while (Date.now() < deadline) {
    const record = observer.records.find((candidate) => candidate.kind === "root" && candidate.pid === pid && candidate.exitedAt !== undefined);
    if (record) return record;
    await delay(10);
  }
  throw new Error(`Actual root ChildProcess exit event was not observed for PID ${pid}. ${diagnostics()}`);
}

async function waitForChildClose(helper: PinHelper, deadline: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return raceUntilDeadline(helper.closed, deadline, () => new Error(`Native handle helper PID ${helper.pid} did not close before cleanup deadline. ${helper.diagnostics()}`));
}

async function raceUntilDeadline<T>(promise: Promise<T>, deadline: number, timeoutError: () => Error): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(timeoutError()), remaining); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function waitForJson<T = unknown>(file: string, deadline: number, diagnostics: () => string): Promise<T> {
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
    await delay(10);
  }
  throw new Error(`Timed out waiting for owned marker '${path.basename(file)}'. ${diagnostics()}`);
}

function writeAtomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, file);
}

function readJson(file: string): Record<string, unknown> { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; }
function touch(file: string, nonce: string): void { if (!existsSync(file)) writeAtomicJson(file, { nonce }); }

function assertOwnedProject(project: string, identity: string): void {
  const tempRoot = realpathSync.native(os.tmpdir());
  if (path.dirname(identity) !== tempRoot || !path.basename(identity).startsWith(label) || realpathSync.native(project) !== identity) {
    throw new Error(`Refusing P15 exited-root cleanup outside the exact owned project: '${identity}'.`);
  }
}

async function waitForPidExit(pid: number, deadline: number): Promise<void> {
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Owned process PID ${pid} did not prove exit before cleanup deadline.`);
    await delay(10);
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error(typeof value === "string" ? value.slice(0, 500) : "non-Error fixture failure"); }
function safeErrorText(value: unknown): string { return value instanceof Error ? value.message.slice(0, 500) : typeof value === "string" ? value.slice(0, 500) : "non-Error failure"; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

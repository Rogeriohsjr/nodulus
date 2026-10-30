import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { ProviderInvocation, ProviderPort } from "../../src/application/run-workflow.js";

export type HeldOperation = "availability" | "invoke" | "repair_response";
export type HeldBehavior = "resolve" | "reject";
export type HeldProviderScenario = { operation: HeldOperation; behavior: HeldBehavior; profileTimeoutMs?: number };
export type HeldProcessRecord = {
  key: string;
  operation: string;
  pid: number;
  parentPid?: number;
  aliveAtStart: boolean;
  spawnedAtMonotonicMs: number;
  spawnElapsedMs?: number;
  closeObserved: boolean;
  closedAtMonotonicMs?: number;
  exitCode?: number | null;
  closeSignal?: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  spawnError?: string;
};

export type GraphUnresolvedProviderFixture = {
  provider: ProviderPort;
  controlDirectory: string;
  processes: HeldProcessRecord[];
  operations: Array<{ nodeId: string; operation: string; callId?: string; parentCallId?: string; signal?: AbortSignal; abortedAt?: number }>;
  stopFailure(): void;
  releaseAll(): void;
  waitForStarted(key: string, deadline: number): Promise<HeldProcessRecord>;
  drain(deadline: number): Promise<void>;
  diagnostics(): string;
};

const scriptPath = fileURLToPath(new URL("../fixtures/par-015-unresolved-provider.mjs", import.meta.url));
const validOutcome = (nodeId: string): string => JSON.stringify({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: `late:${nodeId}` } }] });

export function createGraphUnresolvedProvider(project: string, scenario: HeldProviderScenario): GraphUnresolvedProviderFixture {
  const controlDirectory = path.join(project, ".nodulus", "fixtures", "par-015-unresolved-control");
  mkdirSync(controlDirectory, { recursive: true });
  const processes = new Map<string, { child: ChildProcess; record: HeldProcessRecord }>();
  const processRecords: HeldProcessRecord[] = [];
  const pending = new Set<Promise<unknown>>();
  const launched = new Map<string, boolean>();
  const operations: GraphUnresolvedProviderFixture["operations"] = [];
  const operationForProfile = (profile: Record<string, unknown>): string => {
    const model = profile.model;
    if (typeof model !== "string" || !/^p15b2-(held|stopper|dependent)$/.test(model)) throw new Error("Provider profile did not contain an owned P15B2 model identity.");
    return model.slice("p15b2-".length);
  };
  const addOperation = (nodeId: string, operation: string, invocation?: ProviderInvocation, signal?: AbortSignal): void => {
    const record: GraphUnresolvedProviderFixture["operations"][number] = { nodeId, operation, ...(invocation?.call?.callId ? { callId: invocation.call.callId } : {}), ...(invocation?.call?.parentCallId ? { parentCallId: invocation.call.parentCallId } : {}), ...(signal ? { signal } : {}) };
    operations.push(record);
    const recordAbort = (): void => { record.abortedAt = performance.now(); };
    if (signal?.aborted) recordAbort();
    else signal?.addEventListener("abort", recordAbort, { once: true });
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    let tracked: Promise<void>;
    tracked = promise.then(() => { pending.delete(tracked); }, () => { pending.delete(tracked); });
    pending.add(tracked);
    return promise;
  };
  const waitForMarker = async (file: string, deadline: number): Promise<void> => {
    while (!existsSync(file)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for provider control '${path.basename(file)}'. ${diagnostics()}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  };
  const hold = (key: string, operation: HeldOperation, behavior: HeldBehavior, value: string, callId?: string): Promise<string> => track(new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stdoutTail = "";
    let stderrTail = "";
    let record: HeldProcessRecord | undefined;
    child.stdout?.on("data", (chunk: Buffer) => { const text = chunk.toString("utf8"); stdout += text; stdoutTail = appendTail(stdoutTail, text); if (record) record.stdoutTail = stdoutTail; });
    child.stderr?.on("data", (chunk: Buffer) => { stderrTail = appendTail(stderrTail, chunk.toString("utf8")); if (record) record.stderrTail = stderrTail; });
    child.once("error", (error) => {
      if (record) record.spawnError = error instanceof Error ? error.message.slice(0, 500) : "non-Error child process failure";
      reject(error);
    });
    child.once("spawn", () => {
      if (!child.pid) { reject(new Error(`Held provider child '${key}' has no PID.`)); return; }
      const spawnedAtMonotonicMs = performance.now();
      record = {
        key, operation, pid: child.pid, parentPid: process.pid, aliveAtStart: isProcessAlive(child.pid),
        spawnedAtMonotonicMs, closeObserved: false, stdoutTail, stderrTail,
      };
      processRecords.push(record);
      processes.set(key, { child, record });
      if (callId) launched.set(callId, true);
      child.stdin?.end(JSON.stringify({ controlDirectory, key, operation, behavior, value }));
    });
    child.once("close", (code, signal) => {
      const processRecord = record ?? processes.get(key)?.record;
      if (processRecord) {
        processRecord.closeObserved = true;
        processRecord.closedAtMonotonicMs = performance.now();
        processRecord.spawnElapsedMs = processRecord.closedAtMonotonicMs - processRecord.spawnedAtMonotonicMs;
        processRecord.exitCode = code;
        processRecord.closeSignal = signal;
        processRecord.stdoutTail = stdoutTail;
        processRecord.stderrTail = stderrTail;
      }
      processes.delete(key);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Held provider child '${key}' exited ${String(code)}: ${stderrTail.slice(-500)}`));
    });
  }));

  const provider: ProviderPort = {
    isAvailable(profile, options) {
      const nodeId = operationForProfile(profile);
      addOperation(nodeId, "availability", undefined, options?.signal);
      if (nodeId === "held" && scenario.operation === "availability") {
        return hold("held-availability", "availability", scenario.behavior, "available").then((value) => value === "available");
      }
      return true;
    },
    invoke(invocation) {
      const operation = invocation.call?.operation ?? "invoke";
      const nodeId = invocation.nodeId;
      addOperation(nodeId, operation, invocation, invocation.signal);
      if (nodeId === "stopper") return track((async () => {
        await waitForMarker(path.join(controlDirectory, "fail-stopper"), Date.now() + 30_000);
        return JSON.stringify({ status: "error", error: { code: "P15B2_STOP_TRIGGER", message: "Deterministic sibling stop trigger." } });
      })());
      if (nodeId !== "held") throw new Error(`Unexpected provider node '${nodeId}'.`);
      if (operation === "repair_response") throw new Error("Repair operation must use repairResponse port.");
      if (scenario.operation === "availability") return track(Promise.resolve(validOutcome(nodeId)));
      if (scenario.operation === "repair_response") {
        const parentKey = "held-parent-invoke";
        writeFileSync(path.join(controlDirectory, `release-${parentKey}`), "release\n", { encoding: "utf8", flag: "wx" });
        return hold(parentKey, "invoke", "resolve", "not a valid provider outcome", invocation.call?.callId);
      }
      const key = "held-invoke";
      return hold(key, "invoke", scenario.behavior, validOutcome(nodeId), invocation.call?.callId);
    },
    repairResponse(invocation) {
      addOperation(invocation.nodeId, "repair_response", invocation, invocation.signal);
      return hold("held-repair_response", "repair_response", scenario.behavior, validOutcome(invocation.nodeId), invocation.call?.callId);
    },
    launchForCall(callId) { return launched.get(callId) ?? null; },
  };

  return {
    provider,
    controlDirectory,
    processes: processRecords,
    operations,
    stopFailure: () => writeFileSync(path.join(controlDirectory, "fail-stopper"), "fail\n", "utf8"),
    releaseAll: () => {
      for (const key of ["held-availability", "held-invoke", "held-repair_response"]) writeFileSync(path.join(controlDirectory, `release-${key}`), "release\n", "utf8");
      writeFileSync(path.join(controlDirectory, "fail-stopper"), "fail\n", "utf8");
    },
    async waitForStarted(key, deadline) {
      const markerPath = path.join(controlDirectory, `started-${key}.json`);
      await waitForMarker(markerPath, deadline);
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { pid: number; operation: string; key: string };
      const processRecord = processRecords.find((record) => record.key === key);
      if (!processRecord || marker.key !== key || marker.operation !== processRecord.operation || marker.pid !== processRecord.pid) {
        throw new Error(`Started marker identity did not match the retained provider process record for '${key}'. ${diagnostics()}`);
      }
      return { ...processRecord, aliveAtStart: isProcessAlive(marker.pid) };
    },
    async drain(deadline) {
      while (pending.size > 0 || processes.size > 0) {
        if (Date.now() >= deadline) throw new Error(`Provider fixture drain timed out: pending=${pending.size}, active=${processes.size}. ${diagnostics()}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    diagnostics: () => diagnostics(),
  };

  function diagnostics(): string {
    const keys = ["held-availability", "held-invoke", "held-repair_response"];
    const markers = keys.map((key) => ({
      key,
      started: existsSync(path.join(controlDirectory, `started-${key}.json`)),
      release: existsSync(path.join(controlDirectory, `release-${key}`)),
      finished: existsSync(path.join(controlDirectory, `finished-${key}.json`)),
    }));
    return JSON.stringify({
      operations: operations.map(({ nodeId, operation, callId, abortedAt }) => ({ nodeId, operation, callId, abortedAt })),
      processRecords,
      markers,
      activePids: [...processes.values()].map(({ record }) => record.pid),
    });
  }
}

function appendTail(current: string, addition: string): string {
  return `${current}${addition}`.slice(-2000);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

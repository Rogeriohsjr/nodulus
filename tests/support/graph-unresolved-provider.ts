import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { ProviderInvocation, ProviderPort } from "../../src/application/run-workflow.js";

export type HeldOperation = "availability" | "invoke" | "repair_response";
export type HeldBehavior = "resolve" | "reject";
export type HeldProviderScenario = { operation: HeldOperation; behavior: HeldBehavior; profileTimeoutMs?: number };
export type HeldProcessRecord = { key: string; operation: string; pid: number; aliveAtStart: boolean; exitCode?: number | null };

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
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("spawn", () => {
      if (!child.pid) { reject(new Error(`Held provider child '${key}' has no PID.`)); return; }
      const record: HeldProcessRecord = { key, operation, pid: child.pid, aliveAtStart: isProcessAlive(child.pid) };
      processRecords.push(record);
      processes.set(key, { child, record });
      if (callId) launched.set(callId, true);
      child.stdin?.end(JSON.stringify({ controlDirectory, key, operation, behavior, value }));
    });
    child.once("close", (code) => {
      const processRecord = processes.get(key)?.record;
      if (processRecord) processRecord.exitCode = code;
      processes.delete(key);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Held provider child '${key}' exited ${String(code)}: ${stderr.slice(0, 500)}`));
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
      return { key, operation: marker.operation, pid: marker.pid, aliveAtStart: isProcessAlive(marker.pid) };
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
    const markers = ["held-availability", "held-invoke", "held-repair_response"].flatMap((key) => {
      const marker = path.join(controlDirectory, `started-${key}.json`);
      return existsSync(marker) ? [JSON.parse(readFileSync(marker, "utf8"))] : [];
    });
    return JSON.stringify({ operations: operations.map(({ nodeId, operation, callId }) => ({ nodeId, operation, callId })), markers, activePids: [...processes.values()].map(({ record }) => record.pid) });
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

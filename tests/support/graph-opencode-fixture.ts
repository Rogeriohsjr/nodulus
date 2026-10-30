import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import type { ProviderInvocation, ProviderPort } from "../../src/application/run-workflow.js";
import { cleanupProviderProject, createProviderScenario } from "./provider-adapter-scenarios.js";

export type GraphOpenCodeNodeConfig = {
  sessionId: string;
  buildRaw: string;
  repairRaw: string[];
};

export type GraphOpenCodeCall = {
  method: "invoke" | "repair_response";
  nodeId: string;
  callId: string;
  callAttempt: number;
  invocationAttempt: number;
  parentCallId: string | null;
  adapterSettled: boolean;
  checkpointAtEntry: Record<string, any>;
  raw?: string;
  error?: string;
};

export type GraphOpenCodeOperation = {
  nodeId: string;
  operation: "build" | "repair";
  operationIndex: number;
  sessionID: string;
  pid: number;
  argv: string[];
  stdin: string;
  usage: { input: number; output: number; reasoning: number; cache: { read: number; write: number }; cost: number };
};

export type GraphOpenCodeFixture = {
  project: string;
  stateDirectory: string;
  provider: ProviderPort;
  calls: GraphOpenCodeCall[];
  operations(): GraphOpenCodeOperation[];
  operation(nodeId: string, operation: "build" | "repair", index: number): GraphOpenCodeOperation;
  actionExists(nodeId: string): boolean;
  hasStarted(nodeId: string, operation: "build" | "repair", index?: number): boolean;
  hasFinished(nodeId: string, operation: "build" | "repair", index?: number): boolean;
  release(nodeId: string, operation: "build" | "repair", index?: number): void;
  releaseAll(): void;
  releaseDeliveryWave(): void;
  waitForStarted(nodeId: string, operation: "build" | "repair", index?: number, timeoutMs?: number): Promise<void>;
  waitForFinished(nodeId: string, operation: "build" | "repair", index?: number, timeoutMs?: number): Promise<void>;
  waitForAdapterSettled(nodeIds: string[], timeoutMs?: number): Promise<void>;
  waitForProcessesExit(timeoutMs?: number): Promise<void>;
  validateProcessIds(): void;
  redact(value: string): string;
  drain(timeoutMs?: number): Promise<void>;
  diagnostics(): string;
  cleanup(): Promise<void>;
};

const providerFixtureSource = fileURLToPath(new URL("../fixtures/par-opencode-graph.mjs", import.meta.url));

export async function createGraphOpenCodeFixture(
  nodes: Record<string, GraphOpenCodeNodeConfig>,
  options: { deliveryWave?: boolean } = {},
): Promise<GraphOpenCodeFixture> {
  const scenario = await createProviderScenario("opencode", "repair-graph");
  const project = scenario.project;
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { providerProfiles: Record<string, Record<string, unknown>> };
  const openCodeProfile = structuredClone(settings.providerProfiles.fixture);

  // The shared fixture supplies the real OpenCode wrapper/profile setup. The graph
  // project helper writes schemas and node files, after which restore that profile.
  const { configureParallelProject } = await import("./parallel-project.js");
  configureParallelProject(project);
  const graphSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as { providerProfiles: Record<string, Record<string, unknown>> };
  graphSettings.providerProfiles.fixture = openCodeProfile;
  writeFileSync(settingsPath, `${JSON.stringify(graphSettings, null, 2)}\n`, "utf8");

  const stateDirectory = path.join(project, ".nodulus", "fixtures", "graph-opencode-state");
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(path.join(stateDirectory, "config.json"), JSON.stringify({ nodes }), "utf8");
  const scriptPath = path.join(project, ".nodulus", "fixtures", "opencode-fixture.mjs");
  copyFileSync(providerFixtureSource, scriptPath);

  const actual = createDefaultProviderPort(project);
  const calls: GraphOpenCodeCall[] = [];
  const inFlight = new Set<Promise<void>>();
  let releaseDelivery!: () => void;
  let deliveryOpen = false;
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });

  const track = (
    method: "invoke" | "repair_response",
    invocation: ProviderInvocation,
    operation: () => Promise<string>,
  ): Promise<string> => {
    const call = invocation.call;
    if (!call?.callId) throw new Error(`Graph ${method} did not include a call ID.`);
    const record: GraphOpenCodeCall = {
      method,
      nodeId: invocation.nodeId,
      callId: call.callId,
      callAttempt: call.attempt,
      invocationAttempt: invocation.attempt,
      parentCallId: call.parentCallId ?? null,
      adapterSettled: false,
      checkpointAtEntry: JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", invocation.runId, "run.json"), "utf8")) as Record<string, any>,
    };
    calls.push(record);
    const heldBuild = options.deliveryWave === true && method === "invoke" && ["alpha", "beta"].includes(invocation.nodeId);
    const trackedOperation = (async () => {
      try {
        const raw = await operation();
        record.raw = raw;
        record.adapterSettled = true;
        if (heldBuild && !deliveryOpen) await deliveryGate;
        return raw;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        record.adapterSettled = true;
        if (heldBuild && !deliveryOpen) await deliveryGate;
        throw error;
      }
    })();
    let tracked: Promise<void>;
    tracked = trackedOperation.then(() => undefined, () => undefined).then(() => { inFlight.delete(tracked); });
    inFlight.add(tracked);
    return trackedOperation;
  };

  const provider: ProviderPort = {
    isAvailable: (profile, options) => actual.isAvailable?.(profile, options) ?? true,
    invoke: (invocation) => track("invoke", invocation, () => actual.invoke(invocation)),
    repairResponse: (invocation, previousRawResponse, validationErrors) => {
      if (!actual.repairResponse) return Promise.reject(new Error("Default OpenCode provider does not expose response repair."));
      return track("repair_response", invocation, () => actual.repairResponse!(invocation, previousRawResponse, validationErrors));
    },
    telemetryForCall: (callId) => actual.telemetryForCall?.(callId) ?? null,
    launchForCall: (callId) => actual.launchForCall?.(callId) ?? null,
    usageForLastCall: () => actual.usageForLastCall?.() ?? null,
  };

  const operationPath = (nodeId: string, operation: "build" | "repair", index = 1) =>
    path.join(stateDirectory, `operation-${nodeId}-${operation}-${index}.json`);
  const markerPath = (nodeId: string, operation: "build" | "repair", index: number, marker: "started" | "finished" | "release") =>
    path.join(stateDirectory, `${marker}-${nodeId}-${operation}-${index}${marker === "release" ? "" : ".json"}`);
  const operations = (): GraphOpenCodeOperation[] => readdirSync(stateDirectory)
    .filter((name) => name.startsWith("operation-") && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(stateDirectory, name), "utf8")) as GraphOpenCodeOperation);
  const diagnosticSummary = () => {
    try {
      const callsSummary = calls.map(({ method, nodeId, callId, callAttempt, invocationAttempt, parentCallId, adapterSettled, error }) => ({ method, nodeId, callId, callAttempt, invocationAttempt, parentCallId, adapterSettled, error: error?.slice(0, 240) }));
      const operationsSummary = operations().map(({ nodeId, operation, operationIndex, sessionID, pid, argv, usage }) => ({ nodeId, operation, operationIndex, sessionID, pid, argv, usage }));
      return JSON.stringify({ calls: callsSummary, operations: operationsSummary });
    } catch (error) {
      return `diagnostic read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const waitForMarker = async (nodeId: string, operation: "build" | "repair", index: number, marker: "started" | "finished", timeoutMs: number) => {
    const target = markerPath(nodeId, operation, index, marker);
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(target)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for OpenCode ${marker} ${nodeId}/${operation}/${index}. ${diagnosticSummary()}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  };
  const diagnostics = () => `OpenCode fixture state: ${diagnosticSummary()}`;
  const validateProcessIds = () => {
    for (const operation of operations()) {
      if (!Number.isSafeInteger(operation.pid) || operation.pid <= 0) throw new Error(`OpenCode operation ${operation.nodeId}/${operation.operation}/${operation.operationIndex} has invalid PID ${String(operation.pid)}; project retained for diagnosis.`);
    }
  };
  const redact = (value: string) => Object.values(nodes).reduce((safe, node) => [node.buildRaw, ...node.repairRaw]
    .filter((raw) => raw.length > 0)
    .reduce((result, raw) => result.split(raw).join("[raw response omitted]"), safe), value);
  const releaseAll = () => {
    releaseDeliveryWave();
    for (const [nodeId, config] of Object.entries(nodes)) {
      writeFileSync(markerPath(nodeId, "build", 1, "release"), "release\n", "utf8");
      for (let index = 1; index <= Math.max(2, config.repairRaw.length); index += 1) {
        writeFileSync(markerPath(nodeId, "repair", index, "release"), "release\n", "utf8");
      }
    }
  };
  const releaseDeliveryWave = () => {
    deliveryOpen = true;
    releaseDelivery();
  };
  const fixture: GraphOpenCodeFixture = {
    project,
    stateDirectory,
    provider,
    calls,
    operations,
    operation(nodeId, operation, index = 1) {
      const file = operationPath(nodeId, operation, index);
      if (!existsSync(file)) throw new Error(`Missing OpenCode ${operation} record for ${nodeId} #${index}. ${diagnostics()}`);
      return JSON.parse(readFileSync(file, "utf8")) as GraphOpenCodeOperation;
    },
    actionExists: (nodeId) => existsSync(path.join(stateDirectory, `action-${nodeId}.json`)),
    hasStarted: (nodeId, operation, index = 1) => existsSync(markerPath(nodeId, operation, index, "started")),
    hasFinished: (nodeId, operation, index = 1) => existsSync(markerPath(nodeId, operation, index, "finished")),
    release: (nodeId, operation, index = 1) => writeFileSync(markerPath(nodeId, operation, index, "release"), "release\n", "utf8"),
    releaseAll,
    releaseDeliveryWave,
    validateProcessIds,
    redact,
    waitForStarted: (nodeId, operation, index = 1, timeoutMs = 10_000) => waitForMarker(nodeId, operation, index, "started", timeoutMs),
    waitForFinished: (nodeId, operation, index = 1, timeoutMs = 10_000) => waitForMarker(nodeId, operation, index, "finished", timeoutMs),
    async waitForAdapterSettled(nodeIds, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!nodeIds.every((nodeId) => calls.some((call) => call.method === "invoke" && call.nodeId === nodeId && call.adapterSettled))) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for actual OpenCode adapter promises to settle for ${nodeIds.join(", ")}. ${diagnostics()}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    },
    async waitForProcessesExit(timeoutMs = 12_000) {
      validateProcessIds();
      const pids = operations().map(({ pid }) => pid);
      const deadline = Date.now() + timeoutMs;
      while (pids.some(isProcessAlive)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for OpenCode fixture PIDs ${JSON.stringify(pids)}. ${diagnostics()}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    },
    async drain(timeoutMs = 10_000) {
      const pending = Promise.all([...inFlight]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([pending, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out draining OpenCode provider operations. ${diagnostics()}`)), timeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
    diagnostics,
    async cleanup() {
      releaseAll();
      await this.drain();
      validateProcessIds();
      await this.waitForProcessesExit();
      cleanupProviderProject(project);
    },
  };
  return fixture;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

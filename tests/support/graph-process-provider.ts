import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapturedProcess } from "../../src/adapters/providers/captured-process.js";
import type { ProviderInvocation, ProviderPort } from "../../src/application/run-workflow.js";
import type { ProviderTelemetry } from "../../src/core/ports/provider-telemetry.js";

export type GraphProviderInvocationRecord = {
  runId: string;
  nodeId: string;
  callId: string;
  attempt: number;
  inputs: Record<string, unknown>;
  checkpointAtEntry: Record<string, unknown>;
};

export type GraphProcessProviderFixture = {
  provider: ProviderPort;
  stateDirectory: string;
  invocations: GraphProviderInvocationRecord[];
  activeNodeIds(): string[];
  peakActiveCalls(): number;
  hasStarted(nodeId: string): boolean;
  hasFinished(nodeId: string): boolean;
  release(nodeId: string): void;
  releaseAll(): void;
  drain(timeoutMs?: number): Promise<void>;
  diagnostics(): string;
  waitForStarted(nodeIds: string[], signal?: AbortSignal): Promise<void>;
  waitForFinished(nodeIds: string[], signal?: AbortSignal): Promise<void>;
};

const fixturePath = fileURLToPath(new URL("../fixtures/par-graph-provider.mjs", import.meta.url));

export function createGraphProcessProvider(project: string, expectedNodeIds: string[]): GraphProcessProviderFixture {
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "graph-process-state");
  mkdirSync(stateDirectory, { recursive: true });
  const expected = new Set(expectedNodeIds);
  const invokedNodes = new Set<string>();
  const callIds = new Set<string>();
  const active = new Map<string, string>();
  const telemetryByCall = new Map<string, ProviderTelemetry>();
  const launchByCall = new Map<string, boolean>();
  const invocations: GraphProviderInvocationRecord[] = [];
  const inFlight = new Set<Promise<void>>();
  let peak = 0;

  const invokeProcess = async (invocation: ProviderInvocation): Promise<string> => {
      const callId = invocation.call?.callId;
      if (!expected.has(invocation.nodeId)) throw new Error(`Unexpected graph node invocation '${invocation.nodeId}'.`);
      if (invokedNodes.has(invocation.nodeId)) throw new Error(`Duplicate graph node invocation '${invocation.nodeId}'.`);
      if (!callId || callIds.has(callId)) throw new Error(`Missing or duplicate graph provider call ID '${String(callId)}'.`);
      invokedNodes.add(invocation.nodeId);
      callIds.add(callId);
      active.set(callId, invocation.nodeId);
      peak = Math.max(peak, active.size);
      try {
        const runRoot = path.join(project, ".nodulus", "runs", invocation.runId);
        const checkpointAtEntry = JSON.parse(readFileSync(path.join(runRoot, "run.json"), "utf8")) as Record<string, unknown>;
        invocations.push({
          runId: invocation.runId,
          nodeId: invocation.nodeId,
          callId,
          attempt: invocation.call?.attempt ?? invocation.attempt,
          inputs: structuredClone(invocation.inputs),
          checkpointAtEntry: structuredClone(checkpointAtEntry),
        });
        const result = await runCapturedProcess(process.execPath, [fixturePath], {
          cwd: project,
          stdin: JSON.stringify({
            callId,
            nodeId: invocation.nodeId,
            inputs: invocation.inputs,
            stateDirectory,
          }),
          timeoutMs: 12_000,
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        }, invocation, "invoke", null);
        launchByCall.set(callId, result.started);
        telemetryByCall.set(callId, result.telemetry);
        if (!result.started || result.timedOut || result.cancelled || result.exitCode !== 0 || result.outputLimitExceeded) {
          throw new Error(`Graph fixture for '${invocation.nodeId}' did not complete cleanly: ${result.stderr}`);
        }
        return result.stdout.trim();
      } finally {
        active.delete(callId);
      }
  };

  const provider: ProviderPort = {
    isAvailable: () => true,
    invoke(invocation) {
      const operation = invokeProcess(invocation);
      let tracked: Promise<void>;
      tracked = operation.then(
        () => { inFlight.delete(tracked); },
        () => { inFlight.delete(tracked); },
      );
      inFlight.add(tracked);
      return operation;
    },
    telemetryForCall(callId) { return telemetryByCall.get(callId) ?? null; },
    launchForCall(callId) { return launchByCall.get(callId) ?? null; },
  };

  return {
    provider,
    stateDirectory,
    invocations,
    activeNodeIds: () => [...active.values()],
    peakActiveCalls: () => peak,
    hasStarted: (nodeId) => existsSync(path.join(stateDirectory, `started-${nodeId}.json`)),
    hasFinished: (nodeId) => existsSync(path.join(stateDirectory, `finished-${nodeId}.json`)),
    release: (nodeId) => writeFileSync(path.join(stateDirectory, `release-${nodeId}`), "release\n", "utf8"),
    releaseAll: () => { for (const nodeId of expectedNodeIds) writeFileSync(path.join(stateDirectory, `release-${nodeId}`), "release\n", "utf8"); },
    async drain(timeoutMs = 13_000) {
      const deadline = Date.now() + timeoutMs;
      while (inFlight.size > 0) {
        if (Date.now() >= deadline) throw new Error(`Timed out draining ${inFlight.size} graph provider operation(s).`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    diagnostics: () => diagnosticSnapshot(project, stateDirectory, expectedNodeIds, active, invocations),
    waitForStarted: (nodeIds, signal) => waitForMarkers(nodeIds, (nodeId) => existsSync(path.join(stateDirectory, `started-${nodeId}.json`)), signal, () => diagnosticSnapshot(project, stateDirectory, expectedNodeIds, active, invocations)),
    waitForFinished: (nodeIds, signal) => waitForMarkers(nodeIds, (nodeId) => existsSync(path.join(stateDirectory, `finished-${nodeId}.json`)), signal, () => diagnosticSnapshot(project, stateDirectory, expectedNodeIds, active, invocations)),
  };
}

async function waitForMarkers(nodeIds: string[], present: (nodeId: string) => boolean, signal: AbortSignal | undefined, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!nodeIds.every(present)) {
    if (signal?.aborted) throw new Error("Graph fixture marker wait was aborted.");
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for graph fixture markers: ${nodeIds.join(", ")}. ${diagnostics()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function diagnosticSnapshot(
  project: string,
  stateDirectory: string,
  expectedNodeIds: string[],
  active: Map<string, string>,
  invocations: GraphProviderInvocationRecord[],
): string {
  const checkpoints = new Map<string, unknown>();
  const attemptEvidence = new Map<string, unknown>();
  const eventTails = new Map<string, unknown>();
  const transports = invocations.map((invocation) => {
    const runRoot = path.join(project, ".nodulus", "runs", invocation.runId);
    let graphNodes: Record<string, { phase?: unknown; failure?: unknown; attempt?: unknown }> | undefined;
    if (!checkpoints.has(invocation.runId)) {
      try {
        const checkpoint = JSON.parse(readFileSync(path.join(runRoot, "run.json"), "utf8")) as Record<string, unknown>;
        const graph = checkpoint.graph as { nodes?: typeof graphNodes; nextEventSequence?: unknown } | undefined;
        graphNodes = graph?.nodes;
        checkpoints.set(invocation.runId, graphNodes
          ? { nodes: Object.fromEntries(Object.entries(graphNodes).map(([nodeId, state]) => [nodeId, { phase: state.phase, failure: state.failure, attempt: state.attempt }])), nextEventSequence: graph?.nextEventSequence }
          : { readError: "checkpoint has no graph node state" });
      } catch (error) {
        checkpoints.set(invocation.runId, { readError: error instanceof Error ? error.message : String(error) });
      }
      try {
        const eventLines = readFileSync(path.join(runRoot, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
        eventTails.set(invocation.runId, eventLines.slice(-8));
      } catch (error) {
        eventTails.set(invocation.runId, { readError: error instanceof Error ? error.message : String(error) });
      }
      if (graphNodes) {
        const evidence = Object.fromEntries(Object.entries(graphNodes).map(([nodeId, state]) => {
          const attempt = typeof state.attempt === "number" && Number.isSafeInteger(state.attempt) && state.attempt > 0 ? state.attempt : undefined;
          if (attempt === undefined) return [nodeId, { phase: state.phase, attempt, files: {} }];
          const attemptRoot = path.join(runRoot, "nodes", nodeId, `attempt-${String(attempt).padStart(3, "0")}`);
          const values = Object.fromEntries(["invocation.json", "prompt.md", "response.raw.txt", "stderr.log", "result.json", "validation.json"].map((name) => {
            const file = path.join(attemptRoot, name);
            if (!existsSync(file)) return [name, { exists: false }];
            try {
              const text = readFileSync(file, "utf8");
              if (name === "stderr.log") return [name, { exists: true, text: text.slice(0, 500) }];
              if (name === "result.json" || name === "validation.json") {
                try {
                  const value = JSON.parse(text) as Record<string, unknown>;
                  return [name, { exists: true, summary: { status: value.status, valid: value.valid, code: value.code, error: value.error } }];
                } catch (error) { return [name, { exists: true, readError: error instanceof Error ? error.message : String(error) }]; }
              }
              return [name, { exists: true }];
            } catch (error) { return [name, { exists: true, readError: error instanceof Error ? error.message : String(error) }]; }
          }));
          return [nodeId, { phase: state.phase, attempt, files: values }];
        }));
        attemptEvidence.set(invocation.runId, evidence);
      }
    }
    try {
      const transport = JSON.parse(readFileSync(path.join(runRoot, "calls", invocation.callId, "transport.json"), "utf8")) as Record<string, unknown>;
      return {
        nodeId: invocation.nodeId,
        callId: invocation.callId,
        started: transport.started,
        exitCode: transport.exitCode,
        timedOut: transport.timedOut,
        cancelled: transport.cancelled,
        outputLimitExceeded: transport.outputLimitExceeded,
      };
    } catch (error) {
      return { nodeId: invocation.nodeId, callId: invocation.callId, readError: error instanceof Error ? error.message : String(error) };
    }
  });
  return `Provider fixture diagnostics: ${JSON.stringify({
    startedNodeIds: expectedNodeIds.filter((nodeId) => existsSync(path.join(stateDirectory, `started-${nodeId}.json`))),
    finishedNodeIds: expectedNodeIds.filter((nodeId) => existsSync(path.join(stateDirectory, `finished-${nodeId}.json`))),
    activeCalls: [...active].map(([callId, nodeId]) => ({ callId, nodeId })),
    checkpointNodes: Object.fromEntries(checkpoints),
    attemptEvidence: Object.fromEntries(attemptEvidence),
    eventTails: Object.fromEntries(eventTails),
    transports,
  })}`;
}

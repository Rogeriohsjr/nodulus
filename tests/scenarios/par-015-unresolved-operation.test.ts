import { existsSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { observeOwnedNativeProcesses } from "../support/owned-native-processes.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";
import { createGraphUnresolvedProvider, type GraphUnresolvedProviderFixture, type HeldOperation, type HeldBehavior } from "../support/graph-unresolved-provider.js";

type HeldCase = { operation: HeldOperation; behavior: HeldBehavior; cause: "graph_stop" | "profile_timeout"; profileTimeoutMs?: number };
const graceMs = 5000;
const stopWatchdogMs = 8000;
const profileTimeoutMs = 20_000;
const scenarioBudgetMs = 35_000;
const cleanupBudgetMs = 10_000;
const testBudgetMs = 50_000;

const cases: HeldCase[] = [
  { operation: "availability", behavior: "resolve", cause: "graph_stop" },
  { operation: "invoke", behavior: "resolve", cause: "graph_stop" },
  { operation: "repair_response", behavior: "reject", cause: "graph_stop" },
  { operation: "invoke", behavior: "resolve", cause: "profile_timeout", profileTimeoutMs },
];

test.each(cases)("PAR-015B2 seals late $operation after $cause ($behavior)", async (scenario) => {
  const project = createInitializedProject("par-015-unresolved-");
  const ownedProject = realpathSync.native(project);
  assertOwnedProject(project, ownedProject);
  configureScenario(project, scenario);
  const fixture = createGraphUnresolvedProvider(project, scenario);
  const nativeObserver = observeOwnedNativeProcesses();
  let runId: string | undefined;
  let filesAtReturn: Map<string, Buffer> | undefined;
  let returnedAt: number | undefined;
  let heldPid: number | undefined;
  let pidAliveAtReturn: boolean | undefined;
  let runError: unknown;
  let fixtureDrained = false;
  let processesSafe = false;
  const startedAt = performance.now();
  const runPromise = runWorkflow({
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline", text: "Prove that an unresolved provider operation cannot publish late graph results." }],
  }, fixture.provider).then((result) => {
    runId = result.runId;
    returnedAt = performance.now();
    pidAliveAtReturn = heldPid !== undefined && isProcessAlive(heldPid);
    filesAtReturn = snapshotRunFiles(project, result.runId);
    return { result };
  }, (error: unknown) => {
    runError = error;
    returnedAt = performance.now();
    return undefined;
  });

  let failure: unknown;
  let hasFailure = false;
  try {
    const heldKey = scenario.operation === "availability" ? "held-availability"
      : scenario.operation === "repair_response" ? "held-repair_response" : "held-invoke";
    const held = await fixture.waitForStarted(heldKey, Date.now() + 12_000);
    heldPid = held.pid;
    expect(held.pid).toBeGreaterThan(0);
    expect(held.aliveAtStart).toBe(true);
    expect(isProcessAlive(held.pid)).toBe(true);
    expect(nativeObserver.observationFailure).toBe(false);
    expect(nativeObserver.diagnostics.some((record) => record.pid === held.pid && record.stages.includes("spawn")),
      "The passive observer must capture the actual held fixture child before asserting its lifetime.").toBe(true);

    if (scenario.cause === "graph_stop") fixture.stopFailure();
    const operation = await waitForAbortedOperation(fixture, scenario.operation, Date.now() + scenarioBudgetMs, heldKey, () => ({
      returnedAt,
      publicError: runError instanceof Error ? runError.message.slice(0, 500) : runError === undefined ? undefined : "non-Error public rejection",
    }));
    expect(operation.signal?.aborted).toBe(true);
    if (scenario.cause === "graph_stop") {
      expect(operation.signal?.reason).toMatchObject({ source: "nodulus.graph", kind: "graph_stop", code: "GRAPH_CANCELLED" });
    } else {
      expect(operation.signal?.reason).toMatchObject({ source: "nodulus.graph", kind: "profile_timeout", code: "PROVIDER_TIMEOUT" });
    }
    const abortTimestamp = operation.abortedAt;
    expect(abortTimestamp).toBeTypeOf("number");
    if (abortTimestamp === undefined) throw new Error("Abort event was not timestamped by the external operation listener.");

    const stopDeadline = Date.now() + stopWatchdogMs;
    while (returnedAt === undefined && Date.now() < stopDeadline) await delay(20);
    expect(returnedAt, `Public API did not settle within ${stopWatchdogMs} ms after the observed stop while PID ${held.pid} remained held. ${fixture.diagnostics()}`).toBeDefined();
    if (returnedAt === undefined) throw new Error("Public API did not settle while the provider operation remained unresolved.");
    expect(returnedAt - abortTimestamp).toBeGreaterThanOrEqual(graceMs);
    expect(returnedAt - startedAt).toBeLessThanOrEqual(scenarioBudgetMs);
    expect(pidAliveAtReturn, "The owned external PID must be live at first public settlement, before runtime-file reads.").toBe(true);
    expect(runError, "The graph run should return its structured error result.").toBeUndefined();
    if (runError !== undefined || !runId) throw runError ?? new Error("Run ID was not returned.");
    if (!filesAtReturn) throw new Error("Runtime file snapshot was not captured at public settlement.");

    const result = (await runPromise)?.result;
    expect(result?.status).toBe("error");
    if (!result) throw new Error("Public run result is absent.");
    const checkpoint = readCheckpoint(project, runId);
    const graph = checkpoint.graph as { admissionClosed: boolean; nodes: Record<string, Record<string, unknown>> };
    const heldNode = graph.nodes.held;
    expect(graph.admissionClosed).toBe(true);
    expect((graph as unknown as { recoveryRequired?: boolean }).recoveryRequired).toBe(true);
    expect((graph as unknown as { uncertainNodeIds?: string[] }).uncertainNodeIds).toEqual(["held"]);
    expect(heldNode).toMatchObject({
      phase: "active",
      recoveryRequired: true,
      interruption: { code: "GRAPH_OPERATION_UNRESOLVED", message: expect.any(String) },
      callId: expect.any(String),
    });
    expect(heldNode.failure).toBeUndefined();
    const resultPayload = result.result as { error?: Record<string, unknown> };
    expect(resultPayload.error).toMatchObject(scenario.cause === "graph_stop"
      ? { code: "P15B2_STOP_TRIGGER", nodeId: "stopper", recoveryRequired: true, uncertainNodeIds: ["held"] }
      : { code: "PROVIDER_TIMEOUT", nodeId: "held", recoveryRequired: true, uncertainNodeIds: ["held"] });
    const events = readEvents(project, runId);
    const heldCallId = String(heldNode.callId);
    const startedEvent = events.find((event) => event.event === "node.started" && event.nodeId === "held");
    expect(heldNode.attempt).toBe(scenario.operation === "repair_response" ? 2 : 1);
    expect(startedEvent?.callId).toEqual(expect.any(String));
    expect(events.filter((event) => event.event === "node.recovery_required" && event.nodeId === "held")).toHaveLength(1);
    expect(events.some((event) => event.event === "provider.call.completed" && event.callId === heldCallId)).toBe(false);
    expect(events.some((event) => event.event === "node.started" && event.nodeId === "dependent")).toBe(false);
    expect(existsSync(path.join(project, ".nodulus", "runs", runId, "nodes", "held", "artifacts", "report.json"))).toBe(false);

    if (scenario.operation === "availability") {
      expect(heldNode.launch).toBe(false);
      expect(heldNode.callId).toBe(startedEvent?.callId);
      expect(events.some((event) => event.event === "provider.call.completed" && event.callId === heldCallId && event.operation === "invoke")).toBe(false);
      expect(existsSync(path.join(project, ".nodulus", "runs", runId, "calls", heldCallId, "transport.json"))).toBe(false);
    } else {
      const heldRecord = fixture.operations.find((entry) => entry.nodeId === "held" && entry.operation === scenario.operation);
      expect(heldRecord?.signal?.aborted).toBe(true);
      expect(heldRecord?.callId).toBe(heldCallId);
      if (scenario.operation === "invoke") {
        expect(heldNode.launch).toBe(true);
        expect(heldNode.callId).toBe(startedEvent?.callId);
        expect(fixture.processes.find(({ key }) => key === "held-invoke")?.pid).toBe(held.pid);
      }
      if (scenario.operation === "repair_response") {
        expect(heldRecord?.parentCallId).toEqual(expect.any(String));
        expect(heldNode.launch).toBe(true);
        expect(fixture.processes.find(({ key }) => key === "held-repair_response")?.pid).toBe(held.pid);
        expect(events.some((event) => event.event === "provider.call.completed" && event.callId === heldRecord?.parentCallId)).toBe(true);
        expect(events.some((event) => event.event === "provider.call.completed" && event.callId === heldCallId)).toBe(false);
      }
    }

    // The fixture child remains externally held until after the public-return snapshot.
    expect([...filesAtReturn.keys()].some((name) => name.endsWith("events.jsonl"))).toBe(true);
  } catch (error) {
    failure = error;
    hasFailure = true;
  } finally {
    const cleanupErrors: unknown[] = [];
    try { fixture.releaseAll(); }
    catch (error) { cleanupErrors.push(error); }
    const cleanupDeadline = Date.now() + cleanupBudgetMs;
    try {
      if (returnedAt === undefined) {
        while (returnedAt === undefined && Date.now() < cleanupDeadline) await delay(20);
      }
      await fixture.drain(cleanupDeadline);
      fixtureDrained = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (fixtureDrained) {
      try {
        if (scenario.operation === "repair_response") {
          const rejectedChild = fixture.processes.find(({ key }) => key === "held-repair_response");
          expect(rejectedChild?.exitCode, "The late rejection must come from the actual released child process.").toBe(23);
        } else {
          const resolvedKey = scenario.operation === "availability" ? "held-availability" : "held-invoke";
          expect(fixture.processes.find(({ key }) => key === resolvedKey)?.exitCode, "The late valid response must come from the actual released child process.").toBe(0);
          expect(existsSync(path.join(fixture.controlDirectory, `finished-${resolvedKey}.json`))).toBe(true);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (runId && filesAtReturn) {
          const afterLateSettlement = snapshotRunFiles(project, runId);
          expect(afterLateSettlement).toEqual(filesAtReturn);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    let nativeObserverDrained = false;
    try {
      await nativeObserver.drain(cleanupDeadline);
      nativeObserverDrained = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (nativeObserverDrained) {
      try {
        const observedChildren = nativeObserver.diagnostics;
        expect(nativeObserver.observationFailure).toBe(false);
        expect(observedChildren.length).toBeGreaterThan(0);
        expect(fixture.processes.length).toBeGreaterThan(0);
        for (const processRecord of fixture.processes) {
          expect(processRecord.closeObserved, `Fixture child '${processRecord.key}' must have an actual close event.`).toBe(true);
          expect(observedChildren.some((record) => record.pid === processRecord.pid
            && record.stages.includes("spawn") && record.stages.includes("close")),
          `Passive native observation must confirm spawn and close for fixture child '${processRecord.key}'.`).toBe(true);
        }
        processesSafe = fixture.processes.every(({ closeObserved }) => closeObserved);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const cleanupVerified = fixtureDrained && processesSafe && cleanupErrors.length === 0 && runId !== undefined && returnedAt !== undefined;
    if (!hasFailure && cleanupVerified) {
      try {
        assertOwnedProject(project, ownedProject);
        rmSync(project, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else if (!cleanupVerified) {
      cleanupErrors.push(new Error(`Retaining owned project because run/provider cleanup or verification is unconfirmed. ${fixture.diagnostics()}`));
    }
    if (cleanupErrors.length > 0) {
      failure = hasFailure ? new AggregateError([failure, ...cleanupErrors], "B2 assertion and cleanup both failed.")
        : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "B2 cleanup failed.");
      hasFailure = true;
    }
  }
  if (hasFailure) throw failure;
}, testBudgetMs);

function configureScenario(project: string, scenario: HeldCase): void {
  configureParallelProject(project);
  const workflow = readParallelWorkflow(project);
  workflow.nodes = scenario.cause === "profile_timeout" ? ["held"] : ["held", "stopper", "dependent"];
  workflow.execution.maxConcurrency = scenario.cause === "profile_timeout" ? 1 : 2;
  workflow.execution.dependsOn = scenario.cause === "profile_timeout"
    ? { held: [] }
    : { held: [], stopper: [], dependent: ["held"] };
  workflow.execution.resources = Object.fromEntries(workflow.nodes.map((id) => [id, []]));
  workflow.outputs = [{ name: "held", from: "held.report", contract: "report.v1" }];
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  for (const nodeId of workflow.nodes) {
    const profileId = `fixture-${nodeId}`;
    profiles[profileId] = {
      ...profiles.fixture,
      enabled: true,
      model: `p15b2-${nodeId}`,
      timeoutMs: nodeId === "held" ? scenario.profileTimeoutMs ?? 60_000 : 60_000,
      capabilities: nodeId === "held" && scenario.operation === "repair_response" ? ["responseRepair"] : [],
    };
    const nodePath = `.nodulus/nodes/${nodeId}.json`;
    const node = nodeId === "held" ? readProjectJson(project, ".nodulus/nodes/prepare.json") : structuredClone(readProjectJson(project, ".nodulus/nodes/audit.json"));
    node.id = nodeId;
    node.providerProfile = profileId;
    node.instructions = [`.nodulus/instructions/${nodeId}.md`];
    node.inputs = nodeId === "dependent" ? { report: { from: "held.report", contract: "report.v1" } } : { request: { from: "request", contract: "request.v1" } };
    node.expectedOutputs = [{ name: "report", contract: "report.v1" }];
    writeJson(project, nodePath, node);
    writeFileSync(path.join(project, ".nodulus", "instructions", `${nodeId}.md`), `Instructions for ${nodeId}.\n`, "utf8");
  }
  writeJson(project, ".nodulus/settings.json", settings);
}

function assertOwnedProject(project: string, identity: string): void {
  const tempRoot = realpathSync.native(os.tmpdir());
  if (path.dirname(identity) !== tempRoot || path.basename(identity).startsWith("nodulus-par-015-unresolved-") !== true || realpathSync.native(project) !== identity) {
    throw new Error(`Refusing cleanup outside the exact owned P15B2 fixture: '${identity}'.`);
  }
}

function readCheckpoint(project: string, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", runId, "run.json"), "utf8")) as Record<string, unknown>;
}

function readEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(project, ".nodulus", "runs", runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function snapshotRunFiles(project: string, runId: string): Map<string, Buffer> {
  const root = path.join(project, ".nodulus", "runs", runId);
  const files = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }) as Dirent[]) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.set(path.relative(root, absolute).split(path.sep).join("/"), readFileSync(absolute));
      else throw new Error(`Unexpected non-file entry in runtime-owned run tree: '${absolute}'.`);
    }
  };
  visit(root);
  return files;
}

async function waitForAbortedOperation(
  fixture: GraphUnresolvedProviderFixture,
  operation: HeldOperation,
  deadline: number,
  heldKey: string,
  getPublicSettlement: () => { returnedAt?: number; publicError?: string },
) {
  while (Date.now() < deadline) {
    const entry = fixture.operations.find((candidate) => candidate.nodeId === "held" && candidate.operation === operation);
    const processRecord = fixture.processes.find((record) => record.key === heldKey);
    if (entry?.signal?.aborted) {
      const signalAt = entry.abortedAt;
      const publicSettlement = getPublicSettlement();
      if (signalAt !== undefined && processRecord?.closedAtMonotonicMs !== undefined && processRecord.closedAtMonotonicMs < signalAt) {
        throw new Error(`Held provider process closed before its abort signal; ${fixture.diagnostics()}`);
      }
      if (signalAt !== undefined && publicSettlement.returnedAt !== undefined && publicSettlement.returnedAt < signalAt) {
        throw new Error(`Public run settled before the held operation was aborted (error=${publicSettlement.publicError ?? "none"}); ${fixture.diagnostics()}`);
      }
      return entry;
    }
    if (processRecord?.closeObserved) throw new Error(`Held provider process closed before the expected ${operation} abort; ${fixture.diagnostics()}`);
    const publicSettlement = getPublicSettlement();
    if (publicSettlement.returnedAt !== undefined) {
      throw new Error(`Public run settled before the expected ${operation} abort (error=${publicSettlement.publicError ?? "none"}); ${fixture.diagnostics()}`);
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for held ${operation} abort signal. ${fixture.diagnostics()}`);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

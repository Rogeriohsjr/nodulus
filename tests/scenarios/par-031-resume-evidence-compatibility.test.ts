import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import type { ProviderTelemetry } from "../../src/core/ports/provider-telemetry.js";
import { resumeWorkflow, runWorkflow, type ApplicationRunResult, type ProviderInvocation, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type ProviderMode = "codex" | "opaque" | "opaque-measurement" | "opaque-enum";
type MalformedMeasurement = "negative-counter" | "throwing-enum";
type PublicOutcome = { kind: "result"; result: ApplicationRunResult } | { kind: "error"; error: unknown };
type ProviderMarker = { nodeId: string; runId: string; callId: string; attempt: number; pid: number };
type PendingRequest = { id: string; nodeId: string; attempt: number; callId: string; questions: Array<{ id: string; message: string }>; answerContract: Record<string, unknown> };
type AcceptedRecord = {
  attempt: number;
  callId: string;
  resultRef: string;
  resultSha256: string;
  validationRef: string;
  validationSha256: string;
  responseRef: string;
  responseSha256: string;
  artifacts: Array<{ name: string; contract: string; ref: string; sha256: string }>;
};
type GraphCheckpoint = {
  runId: string;
  status: string;
  completedNodes: string[];
  diagnostics?: unknown[];
  graph: {
    nodes: Record<string, { phase?: string; attempt?: number; callId?: string; launch?: boolean | null; accepted?: AcceptedRecord }>;
    pendingRequests: Record<string, Record<string, unknown>>;
  };
};
type InvocationObservation = { nodeId: string; callId?: string; attempt: number; operation?: string; parentCallId?: string; answers?: Record<string, unknown> };
type Observations = {
  availability: string[];
  invocations: InvocationObservation[];
  repairs: number;
  telemetry: number;
  launches: number;
  legacyUsage: number;
  publicSettlements: Array<Promise<void>>;
  delegatedSettlements: Array<Promise<void>>;
  childProcesses: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }>;
};
type Activity = Pick<Observations, "availability" | "invocations" | "repairs" | "telemetry" | "launches" | "legacyUsage">;
type CapturedFile = { bytes: Buffer; sha256: string };
type InitialState = {
  runId: string;
  seed: ProviderMarker;
  a: ProviderMarker;
  b: ProviderMarker;
  requests: { a: PendingRequest; b: PendingRequest };
  inputBytes: Buffer;
  events: Array<Record<string, unknown>>;
  metrics: unknown[];
  immutableFiles: Map<string, CapturedFile>;
};

const fixtureSource = fileURLToPath(new URL("../fixtures/par-031-compatible-provider.mjs", import.meta.url));
const roles = ["seed", "a", "b"] as const;
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const testCeilingMs = 35_000;
const profileTimeoutMs = 20_000;
const fixtureLifetimeMs = 60_000;

test.each([
  { mode: "codex" as const, label: "default Codex transport and reversed seed artifact order" },
  { mode: "opaque" as const, label: "opaque child provider with unknown launch evidence" },
  { mode: "opaque-measurement" as const, label: "opaque provider optional measurements remain resume-compatible" },
  { mode: "opaque-enum" as const, label: "opaque provider non-string measurement enum remains resume-compatible" },
])("PAR-031 resumes compatible $label evidence with A still pending", async ({ mode }) => {
  await runCompatibilityScenario(mode);
}, testCeilingMs);

async function runCompatibilityScenario(mode: ProviderMode): Promise<void> {
  const scenarioDeadline = Date.now() + scenarioBudgetMs;
  const label = `par-031-resume-evidence-${mode}-café`;
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const stateDirectory = path.join(fixtureDirectory, "par-031-compatible-state");
  const eventsPath = path.join(stateDirectory, "events.jsonl");
  const startedPaths: Record<string, string> = {};
  for (const role of roles) {
    for (const attempt of [1, 2]) startedPaths[`${role}-${attempt}`] = path.join(stateDirectory, `${role}-${attempt}.started.json`);
  }
  const releasePaths = { a: path.join(stateDirectory, "release-a"), b: path.join(stateDirectory, "release-b") };
  const observations: Observations = {
    availability: [], invocations: [], repairs: 0, telemetry: 0, launches: 0, legacyUsage: 0,
    publicSettlements: [], delegatedSettlements: [], childProcesses: [],
  };
  let initialRun: Promise<PublicOutcome> | undefined;
  let observedInitial: PublicOutcome | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];

  try {
    assertOwnedProject(project, projectIdentity, label);
    const sentinels = configureProject(project, mode, eventsPath, stateDirectory, startedPaths, releasePaths);
    assertBeforeDeadline(scenarioDeadline, "project setup");

    const provider = mode === "codex"
      ? createObservedDefaultProvider(project, observations)
      : createOpaqueProvider(project, observations, mode === "opaque-measurement" ? "negative-counter" : mode === "opaque-enum" ? "throwing-enum" : undefined);
    initialRun = capturePublic(runWorkflow(request(project), provider), observations);
    void initialRun.then((outcome) => { observedInitial = outcome; });

    const seedPromise = waitForMarker(startedPaths["seed-1"]!, "seed inference", scenarioDeadline, () => observedInitial);
    const acceptedSeedPromise = seedPromise.then((marker) => waitForAcceptedSeed(project, marker.runId, scenarioDeadline, () => observedInitial));
    const aPromise = waitForMarker(startedPaths["a-1"]!, "A initial question", scenarioDeadline, () => observedInitial);
    const bPromise = waitForMarker(startedPaths["b-1"]!, "B initial question", scenarioDeadline, () => observedInitial);
    const [seedMarker, , aMarker, bMarker] = await withDeadline(
      Promise.all([seedPromise, acceptedSeedPromise, aPromise, bPromise]), scenarioDeadline, "seed acceptance and both question barriers",
    );
    expect(aMarker).toMatchObject({ nodeId: "a", runId: seedMarker.runId, attempt: 1 });
    expect(bMarker).toMatchObject({ nodeId: "b", runId: seedMarker.runId, attempt: 1 });
    expect(isProcessAlive(aMarker.pid), "A's real first-question child must be alive before releasing either branch.").toBe(true);
    expect(isProcessAlive(bMarker.pid), "B's real first-question child must be alive before releasing either branch.").toBe(true);

    const initialRunRoot = runDirectory(project, seedMarker.runId);
    assertSeedAlreadyAccepted(project, seedMarker.runId, mode);
    writeFileSync(releasePaths.a, "release\n", { encoding: "utf8", flag: "wx" });
    const aRequest = await waitForQuestion(project, seedMarker.runId, aMarker, scenarioDeadline, () => observedInitial);
    const checkpointWhileBActive = readCheckpoint(project, seedMarker.runId);
    expect(checkpointWhileBActive.graph.pendingRequests[aRequest.id]).toMatchObject({ nodeId: "a", kind: "node" });
    expect(isProcessAlive(bMarker.pid), "B must remain active after A's question becomes durable.").toBe(true);
    expect(checkpointWhileBActive.graph.nodes.b?.phase).toBe("active");
    writeFileSync(releasePaths.b, "release\n", { encoding: "utf8", flag: "wx" });

    const initialOutcome = await withDeadline(initialRun, scenarioDeadline, "initial two-question pause");
    const initial = requireResult(initialOutcome, "initial graph run");
    expect(initial.runId).toBe(seedMarker.runId);
    expect(initial.status, describeOutcome(initialOutcome)).toBe("needs_input");
    const initialProjection = asRequestProjection(initial.result);
    expect(initialProjection.requests.map((item) => item.nodeId)).toEqual(["a", "b"]);
    const bRequest = initialProjection.requests.find((item) => item.nodeId === "b");
    const returnedA = initialProjection.requests.find((item) => item.nodeId === "a");
    expect(returnedA).toEqual(aRequest);
    if (!bRequest) throw new Error("PAR-031 compatibility pause did not return B's runtime question.");
    expect(isUuid(aRequest.id)).toBe(true);
    expect(isUuid(bRequest.id)).toBe(true);
    expect(aRequest.id).not.toBe("provider-untrusted-a");
    expect(bRequest.id).not.toBe("provider-untrusted-b");
    expect(aRequest.answerContract).toEqual({
      type: "object",
      required: ["aApproval"],
      properties: { aApproval: { const: "A-approved", type: "string" } },
      additionalProperties: false,
    });
    expect(bRequest.answerContract).toEqual({
      type: "object",
      required: ["bApproval"],
      properties: { bApproval: { const: "B-approved", type: "string" } },
      additionalProperties: false,
    });

    const aFinalMarker = await waitForQuestionEvidence(project, seedMarker.runId, aMarker, scenarioDeadline);
    const bFinalMarker = await waitForQuestionEvidence(project, seedMarker.runId, bMarker, scenarioDeadline);
    expect(aFinalMarker).toEqual(aRequest);
    expect(bFinalMarker).toEqual(bRequest);
    const initialState = captureInitialState(project, seedMarker.runId, { seed: seedMarker, a: aMarker, b: bMarker }, { a: aRequest, b: bRequest });
    expect(initialState.metrics).toHaveLength(3);
    expect(observations.invocations.map((call) => call.nodeId).sort(compareStrings)).toEqual(["a", "b", "seed"]);
    expect(observations.invocations).toHaveLength(3);
    expect(readFixtureEvents(eventsPath).filter((event) => event.stage === (mode === "codex" ? "inference-started" : "opaque-inference-started"))).toHaveLength(3);
    expect(existsSync(sentinels.providerSentinel)).toBe(false);
    expect(existsSync(sentinels.validatorSentinel)).toBe(false);

    let malformedMeasurementCallId: string | undefined;
    if (mode === "codex") assertCodexSeedOrder(project, seedMarker.runId, initialState);
    else {
      assertOpaqueEvidence(project, seedMarker.runId, initialState, mode === "opaque-measurement" || mode === "opaque-enum");
      if (mode === "opaque-measurement") {
        malformedMeasurementCallId = assertOptionalMeasurementCapture(project, seedMarker.runId, aMarker.callId, initialState);
      }
      if (mode === "opaque-enum") {
        malformedMeasurementCallId = assertOptionalEnumCapture(project, seedMarker.runId, aMarker.callId, initialState);
      }
      if (mode === "opaque") {
        const runEventsPath = path.join(initialRunRoot, "events.jsonl");
        const originalRunEventBytes = readFileSync(runEventsPath);
        const originalEventText = originalRunEventBytes.toString("utf8");
        const eventLines = originalEventText.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line) => line.length > 0) ?? [];
        const originalEventLines = [...eventLines];
        const parsedLines = eventLines.map((line) => JSON.parse(line.replace(/(?:\r\n|\n|\r)$/, "")) as Record<string, unknown>);
        const runTreeBeforeCorruption = snapshotRunTree(project, seedMarker.runId);
        const targetIndices = parsedLines.flatMap((event, index) => event.event === "provider.call.completed"
          && event.callId === aMarker.callId && event.nodeId === "a" ? [index] : []);
        expect(targetIndices).toHaveLength(1);
        const targetIndex = targetIndices[0];
        if (targetIndex === undefined) throw new Error("PAR-031 opaque A completion event is missing or duplicated before corruption.");
        const targetEvent = parsedLines[targetIndex]!;
        expect(targetEvent.launched).toBeNull();
        const expectedCorruptEvent = { ...targetEvent, launched: false };
        const targetLineEnding = eventLines[targetIndex]!.match(/(?:\r\n|\n|\r)$/)?.[0] ?? "";
        eventLines[targetIndex] = `${JSON.stringify(expectedCorruptEvent)}${targetLineEnding}`;
        const writtenCorruptText = eventLines.join("");
        const writtenCorruptLines = writtenCorruptText.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line) => line.length > 0) ?? [];
        expect(writtenCorruptLines).toHaveLength(eventLines.length);
        for (let index = 0; index < eventLines.length; index += 1) {
          if (index !== targetIndex) expect(Buffer.from(writtenCorruptLines[index]!)).toEqual(Buffer.from(originalEventLines[index]!));
        }
        expect(JSON.parse(writtenCorruptLines[targetIndex]!.replace(/(?:\r\n|\n|\r)$/, ""))).toEqual(expectedCorruptEvent);
        expect(expectedCorruptEvent).toEqual({ ...targetEvent, launched: false });
        writeFileSync(runEventsPath, writtenCorruptText, "utf8");

        const runTreeAtCorruption = snapshotRunTree(project, seedMarker.runId);
        const fixtureEventsAtCorruption = readFileSync(eventsPath);
        const activityAtCorruption = snapshotActivity(observations);
        const corruptResume = capturePublic(resumeWorkflow({
          projectRoot: project,
          runId: seedMarker.runId,
          requestId: aRequest.id,
          answers: answerFor("a"),
        }, provider), observations);
        const corruptOutcome = await withDeadline(corruptResume, scenarioDeadline, "opaque launch-consistency rejection");
        expect(corruptOutcome.kind, describeOutcome(corruptOutcome)).toBe("error");
        if (corruptOutcome.kind !== "error" || !isRecord(corruptOutcome.error)) {
          throw new Error("PAR-031 opaque launch-consistency resume did not reject with a structured error.");
        }
        expect(corruptOutcome.error.code).toBe("RUN_STATE_INVALID");
        expect(snapshotRunTree(project, seedMarker.runId)).toEqual(runTreeAtCorruption);
        expect(readFileSync(eventsPath).equals(fixtureEventsAtCorruption)).toBe(true);
        expect(snapshotActivity(observations)).toEqual(activityAtCorruption);

        writeFileSync(runEventsPath, originalRunEventBytes);
        expect(readFileSync(runEventsPath).equals(originalRunEventBytes)).toBe(true);
        expect(snapshotRunTree(project, seedMarker.runId)).toEqual(runTreeBeforeCorruption);
      }
    }

    const fixtureEventsBeforePartial = readFileSync(eventsPath);
    const activityBeforePartial = snapshotActivity(observations);
    const runTreeBeforePartial = snapshotRunTree(project, seedMarker.runId);
    const metricsPath = path.join(initialRunRoot, "metrics.json");
    const metricBytesBeforePartial = readFileSync(metricsPath);
    const answeredAPromise = capturePublic(resumeWorkflow({
      projectRoot: project,
      runId: seedMarker.runId,
      requestId: aRequest.id,
      answers: answerFor("a"),
    }, provider), observations);
    const answeredAOutcome = await withDeadline(answeredAPromise, scenarioDeadline, "A partial answer while B remains unanswered");

    if (mode === "opaque-measurement" && answeredAOutcome.kind === "error") {
      const error = answeredAOutcome.error;
      expect(isRecord(error) ? error.code : undefined).toBe("RUN_STATE_INVALID");
      const message = describeUnknownError(error);
      expect(message).toMatch(/measurement|telemetry/i);
      expect(message.length).toBeLessThanOrEqual(500);
      expect(snapshotRunTree(project, seedMarker.runId)).toEqual(runTreeBeforePartial);
      expect(readFileSync(metricsPath).equals(metricBytesBeforePartial)).toBe(true);
      expect(readFileSync(eventsPath).equals(fixtureEventsBeforePartial)).toBe(true);
      expect(snapshotActivity(observations)).toEqual(activityBeforePartial);
    }
    if (mode === "opaque-enum" && answeredAOutcome.kind === "error") {
      const error = answeredAOutcome.error;
      const isResumeStateError = isRecord(error) && error.code === "RUN_STATE_INVALID";
      const isCoercionError = error instanceof TypeError || (isRecord(error) && error.cause instanceof TypeError);
      expect(isResumeStateError || isCoercionError, describeOutcome(answeredAOutcome)).toBe(true);
      expect(describeUnknownError(error).length).toBeLessThanOrEqual(500);
    }
    expect(answeredAOutcome.kind, describeOutcome(answeredAOutcome)).toBe("result");

    const partial = requireResult(answeredAOutcome, "partial A resume");
    expect(partial.status, describeOutcome(answeredAOutcome)).toBe("needs_input");
    const partialProjection = asRequestProjection(partial.result);
    expect(partialProjection.requests.map((item) => item.nodeId)).toEqual(["b"]);
    expect(partialProjection.request).toEqual(partialProjection.requests[0]);
    expect(partialProjection.requests[0]).toEqual(bRequest);
    expect(snapshotActivity(observations)).toEqual(activityBeforePartial);
    expect(readFileSync(eventsPath).equals(fixtureEventsBeforePartial)).toBe(true);
    expect(snapshotRunTree(project, seedMarker.runId)).not.toEqual(runTreeBeforePartial);
    assertHistoryPrefix(project, seedMarker.runId, initialState);
    assertImmutableEvidence(project, seedMarker.runId, initialState.immutableFiles);
    assertAnswerCommit(project, seedMarker.runId, aRequest, answerFor("a"), initialState.events.length);
    const partialCheckpoint = readCheckpoint(project, seedMarker.runId);
    if (mode === "opaque-measurement" || mode === "opaque-enum") {
      expect(readFileSync(metricsPath).equals(metricBytesBeforePartial)).toBe(true);
      expect(readMetrics(project, seedMarker.runId)).toEqual(initialState.metrics);
      const appendedEvents = readRunEvents(project, seedMarker.runId).slice(initialState.events.length);
      expect(appendedEvents.filter((event) => event.event === "provider.call.started" || event.event === "provider.call.completed")).toHaveLength(0);
      assertBoundedMeasurementDiagnostic(partialCheckpoint, malformedMeasurementCallId);
    }
    expect(partialCheckpoint.status).toBe("needs_input");
    expect(partialCheckpoint.graph.pendingRequests[aRequest.id]).toMatchObject({ nodeId: "a", answerRef: `answers/${aRequest.id}.json` });
    expect(partialCheckpoint.graph.pendingRequests[bRequest.id]).toMatchObject({ nodeId: "b", kind: "node" });
    expect(readFileSync(path.join(initialRunRoot, "inputs.json")).equals(initialState.inputBytes)).toBe(true);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  for (const releasePath of Object.values(releasePaths)) {
    try {
      mkdirSync(path.dirname(releasePath), { recursive: true });
      if (!existsSync(releasePath)) writeFileSync(releasePath, "cleanup release\n", { encoding: "utf8", flag: "wx" });
    } catch (error) { if (!isAlreadyExists(error)) cleanupErrors.push(asError(error)); }
  }

  let publicDrained = false;
  let delegatedDrained = false;
  let childrenClosed = false;
  try {
    await withDeadline(Promise.all(observations.publicSettlements), cleanupDeadline, "public workflow settlements");
    publicDrained = true;
  } catch (error) { cleanupErrors.push(asError(error)); }
  try {
    await withDeadline(Promise.all(observations.delegatedSettlements), cleanupDeadline, "delegated provider settlements");
    delegatedDrained = true;
  } catch (error) { cleanupErrors.push(asError(error)); }
  try {
    const childResults = await withDeadline(Promise.allSettled(observations.childProcesses.map(({ closed }) => closed)), cleanupDeadline, "opaque provider child close events");
    const rejectedChild = childResults.find((result) => result.status === "rejected");
    if (rejectedChild?.status === "rejected") throw rejectedChild.reason;
    childrenClosed = true;
  } catch (error) { cleanupErrors.push(asError(error)); }
  const noPrimaryFailure = !hasPrimaryError;
  const allOperationsDrained = publicDrained && delegatedDrained && childrenClosed;
  if (noPrimaryFailure && allOperationsDrained && cleanupErrors.length === 0) {
    try {
      assertOwnedProject(project, projectIdentity, label);
      rmSync(project, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(asError(error)); }
  }

  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], `PAR-031 compatibility project retained at ${project}; scenario and cleanup reported failures.`);
  if (hasPrimaryError) throw new Error(`PAR-031 compatibility project retained at ${project} after scenario failure: ${describeUnknownError(primaryError)}`, { cause: primaryError });
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `PAR-031 compatibility project retained at ${project} after cleanup uncertainty.`);
}

function configureProject(
  project: string,
  mode: ProviderMode,
  eventsPath: string,
  stateDirectory: string,
  startedPaths: Record<string, string>,
  releasePaths: Record<"a" | "b", string>,
): { providerSentinel: string; validatorSentinel: string } {
  const sentinels = configureParallelProject(project);
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const projectFixture = path.join(fixtureDirectory, "par-031-compatible-provider.mjs");
  writeFileSync(projectFixture, readFileSync(fixtureSource, "utf8"), "utf8");
  writeFileSync(path.join(fixtureDirectory, "par-031-compatible-control.json"), JSON.stringify({
    mode: mode === "codex" ? "codex" : "opaque",
    eventsPath: path.relative(project, eventsPath),
    fixtureLifetimeMs,
    startedPaths: Object.fromEntries(Object.entries(startedPaths).map(([key, value]) => [key, path.relative(project, value)])),
    releasePaths: Object.fromEntries(Object.entries(releasePaths).map(([key, value]) => [key, path.relative(project, value)])),
  }), "utf8");

  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  const baseProfile = profiles.fixture ?? {};
  for (const role of roles) {
    let executable = projectFixture;
    if (mode === "codex") {
      executable = path.join(fixtureDirectory, process.platform === "win32" ? `par-031-${role}.cmd` : `par-031-${role}.sh`);
      if (process.platform === "win32") {
        writeFileSync(executable, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-031-compatible-provider.mjs" "${role}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
      } else {
        writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-031-compatible-provider.mjs' '${role}' "$@"\n`, "utf8");
        chmodSync(executable, 0o755);
      }
    }
    profiles[role] = {
      ...baseProfile,
      enabled: true,
      executable,
      kind: "codex",
      model: `p4b1-${mode}-${role}`,
      timeoutMs: profileTimeoutMs,
      capabilities: [],
      sandbox: "read-only",
    };
  }
  writeJson(project, ".nodulus/settings.json", settings);

  const workflow = readParallelWorkflow(project);
  workflow.nodes = ["seed", "a", "b"];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { seed: [], a: ["seed"], b: ["seed"] };
  workflow.execution.resources = { seed: [], a: [], b: [] };
  workflow.outputs = [
    { name: "bFinal", from: "b.report", contract: "report.v1" },
    { name: "aFinal", from: "a.report", contract: "report.v1" },
  ];
  writeJson(project, ".nodulus/workflows/example.json", workflow);

  const template = readProjectJson(project, ".nodulus/nodes/prepare.json");
  for (const nodeId of roles) {
    const instruction = `.nodulus/instructions/${nodeId}.md`;
    writeFileSync(path.join(project, instruction), `P4B1 compatibility instructions for ${nodeId}.\n`, "utf8");
    const inputs = nodeId === "seed"
      ? { request: { from: "request", contract: "request.v1" } }
      : { report: { from: `seed.${nodeId === "a" ? "alpha" : "beta"}`, contract: "report.v1" } };
    writeJson(project, `.nodulus/nodes/${nodeId}.json`, {
      ...template,
      id: nodeId,
      providerProfile: nodeId,
      instructions: [instruction],
      inputs,
      expectedOutputs: nodeId === "seed"
        ? [{ name: "alpha", contract: "report.v1" }, { name: "beta", contract: "report.v1" }]
        : [{ name: "report", contract: "report.v1" }],
    });
  }
  return sentinels;
}

function createObservedDefaultProvider(project: string, observations: Observations): ProviderPort {
  const delegate = createDefaultProviderPort(project);
  const provider: ProviderPort = {
    async invoke(invocation) {
      recordInvocation(observations, invocation);
      return trackDelegated(delegate.invoke(invocation), observations);
    },
    ...(delegate.isAvailable ? { async isAvailable(profile, options) {
      observations.availability.push(typeof profile.model === "string" ? profile.model : "unknown");
      return trackDelegated(delegate.isAvailable!(profile, options), observations);
    } } : {}),
    ...(delegate.repairResponse ? { async repairResponse(invocation, previousRawResponse, validationErrors) {
      observations.repairs += 1;
      return trackDelegated(delegate.repairResponse!(invocation, previousRawResponse, validationErrors), observations);
    } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall(callId) {
      observations.telemetry += 1;
      return delegate.telemetryForCall!(callId);
    } } : {}),
    ...(delegate.launchForCall ? { launchForCall(callId) {
      observations.launches += 1;
      return delegate.launchForCall!(callId);
    } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall() {
      observations.legacyUsage += 1;
      return delegate.usageForLastCall!();
    } } : {}),
  };
  return provider;
}

function createOpaqueProvider(project: string, observations: Observations, malformedMeasurement?: MalformedMeasurement): ProviderPort {
  const executable = fixtureSource;
  const telemetryByCall = new Map<string, ProviderTelemetry>();
  return {
    invoke(invocation) {
      recordInvocation(observations, invocation);
      const callId = invocation.call?.callId;
      if (malformedMeasurement && invocation.nodeId === "a" && callId) {
        const isThrowingEnum = malformedMeasurement === "throwing-enum";
        telemetryByCall.set(callId, {
          schemaVersion: 1,
          callId,
          provider: "opaque-fixture",
          cliVersion: null,
          reportedModel: null,
          reported: isThrowingEnum
            ? { inputTokens: 120, outputTokens: 34, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: null }
            : { inputTokens: -1, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: null },
          normalized: isThrowingEnum ? { inputTokens: 120, outputTokens: 34 } : { inputTokens: -1, outputTokens: null },
          coverage: isThrowingEnum ? { toString: null } as unknown as ProviderTelemetry["coverage"] : "complete",
          stepCount: 1,
          source: {
            eventType: "opaque.completed",
            recordIds: [callId],
            transportRef: isThrowingEnum
              ? path.relative(project, path.join(project, ".nodulus", "fixtures", "par-031-compatible-state", "events.jsonl"))
              : "",
            parserVersion: 1,
          },
          semantics: { inputCache: "unknown", outputReasoning: "unknown", evidence: null },
          diagnostics: [],
        });
      }
      const child = spawn(process.execPath, [executable, "opaque"], {
        cwd: project,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: invocation.signal,
      });
      let stdout = "";
      let stderr = "";
      let childError: Error | undefined;
      let stdinError: Error | undefined;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("error", (error) => { childError = error; });
        child.stdin.on("error", (error) => { stdinError = error; });
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      observations.childProcesses.push({ child, closed });
      child.stdin.end(JSON.stringify(invocation));
      const operation = closed.then(({ code, signal }) => {
        if (childError) throw childError;
        if (stdinError) throw stdinError;
        if (code !== 0) throw new Error(`Opaque fixture child ended with code ${String(code)} and signal ${String(signal)}: ${stderr}`);
        return stdout;
      });
      return trackDelegated(operation, observations);
    },
    ...(malformedMeasurement ? { telemetryForCall(callId: string) {
      observations.telemetry += 1;
      return telemetryByCall.get(callId) ?? null;
    } } : {}),
  };
}

function recordInvocation(observations: Observations, invocation: ProviderInvocation): void {
  observations.invocations.push({
    nodeId: invocation.nodeId,
    attempt: invocation.call?.attempt ?? invocation.attempt,
    ...(invocation.call?.callId ? { callId: invocation.call.callId } : {}),
    ...(invocation.call?.operation ? { operation: invocation.call.operation } : {}),
    ...(invocation.call?.parentCallId ? { parentCallId: invocation.call.parentCallId } : {}),
    ...(invocation.answers === undefined ? {} : { answers: structuredClone(invocation.answers) }),
  });
}

function capturePublic(promise: Promise<ApplicationRunResult>, observations: Observations): Promise<PublicOutcome> {
  const outcome = promise.then(
    (result): PublicOutcome => ({ kind: "result", result }),
    (error: unknown): PublicOutcome => ({ kind: "error", error }),
  );
  observations.publicSettlements.push(outcome.then(() => undefined));
  return outcome;
}

function trackDelegated<T>(operation: T, observations: Observations): T {
  if (isThenable(operation)) observations.delegatedSettlements.push(Promise.resolve(operation).then(() => undefined, () => undefined));
  return operation;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function snapshotActivity(observations: Observations): Activity {
  return {
    availability: [...observations.availability],
    invocations: structuredClone(observations.invocations),
    repairs: observations.repairs,
    telemetry: observations.telemetry,
    launches: observations.launches,
    legacyUsage: observations.legacyUsage,
  };
}

function assertSeedAlreadyAccepted(project: string, runId: string, mode: ProviderMode): void {
  const checkpoint = readCheckpoint(project, runId);
  const seed = checkpoint.graph.nodes.seed?.accepted;
  if (!seed) throw new Error("PAR-031 compatibility fixture did not accept seed before the question branches entered.");
  const runRoot = runDirectory(project, runId);
  const definitions = readJson(path.join(runRoot, "context", "definitions.json"));
  const capturedNodes = definitions.nodes;
  if (!Array.isArray(capturedNodes)) throw new Error("PAR-031 captured graph definitions have no node list.");
  const capturedSeed = capturedNodes.find((node) => isRecord(node) && node.id === "seed");
  if (!isRecord(capturedSeed)) throw new Error("PAR-031 captured graph definitions have no seed node.");
  expect(capturedSeed.expectedOutputs).toEqual([
    { name: "alpha", contract: "report.v1" },
    { name: "beta", contract: "report.v1" },
  ]);
  const raw = JSON.parse(readFileSync(path.join(runRoot, seed.responseRef), "utf8")) as { status?: string; artifacts?: Array<{ name: string; contract: string; data: unknown }> };
  expect(raw.status).toBe("success");
  const expectedOrder = mode === "codex" ? ["beta", "alpha"] : ["alpha", "beta"];
  expect(raw.artifacts?.map((artifact) => artifact.name)).toEqual(expectedOrder);
  expect(raw.artifacts?.map((artifact) => artifact.contract)).toEqual(["report.v1", "report.v1"]);
  const saved = JSON.parse(readFileSync(path.join(runRoot, seed.resultRef), "utf8")) as { status?: string; artifacts?: Array<{ name: string; contract: string; data: unknown }> };
  expect(saved.status).toBe("success");
  expect(saved.artifacts?.map((artifact) => artifact.name)).toEqual(expectedOrder);
  expect(saved.artifacts).toEqual(raw.artifacts);
  expect(seed.artifacts.map((artifact) => artifact.name)).toEqual(expectedOrder);
  expect(seed.artifacts.map((artifact) => artifact.contract)).toEqual(["report.v1", "report.v1"]);
  for (const reference of seed.artifacts) {
    const artifactBytes = readFileSync(path.join(runRoot, reference.ref));
    expect(digest(artifactBytes)).toBe(reference.sha256);
    expect(JSON.parse(artifactBytes.toString("utf8"))).toEqual(raw.artifacts?.find((artifact) => artifact.name === reference.name));
  }
  const metrics = readMetrics(project, runId);
  const seedMetric = metrics.find((metric) => isRecord(metric) && metric.callId === seed.callId);
  if (!seedMetric) throw new Error("PAR-031 seed metric is missing its accepted call identity.");
  if (mode !== "codex") {
    expect(checkpoint.graph.nodes.seed?.launch).toBeNull();
    expect(seedMetric).toMatchObject({ callId: seed.callId, launched: null, usage: null });
    expect(existsSync(path.join(runRoot, "calls", seed.callId, "transport.json"))).toBe(false);
  }
}

function assertCodexSeedOrder(project: string, runId: string, initial: InitialState): void {
  const runRoot = runDirectory(project, runId);
  const seed = readCheckpoint(project, runId).graph.nodes.seed?.accepted;
  if (!seed) throw new Error("PAR-031 Codex seed acceptance disappeared before the A answer.");
  const response = JSON.parse(readFileSync(path.join(runRoot, seed.responseRef), "utf8")) as { artifacts: Array<{ name: string }> };
  const savedResult = JSON.parse(readFileSync(path.join(runRoot, seed.resultRef), "utf8")) as { artifacts: Array<{ name: string }> };
  expect(response.artifacts.map((artifact) => artifact.name)).toEqual(["beta", "alpha"]);
  expect(savedResult.artifacts.map((artifact) => artifact.name)).toEqual(["beta", "alpha"]);
  expect(seed.artifacts.map((artifact) => artifact.name)).toEqual(["beta", "alpha"]);
  for (const reference of seed.artifacts) {
    expect(digest(readFileSync(path.join(runRoot, reference.ref)))).toBe(reference.sha256);
  }
  for (const marker of [initial.seed, initial.a, initial.b]) {
    const transport = JSON.parse(readFileSync(path.join(runRoot, "calls", marker.callId, "transport.json"), "utf8")) as Record<string, unknown>;
    expect(transport).toMatchObject({ started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
  }
}

function assertOpaqueEvidence(project: string, runId: string, initial: InitialState, measurementVariant = false): void {
  const runRoot = runDirectory(project, runId);
  const checkpoint = readCheckpoint(project, runId);
  const metrics = readMetrics(project, runId);
  const completedCalls = initial.events.filter((event) => event.event === "provider.call.completed");
  expect(completedCalls).toHaveLength(3);
  for (const marker of [initial.seed, initial.a, initial.b]) {
    expect(checkpoint.graph.nodes[marker.nodeId]?.launch).toBeNull();
    expect(completedCalls.find((event) => event.callId === marker.callId)).toMatchObject({ callId: marker.callId, launched: null });
    const metric = metrics.find((entry) => isRecord(entry) && entry.callId === marker.callId);
    expect(metric).toMatchObject({ callId: marker.callId, launched: null });
    if (!measurementVariant || marker.nodeId !== "a") expect(metric).toMatchObject({ usage: null });
    expect(existsSync(path.join(runRoot, "calls", marker.callId, "transport.json"))).toBe(false);
  }
  expect(checkpoint.graph.nodes.a?.phase).toBe("pending");
  expect(checkpoint.graph.nodes.b?.phase).toBe("pending");
}

function assertOptionalMeasurementCapture(project: string, runId: string, callId: string, initial: InitialState): string {
  const metric = initial.metrics.find((entry) => isRecord(entry) && entry.callId === callId);
  if (!isRecord(metric)) throw new Error("PAR-031 optional measurement fixture did not persist A's call metric.");
  expect(metric).toMatchObject({ callId, launched: null });
  if (metric.usage === null) {
    assertBoundedMeasurementDiagnostic(readCheckpoint(project, runId), callId);
    return callId;
  }
  const telemetry = metric.telemetry;
  const reported = isRecord(telemetry) && isRecord(telemetry.reported) ? telemetry.reported : undefined;
  const normalized = isRecord(telemetry) && isRecord(telemetry.normalized) ? telemetry.normalized : undefined;
  const source = isRecord(telemetry) && isRecord(telemetry.source) ? telemetry.source : undefined;
  const rawBadMeasurement = reported?.inputTokens === -1 || normalized?.inputTokens === -1 || source?.transportRef === "";
  if (rawBadMeasurement) {
    expect(telemetry).toMatchObject({
      callId,
      reported: { inputTokens: -1 },
      normalized: { inputTokens: -1 },
      source: { transportRef: "" },
    });
    expect(isRecord(metric.usage) ? metric.usage.inputTokens : undefined).toBe(-1);
    return callId;
  }
  throw new Error("PAR-031 optional telemetry fixture did not retain its malformed A measurement or normalize it to unknown.");
}

function assertOptionalEnumCapture(project: string, runId: string, callId: string, initial: InitialState): string {
  const metric = initial.metrics.find((entry) => isRecord(entry) && entry.callId === callId);
  if (!isRecord(metric)) throw new Error("PAR-031 optional enum fixture did not persist A's call metric.");
  expect(metric).toMatchObject({ callId, launched: null });
  if (metric.usage === null) {
    assertBoundedMeasurementDiagnostic(readCheckpoint(project, runId), callId);
    return callId;
  }
  const telemetry = metric.telemetry;
  if (!isRecord(telemetry)) throw new Error("PAR-031 optional enum fixture did not persist A's telemetry.");
  expect(telemetry.callId).toBe(callId);
  expect(telemetry.coverage).toEqual({ toString: null });
  expect(telemetry.reported).toMatchObject({ inputTokens: 120, outputTokens: 34 });
  expect(telemetry.normalized).toMatchObject({ inputTokens: 120, outputTokens: 34 });
  const fixtureEventsPath = path.join(project, ".nodulus", "fixtures", "par-031-compatible-state", "events.jsonl");
  expect(existsSync(fixtureEventsPath)).toBe(true);
  expect(readFixtureEvents(fixtureEventsPath).some((event) => event.stage === "opaque-inference-completed" && event.callId === callId)).toBe(true);
  expect(telemetry.source).toMatchObject({ transportRef: path.relative(project, fixtureEventsPath) });
  return callId;
}

function assertBoundedMeasurementDiagnostic(checkpoint: GraphCheckpoint, callId: string | undefined): void {
  if (!callId) throw new Error("PAR-031 measurement diagnostic has no actual call identity.");
  const diagnostics = checkpoint.diagnostics?.filter((entry): entry is string => typeof entry === "string") ?? [];
  const matching = diagnostics.filter((diagnostic) => diagnostic.includes(callId) && /measurement|telemetry/i.test(diagnostic));
  expect(matching.length).toBeGreaterThan(0);
  expect(matching.every((diagnostic) => diagnostic.length > 0 && diagnostic.length <= 512)).toBe(true);
}

function captureInitialState(
  project: string,
  runId: string,
  markers: { seed: ProviderMarker; a: ProviderMarker; b: ProviderMarker },
  requests: { a: PendingRequest; b: PendingRequest },
): InitialState {
  const checkpoint = readCheckpoint(project, runId);
  const seed = checkpoint.graph.nodes.seed?.accepted;
  if (!seed) throw new Error("PAR-031 initial seed accepted record is absent.");
  const immutableFiles = new Map<string, CapturedFile>();
  for (const relative of [seed.resultRef, seed.validationRef, seed.responseRef, ...seed.artifacts.map((artifact) => artifact.ref)]) {
    captureFileInto(project, runId, relative, immutableFiles);
  }
  for (const marker of [markers.seed, markers.a, markers.b]) {
    const callDirectory = path.join(runDirectory(project, runId), "calls", marker.callId);
    if (existsSync(callDirectory)) captureTree(project, runId, `calls/${marker.callId}`, immutableFiles);
    captureTree(project, runId, `nodes/${marker.nodeId}/attempt-001`, immutableFiles);
  }
  for (const pending of [requests.a, requests.b]) captureFileInto(project, runId, `pending/${pending.id}.json`, immutableFiles);
  return {
    runId,
    ...markers,
    requests,
    inputBytes: readFileSync(path.join(runDirectory(project, runId), "inputs.json")),
    events: readRunEvents(project, runId),
    metrics: structuredClone(readMetrics(project, runId)),
    immutableFiles,
  };
}

function assertHistoryPrefix(project: string, runId: string, initial: InitialState): void {
  const events = readRunEvents(project, runId);
  expect(events.slice(0, initial.events.length)).toEqual(initial.events);
  const metrics = readMetrics(project, runId);
  expect(metrics.slice(0, initial.metrics.length)).toEqual(initial.metrics);
}

function assertImmutableEvidence(project: string, runId: string, files: Map<string, CapturedFile>): void {
  for (const [relative, captured] of files) {
    const current = readFileSync(path.join(runDirectory(project, runId), relative));
    expect(digest(current)).toBe(captured.sha256);
    expect(current.equals(captured.bytes)).toBe(true);
  }
}

function assertAnswerCommit(project: string, runId: string, request: PendingRequest, answer: Record<string, unknown>, priorEvents: number): void {
  const answerBytes = readFileSync(path.join(runDirectory(project, runId), "answers", `${request.id}.json`));
  expect(JSON.parse(answerBytes.toString("utf8"))).toEqual(answer);
  const checkpoint = readCheckpoint(project, runId);
  expect(checkpoint.graph.pendingRequests[request.id]).toMatchObject({
    nodeId: request.nodeId,
    kind: "node",
    answerRef: `answers/${request.id}.json`,
    answerSha256: digest(answerBytes),
  });
  const events = readRunEvents(project, runId);
  const recorded = events.slice(priorEvents).filter((event) => event.event === "request.answered" && event.requestId === request.id);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ event: "request.answered", requestId: request.id, kind: "node", nodeId: request.nodeId });
  expect(recorded[0]).not.toHaveProperty("answer");
  expect(recorded[0]).not.toHaveProperty("answers");
  const serialized = JSON.stringify(recorded[0]);
  for (const value of Object.values(answer)) expect(serialized).not.toContain(String(value));
}

async function waitForAcceptedSeed(project: string, runId: string, deadline: number, getOutcome: () => PublicOutcome | undefined): Promise<void> {
  await waitForCondition(() => readCheckpoint(project, runId).graph.nodes.seed?.phase === "accepted", deadline, "seed acceptance", getOutcome);
}

async function waitForMarker(file: string, description: string, deadline: number, getOutcome: () => PublicOutcome | undefined): Promise<ProviderMarker> {
  await waitForCondition(() => existsSync(file), deadline, description, getOutcome);
  const marker = readJson(file) as unknown as ProviderMarker;
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0 || typeof marker.callId !== "string" || typeof marker.runId !== "string") {
    throw new Error(`PAR-031 ${description} marker has invalid child or call identity.`);
  }
  return marker;
}

async function waitForQuestion(project: string, runId: string, marker: ProviderMarker, deadline: number, getOutcome: () => PublicOutcome | undefined): Promise<PendingRequest> {
  let found: PendingRequest | undefined;
  await waitForCondition(() => {
    const pendingDirectory = path.join(runDirectory(project, runId), "pending");
    if (!existsSync(pendingDirectory)) return false;
    for (const name of readdirSync(pendingDirectory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const request = JSON.parse(readFileSync(path.join(pendingDirectory, name), "utf8")) as PendingRequest;
        if (request.nodeId !== marker.nodeId || request.callId !== marker.callId || request.attempt !== marker.attempt) continue;
        const requestBytes = readFileSync(path.join(pendingDirectory, name));
        const checkpoint = readCheckpoint(project, runId);
        const committed = checkpoint.graph.pendingRequests[request.id];
        const node = checkpoint.graph.nodes[marker.nodeId];
        if (committed?.nodeId === marker.nodeId
          && committed.attempt === marker.attempt
          && committed.requestRef === `pending/${name}`
          && committed.requestSha256 === digest(requestBytes)
          && node?.callId === marker.callId
          && node?.attempt === marker.attempt) {
          found = request;
          return true;
        }
      } catch { /* an atomic request publication may still be in progress */ }
    }
    return false;
  }, deadline, `${marker.nodeId} runtime question`, getOutcome);
  if (!found) throw new Error(`PAR-031 ${marker.nodeId} question was not found after its marker settled.`);
  return found;
}

async function waitForQuestionEvidence(project: string, runId: string, marker: ProviderMarker, deadline: number): Promise<PendingRequest> {
  let result: PendingRequest | undefined;
  while (Date.now() < deadline) {
    const pendingDirectory = path.join(runDirectory(project, runId), "pending");
    if (existsSync(pendingDirectory)) {
      for (const name of readdirSync(pendingDirectory)) {
        if (!name.endsWith(".json")) continue;
        try {
          const request = JSON.parse(readFileSync(path.join(pendingDirectory, name), "utf8")) as PendingRequest;
          if (request.nodeId === marker.nodeId && request.callId === marker.callId && request.attempt === marker.attempt) result = request;
        } catch { /* ignore a request file while an atomic write is in flight */ }
      }
    }
    if (result) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PAR-031 ${marker.nodeId} final question evidence exceeded the shared scenario deadline.`);
}

async function waitForCondition(predicate: () => boolean, deadline: number, description: string, getOutcome: () => PublicOutcome | undefined): Promise<void> {
  while (!predicate()) {
    const outcome = getOutcome();
    if (outcome) throw new Error(`PAR-031 public run ended before ${description}: ${describeOutcome(outcome)}`);
    assertBeforeDeadline(deadline, description);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`PAR-031 shared scenario deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`PAR-031 shared scenario deadline expired during ${description}.`)), remaining); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function requireResult(outcome: PublicOutcome, operation: string): ApplicationRunResult {
  if (outcome.kind === "error") throw new Error(`PAR-031 ${operation} rejected: ${describeUnknownError(outcome.error)}`, { cause: outcome.error });
  return outcome.result;
}

function asRequestProjection(value: unknown): { request: PendingRequest; requests: PendingRequest[] } {
  if (!isRecord(value) || !isRecord(value.request) || !Array.isArray(value.requests)) throw new Error("PAR-031 graph result has no public request/requests projection.");
  return { request: value.request as unknown as PendingRequest, requests: value.requests as PendingRequest[] };
}

function describeOutcome(outcome: PublicOutcome): string {
  if (outcome.kind === "error") return describeUnknownError(outcome.error);
  if (outcome.result.status !== "error" || !isRecord(outcome.result.result) || !isRecord(outcome.result.result.error)) return `public result status=${outcome.result.status}`;
  const error = outcome.result.result.error;
  return `public result error code=${String(error.code)} message=${String(error.message)}`;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const code = isRecord(error) && typeof error.code === "string" ? ` code=${error.code}` : "";
    return `${error.name}${code}: ${error.message}`;
  }
  if (typeof error === "string") return error;
  return "a non-Error rejection value";
}

function captureFileInto(project: string, runId: string, relative: string, files: Map<string, CapturedFile>): void {
  const bytes = readFileSync(path.join(runDirectory(project, runId), relative));
  files.set(relative.replaceAll("\\", "/"), { bytes, sha256: digest(bytes) });
}

function captureTree(project: string, runId: string, relative: string, files: Map<string, CapturedFile>): void {
  const root = path.join(runDirectory(project, runId), relative);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) captureFileInto(project, runId, path.relative(runDirectory(project, runId), child), files);
    }
  };
  visit(root);
}

function snapshotRunTree(project: string, runId: string): Array<{ relative: string; sha256: string }> {
  const root = runDirectory(project, runId);
  const files: Array<{ relative: string; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ relative: path.relative(root, absolute).replaceAll("\\", "/"), sha256: digest(readFileSync(absolute)) });
    }
  };
  visit(root);
  return files.sort((left, right) => compareStrings(left.relative, right.relative));
}

function readCheckpoint(project: string, runId: string): GraphCheckpoint {
  return readJson(path.join(runDirectory(project, runId), "run.json")) as unknown as GraphCheckpoint;
}

function readRunEvents(project: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(runDirectory(project, runId), "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readMetrics(project: string, runId: string): unknown[] {
  const metrics = JSON.parse(readFileSync(path.join(runDirectory(project, runId), "metrics.json"), "utf8")) as unknown;
  if (!Array.isArray(metrics)) throw new Error("PAR-031 metrics.json is not a provider-call array.");
  return metrics;
}

function readFixtureEvents(eventsPath: string): Array<Record<string, unknown>> {
  return readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function readRunDirectory(project: string, runId: string): string {
  return path.join(project, ".nodulus", "runs", runId);
}

function runDirectory(project: string, runId: string): string {
  return readRunDirectory(project, runId);
}

function request(project: string) {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline" as const, text: "Validate compatibility of real saved graph evidence before applying a partial answer." }],
  };
}

function answerFor(role: "a" | "b"): Record<string, unknown> {
  return role === "a" ? { aApproval: "A-approved" } : { bApproval: "B-approved" };
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH");
  }
}

function assertBeforeDeadline(deadline: number, operation: string): void {
  if (Date.now() >= deadline) throw new Error(`PAR-031 shared scenario deadline expired during ${operation}.`);
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const nativeTemp = realpathSync.native(tmpdir());
  const current = realpathSync.native(project);
  if (current !== identity || path.dirname(identity) !== nativeTemp || !path.basename(identity).startsWith(`nodulus-${label}-`)) {
    throw new Error("PAR-031 compatibility refused cleanup outside its exact native temporary project.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("PAR-031 cleanup failed with a non-Error value.");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

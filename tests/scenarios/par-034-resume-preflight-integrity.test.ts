import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { resumeWorkflow, runWorkflow, type ApplicationRunResult, type ProviderPort } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureParallelProject, readParallelWorkflow } from "../support/parallel-project.js";
import { observeOwnedNativeProcesses, type OwnedNativeProcessObserver } from "../support/owned-native-processes.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type Outcome = { kind: "result"; result: ApplicationRunResult } | { kind: "error"; error: unknown };
type Role = "seed" | "a" | "b";
type Marker = { role: Role; nodeId: Role; runId: string; callId: string; attempt: number; pid: number };
type Request = { id: string; nodeId: string; attempt: number; callId: string; questions: Array<{ id: string; message: string }>; answerContract: Record<string, unknown> };
type Activity = { availability: string[]; invocations: string[]; repairs: number; telemetry: number; launches: number; legacyUsage: number; delegated: Array<Promise<void>>; public: Array<Promise<void>> };
type Snapshot = Array<{ path: string; kind: "directory" | "file"; size: number; sha256?: string }>;
type Accepted = { artifacts?: Array<{ ref?: string; sha256?: string }>; resultRef?: string; resultSha256?: string; validationRef?: string; validationSha256?: string; responseRef?: string; responseSha256?: string };
type CapturedEvidence = Array<{ reference: string; bytes: Buffer; sha256: string }>;
type PendingState = { nodeId?: string; kind?: string; attempt?: number; requestRef?: string; requestSha256?: string; answerRef?: string; answerSha256?: string };
type RunState = { status?: string; graph: { nodes: Record<string, { phase?: string; attempt?: number; callId?: string; failure?: { code?: string }; accepted?: Accepted }>; pendingRequests: Record<string, PendingState> } };
type Variant = { id: string; code?: string; mutate: (project: string, runId: string, requestA: Request, requestB: Request) => void };

const roles: Role[] = ["seed", "b", "a"];
const fixtureSource = fileURLToPath(new URL("../fixtures/par-031-graph-provider.mjs", import.meta.url));
const scenarioMs = 20_000;
const cleanupMs = 10_000;
const caseMs = 35_000;
const profileMs = 20_000;
const fixtureMs = 60_000;

const variants: Variant[] = [
  { id: "captured-definition-schema", code: "RUN_STATE_INVALID", mutate: (project, runId) => mutateJson(project, `.nodulus/runs/${runId}/context/definitions.json`, (value) => ({ ...value, schemaVersion: 99 })) },
  { id: "captured-definition-engine", code: "RUN_STATE_INVALID", mutate: (project, runId) => mutateJson(project, `.nodulus/runs/${runId}/context/definitions.json`, (value) => ({ ...value, engineVersion: "9.9.9" })) },
  { id: "checkpoint-engine", code: "RUN_STATE_INVALID", mutate: (project, runId) => mutateJson(project, `.nodulus/runs/${runId}/run.json`, (value) => ({ ...value, engineVersion: "9.9.9" })) },
  { id: "checkpoint-schema-discriminator", code: "RUN_STATE_INVALID", mutate: (project, runId) => mutateJson(project, `.nodulus/runs/${runId}/run.json`, (value) => ({ ...value, schemaVersion: 1 })) },
  { id: "workspace-reference-drift", code: "WORKSPACE_REFERENCE_CHANGED", mutate: (project) => { writeFileSync(path.join(project, "workspace.md"), "Externally changed after the pause.\n", "utf8"); } },
  { id: "pending-request-bytes", code: "RUN_STATE_INVALID", mutate: (project, runId, _a, b) => appendFile(runIdPath(project, runId, `pending/${b.id}.json`)) },
  { id: "committed-answer-bytes", code: "RUN_STATE_INVALID", mutate: (project, runId, a) => appendFile(runIdPath(project, runId, `answers/${a.id}.json`)) },
  { id: "uncommitted-answer-file", code: "RUN_STATE_INVALID", mutate: (project, runId, _a, b) => {
    const checkpoint = readRun(project, runId);
    const entry = checkpoint.graph.pendingRequests[b.id];
    if (entry?.answerRef !== undefined || entry?.answerSha256 !== undefined) throw new Error("PAR-034 orphan control was not an uncommitted request.");
    const relative = `answers/${b.id}.json`;
    const target = runIdPath(project, runId, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(answer("b")), { encoding: "utf8", flag: "wx" });
  } },
  { id: "accepted-artifact-bytes", code: "RUN_STATE_INVALID", mutate: (project, runId) => {
    const accepted = readRun(project, runId).graph.nodes.seed?.accepted;
    const reference = accepted?.artifacts?.[0]?.ref;
    if (typeof reference !== "string") throw new Error("PAR-034 seed artifact reference was absent.");
    appendFile(runIdPath(project, runId, reference));
  } },
  ...(["resultRef", "validationRef", "responseRef"] as const).map((field): Variant => ({
    id: `accepted-${field.replace("Ref", "-evidence")}`,
    code: "RUN_STATE_INVALID",
    mutate: (project, runId) => {
      const accepted = readRun(project, runId).graph.nodes.seed?.accepted;
      const reference = accepted?.[field];
      if (typeof reference !== "string") throw new Error(`PAR-034 seed ${field} was absent.`);
      appendFile(runIdPath(project, runId, reference));
    },
  })),
];

for (const variant of variants) {
  test(`PAR-034 ${variant.id} fails closed before answer mutation or provider activity`, async () => {
    await exercisePreflightVariant(variant);
  }, caseMs);
}

test("PAR-034 final captured provider unavailability is persisted as an operational error", async () => {
  await exerciseUnavailableProvider();
}, caseMs);

async function exercisePreflightVariant(variant: Variant): Promise<void> {
  const deadline = Date.now() + scenarioMs;
  const label = `par-034-resume-preflight-${variant.id}`;
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "par-034-state");
  const eventsPath = path.join(stateDirectory, "events.jsonl");
  const started = Object.fromEntries(roles.flatMap((role) => [1, 2].map((attempt) => [`${role}-${attempt}`, path.join(stateDirectory, `${role}-${attempt}.started.json`)]))) as Record<string, string>;
  const releases = { a: path.join(stateDirectory, "release-a"), b: path.join(stateDirectory, "release-b") };
  const activity: Activity = { availability: [], invocations: [], repairs: 0, telemetry: 0, launches: 0, legacyUsage: 0, delegated: [], public: [] };
  let observed: Outcome | undefined;
  let initial: Promise<Outcome> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let nativeObserver: OwnedNativeProcessObserver | undefined;
  const cleanupErrors: Error[] = [];

  try {
    configureProject(project, eventsPath, stateDirectory, started, releases);
    nativeObserver = observeOwnedNativeProcesses();
    const provider = observe(project, activity);
    initial = capturePublic(runWorkflow(runRequest(project), provider), activity);
    void initial.then((value) => { observed = value; });

    const markersPromise = Promise.all([
      waitForMarker(started["seed-1"]!, "seed", deadline, () => observed),
      waitForMarker(started["a-1"]!, "a", deadline, () => observed),
      waitForMarker(started["b-1"]!, "b", deadline, () => observed),
    ]);
    const [seedMarker, aMarker, bMarker] = await withDeadline(markersPromise, deadline, "three initial provider barriers");
    expect(seedMarker.runId).toBe(aMarker.runId);
    expect(seedMarker.runId).toBe(bMarker.runId);
    expect(isProcessAlive(aMarker.pid)).toBe(true);
    expect(isProcessAlive(bMarker.pid)).toBe(true);
    await waitForSeedAccepted(project, seedMarker.runId, deadline, () => observed);

    release(releases.a);
    const requestA = await waitForRequest(project, seedMarker.runId, aMarker, deadline, () => observed);
    release(releases.b);
    const initialOutcome = await withDeadline(initial, deadline, "initial two-question pause");
    const paused = requireResult(initialOutcome);
    expect(paused.status).toBe("needs_input");
    const projection = paused.result as { request?: Request; requests?: Request[] };
    expect(projection.requests?.map((request) => request.nodeId)).toEqual(["b", "a"]);
    const requestB = projection.requests?.[0];
    if (!requestB) throw new Error("PAR-034 initial pause did not expose B's request.");
    expect(projection.requests?.[1]).toEqual(requestA);
    expect(projection.request).toEqual(requestB);
    expect(await waitForRequest(project, paused.runId, bMarker, deadline, () => observed)).toEqual(requestB);
    expect(activity.invocations.slice().sort((left, right) => left.localeCompare(right))).toEqual(["a", "b", "seed"]);
    expect(readFixtureEvents(eventsPath).filter((event) => event.stage === "inference-started")).toHaveLength(3);
    expect(readMetrics(project, paused.runId)).toHaveLength(3);
    expect(readRun(project, paused.runId).graph.nodes.seed?.phase).toBe("accepted");
    expect(readFileSync(validatorLogPath(project), "utf8").trim().split(/\r?\n/)).toEqual(["seed"]);
    const validatorLogAtPause = readFileSync(validatorLogPath(project));
    if (!nativeObserver) throw new Error("PAR-034 native process observer was not initialized.");
    assertInitialChildrenClosed(nativeObserver);
    const nativeAtPause = nativeObserver.diagnostics;

    const initialEvents = readEvents(project, paused.runId);
    const initialActivity = snapshotActivity(activity);
    const inputBytesAtPause = readFileSync(runIdPath(project, paused.runId, "inputs.json"));
    const fixtureBaseline = readFileSync(eventsPath);
    const partialOutcome = await withDeadline(capturePublic(resumeWorkflow({ projectRoot: project, runId: paused.runId, requestId: requestA.id, answers: answer("a") }, observe(project, activity)), activity), deadline, "valid partial A answer");
    expect(partialOutcome.kind).toBe("result");
    if (partialOutcome.kind === "error") throw partialOutcome.error;
    expect(partialOutcome.result.status).toBe("needs_input");
    const partialRequests = (partialOutcome.result.result as { requests?: Request[] }).requests;
    expect(partialRequests?.map((request) => request.id)).toEqual([requestB.id]);
    expect(snapshotActivity(activity)).toEqual(initialActivity);
    expect(readFileSync(eventsPath).length).toBeGreaterThan(0);
    expect(readFileSync(eventsPath).equals(fixtureBaseline)).toBe(true);
    expect(readEvents(project, paused.runId).slice(0, initialEvents.length)).toEqual(initialEvents);
    expect(readFileSync(runIdPath(project, paused.runId, "inputs.json")).equals(inputBytesAtPause)).toBe(true);
    expect(readFileSync(validatorLogPath(project)).equals(validatorLogAtPause)).toBe(true);
    expect(nativeObserver.diagnostics).toEqual(nativeAtPause);
    const partialBaseline = snapshotRunTree(project, paused.runId);

    variant.mutate(project, paused.runId, requestA, requestB);
    const afterMutation = snapshotRunTree(project, paused.runId);
    const activityBeforeReject = snapshotActivity(activity);
    const fixtureBeforeReject = readFileSync(eventsPath);
    const rejection = await withDeadline(capturePublic(resumeWorkflow({ projectRoot: project, runId: paused.runId, requestId: requestB.id, answers: answer("b") }, observe(project, activity)), activity), deadline, "valid B answer against one corrupt saved-state row");

    expect(rejection.kind).toBe("error");
    if (rejection.kind === "error") expect(rejection.error).toMatchObject({ code: variant.code });
    expect(snapshotRunTree(project, paused.runId)).toEqual(afterMutation);
    if (variant.id === "workspace-reference-drift") expect(afterMutation).toEqual(partialBaseline);
    else expect(afterMutation).not.toEqual(partialBaseline);
    expect(snapshotActivity(activity)).toEqual(activityBeforeReject);
    expect(nativeObserver.diagnostics).toEqual(nativeAtPause);
    expect(readFileSync(validatorLogPath(project)).equals(validatorLogAtPause)).toBe(true);
    expect(readFileSync(eventsPath).equals(fixtureBeforeReject)).toBe(true);
    expect(readFileSync(eventsPath).equals(fixtureBaseline)).toBe(true);
    if (variant.id === "workspace-reference-drift") expect(readFileSync(path.join(project, "workspace.md"), "utf8")).toBe("Externally changed after the pause.\n");
    const answerBPath = runIdPath(project, paused.runId, `answers/${requestB.id}.json`);
    if (variant.id === "uncommitted-answer-file") {
      expect(readJson(answerBPath)).toEqual(answer("b"));
      expect(afterMutation.some((entry) => entry.path === `answers/${requestB.id}.json` && entry.kind === "file")).toBe(true);
    } else expect(existsSync(answerBPath)).toBe(false);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupDeadline = Date.now() + cleanupMs;
  for (const file of Object.values(releases)) {
    try { release(file); } catch (error) { cleanupErrors.push(asError(error)); }
  }
  let operationsDrained = false;
  try {
    const drain = Promise.all([...activity.public]).then(() => Promise.all([...activity.delegated])).then(() => undefined);
    await withDeadline(drain, cleanupDeadline, "public and delegated provider operations cleanup");
    operationsDrained = true;
  } catch (error) { cleanupErrors.push(asError(error)); }
  if (nativeObserver) {
    try { await nativeObserver.drain(cleanupDeadline); }
    catch (error) { cleanupErrors.push(asError(error)); }
  }

  if (operationsDrained && !hasPrimaryError && cleanupErrors.length === 0) {
    try { assertOwnedProject(project, projectIdentity, label); rmSync(project, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(asError(error)); }
  } else if (!operationsDrained) {
    cleanupErrors.push(new Error(`PAR-034 retained owned project because public or delegated operations did not settle: ${project}`));
  } else if (cleanupErrors.length > 0) {
    cleanupErrors.push(new Error(`PAR-034 retained owned project after cleanup uncertainty: ${project}`));
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "PAR-034 failed and cleanup reported errors.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-034 cleanup failed.");
}

async function exerciseUnavailableProvider(): Promise<void> {
  const deadline = Date.now() + scenarioMs;
  const label = "par-034-resume-preflight-provider-unavailable";
  const project = createInitializedProject(label);
  const projectIdentity = realpathSync.native(project);
  const stateDirectory = path.join(project, ".nodulus", "fixtures", "par-034-state");
  const eventsPath = path.join(stateDirectory, "events.jsonl");
  const started = Object.fromEntries(roles.flatMap((role) => [1, 2].map((attempt) => [`${role}-${attempt}`, path.join(stateDirectory, `${role}-${attempt}.started.json`)]))) as Record<string, string>;
  const releases = { a: path.join(stateDirectory, "release-a"), b: path.join(stateDirectory, "release-b") };
  const activity: Activity = { availability: [], invocations: [], repairs: 0, telemetry: 0, launches: 0, legacyUsage: 0, delegated: [], public: [] };
  let observed: Outcome | undefined;
  let initial: Promise<Outcome> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: Error[] = [];
  let wrappers: string[] = [];
  let nativeObserver: OwnedNativeProcessObserver | undefined;

  try {
    configureProject(project, eventsPath, stateDirectory, started, releases);
    nativeObserver = observeOwnedNativeProcesses();
    const settings = readProjectJson(project, ".nodulus/settings.json") as { providerProfiles: Record<string, { executable?: string }> };
    wrappers = ["a", "b"].map((role) => settings.providerProfiles[role]?.executable).filter((value): value is string => typeof value === "string");
    initial = capturePublic(runWorkflow(runRequest(project), observe(project, activity)), activity);
    void initial.then((value) => { observed = value; });
    const [seed, a, b] = await withDeadline(Promise.all([
      waitForMarker(started["seed-1"]!, "seed", deadline, () => observed),
      waitForMarker(started["a-1"]!, "a", deadline, () => observed),
      waitForMarker(started["b-1"]!, "b", deadline, () => observed),
    ]), deadline, "provider-unavailability pause barriers");
    await waitForSeedAccepted(project, seed.runId, deadline, () => observed);
    release(releases.a);
    const requestA = await waitForRequest(project, seed.runId, a, deadline, () => observed);
    release(releases.b);
    const pause = requireResult(await withDeadline(initial, deadline, "initial pause"));
    const requests = (pause.result as { requests: Request[] }).requests;
    const requestB = await waitForRequest(project, seed.runId, b, deadline, () => observed);
    expect(requests.find((request) => request.nodeId === "b")).toEqual(requestB);
    const activityAtPause = snapshotActivity(activity);
    const eventsAtPause = readEvents(project, seed.runId);
    const fixtureAtPause = readFileSync(eventsPath);
    const inputsAtPause = readFileSync(runIdPath(project, seed.runId, "inputs.json"));
    const validatorLogAtPause = readFileSync(validatorLogPath(project));
    const acceptedBefore = readRun(project, seed.runId).graph.nodes.seed?.accepted;
    const seedEvidenceAtPause = captureAcceptedFiles(project, seed.runId, acceptedBefore);
    if (!nativeObserver) throw new Error("PAR-034 provider-unavailability native observer was not initialized.");
    assertInitialChildrenClosed(nativeObserver);
    const nativeAtPause = nativeObserver.diagnostics;
    expect(activity.invocations.slice().sort((left, right) => left.localeCompare(right))).toEqual(["a", "b", "seed"]);
    const beforePartialFixture = readFileSync(eventsPath);
    const partial = await withDeadline(capturePublic(resumeWorkflow({ projectRoot: project, runId: seed.runId, requestId: requestA.id, answers: answer("a") }, observe(project, activity)), activity), deadline, "partial A answer");
    expect(partial.kind).toBe("result");
    if (partial.kind === "error") throw partial.error;
    expect(partial.result.status).toBe("needs_input");
    expect(snapshotActivity(activity)).toEqual(activityAtPause);
    expect(readEvents(project, seed.runId).slice(0, eventsAtPause.length)).toEqual(eventsAtPause);
    expect(readFileSync(eventsPath).equals(fixtureAtPause)).toBe(true);
    expect(readFileSync(eventsPath).equals(beforePartialFixture)).toBe(true);
    expect(readFileSync(runIdPath(project, seed.runId, "inputs.json")).equals(inputsAtPause)).toBe(true);
    expect(readFileSync(validatorLogPath(project)).equals(validatorLogAtPause)).toBe(true);
    expect(nativeObserver.diagnostics).toEqual(nativeAtPause);
    for (const wrapper of wrappers) unlinkSync(wrapper);
    const activityBeforeFinal = snapshotActivity(activity);
    const eventsBeforeFinal = readEvents(project, seed.runId);
    const outcome = await withDeadline(capturePublic(resumeWorkflow({ projectRoot: project, runId: seed.runId, requestId: requestB.id, answers: answer("b") }, observe(project, activity)), activity), deadline, "final answer with removed captured executables");
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "error") throw outcome.error;
    expect(outcome.result.status).toBe("error");
    expect(outcome.result.result).toMatchObject({ error: { code: "PROVIDER_UNAVAILABLE" } });
    expect(activity.availability.length - activityBeforeFinal.availability.length).toBeGreaterThanOrEqual(1);
    expect(activity.invocations.slice(activityBeforeFinal.invocations.length)).toEqual([]);
    expect(activity.repairs - activityBeforeFinal.repairs).toBe(0);
    const finalRun = readRun(project, seed.runId);
    expect(finalRun.graph.nodes.seed?.accepted).toEqual(acceptedBefore);
    const savedRequest = readJson(runIdPath(project, seed.runId, `answers/${requestB.id}.json`));
    expect(savedRequest).toEqual(answer("b"));
    const answerBytes = readFileSync(runIdPath(project, seed.runId, `answers/${requestB.id}.json`));
    expect(finalRun.graph.pendingRequests[requestB.id]).toMatchObject({ answerRef: `answers/${requestB.id}.json`, answerSha256: digest(answerBytes) });
    expect(finalRun.status).toBe("error");
    const finalEvents = readEvents(project, seed.runId).slice(eventsBeforeFinal.length);
    expect(finalEvents).toContainEqual(expect.objectContaining({ event: "request.answered", requestId: requestB.id, kind: "node", nodeId: "b" }));
    expect(finalEvents).toContainEqual(expect.objectContaining({ event: "run.resumed", requestId: requestB.id }));
    const failedNode = ["a", "b"].find((nodeId) => finalRun.graph.nodes[nodeId]?.phase === "failed");
    if (!failedNode) throw new Error("PAR-034 unavailable-provider run did not persist its failed admitted node.");
    const failed = finalRun.graph.nodes[failedNode];
    expect(failed).toMatchObject({ attempt: 2, failure: { code: "PROVIDER_UNAVAILABLE" } });
    if (typeof failed?.callId !== "string") throw new Error("PAR-034 failed admitted node has no call ID.");
    expect(finalEvents).toContainEqual(expect.objectContaining({ event: "node.failed", nodeId: failedNode, code: "PROVIDER_UNAVAILABLE" }));
    expect(finalEvents).toContainEqual(expect.objectContaining({ event: "provider.call.started", nodeId: failedNode, attempt: 2, callId: failed.callId, operation: "invoke" }));
    const attemptRoot = `nodes/${failedNode}/attempt-002`;
    expect(readJson(runIdPath(project, seed.runId, `${attemptRoot}/result.json`))).toMatchObject({ status: "error", error: { code: "PROVIDER_UNAVAILABLE" } });
    expect(readJson(runIdPath(project, seed.runId, `${attemptRoot}/validation.json`))).toMatchObject({ valid: false, code: "PROVIDER_UNAVAILABLE" });
    expect(readFixtureEvents(eventsPath).filter((event) => event.stage === "inference-started")).toHaveLength(3);
    expect(readFileSync(eventsPath).equals(fixtureAtPause)).toBe(true);
    expect(readFileSync(validatorLogPath(project)).equals(validatorLogAtPause)).toBe(true);
    assertCapturedFilesUnchanged(project, seed.runId, seedEvidenceAtPause);
    expect(nativeObserver.diagnostics.slice(0, nativeAtPause.length)).toEqual(nativeAtPause);
  } catch (error) { primaryError = error; hasPrimaryError = true; }

  const cleanupDeadline = Date.now() + cleanupMs;
  for (const releasePath of Object.values(releases)) { try { release(releasePath); } catch (error) { cleanupErrors.push(asError(error)); } }
  let drained = false;
  try { await withDeadline(Promise.all([...activity.public]).then(() => Promise.all([...activity.delegated])), cleanupDeadline, "provider-unavailability cleanup"); drained = true; }
  catch (error) { cleanupErrors.push(asError(error)); }
  if (nativeObserver) { try { await nativeObserver.drain(cleanupDeadline); } catch (error) { cleanupErrors.push(asError(error)); drained = false; } }
  if (drained && !hasPrimaryError && cleanupErrors.length === 0) {
    try { assertOwnedProject(project, projectIdentity, label); rmSync(project, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(asError(error)); }
  } else if (!drained) cleanupErrors.push(new Error(`PAR-034 retained owned project because operations did not settle: ${project}`));
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "PAR-034 unavailable-provider scenario and cleanup failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-034 unavailable-provider cleanup failed.");
}

function configureProject(project: string, eventsPath: string, stateDirectory: string, started: Record<string, string>, releases: Record<"a" | "b", string>): void {
  configureParallelProject(project);
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  writeFileSync(path.join(project, "workspace.md"), "Reference snapshot used by the run.\n", "utf8");
  writeFileSync(path.join(project, "reference-list.json"), JSON.stringify({ references: [{ path: "workspace.md", mode: "workspace" }] }), "utf8");
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  writeFileSync(path.join(fixtureDirectory, "par-031-graph-provider.mjs"), readFileSync(fixtureSource), "utf8");
  writeFileSync(path.join(fixtureDirectory, "par-031-control.json"), JSON.stringify({
    eventsPath: path.relative(project, eventsPath),
    fixtureLifetimeMs: fixtureMs,
    startedPaths: Object.fromEntries(Object.entries(started).map(([key, value]) => [key, path.relative(project, value)])),
    releasePaths: Object.fromEntries(Object.entries(releases).map(([key, value]) => [key, path.relative(project, value)])),
  }), "utf8");
  const settings = readProjectJson(project, ".nodulus/settings.json") as { providerProfiles: Record<string, Record<string, unknown>> };
  const base = settings.providerProfiles.fixture ?? {};
  for (const role of roles) {
    const wrapper = path.join(fixtureDirectory, process.platform === "win32" ? `par-034-${role}.cmd` : `par-034-${role}.sh`);
    if (process.platform === "win32") writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-031-graph-provider.mjs" "${role}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    else { writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-031-graph-provider.mjs' '${role}' "$@"\n`, "utf8"); chmodSync(wrapper, 0o755); }
    settings.providerProfiles[role] = { ...base, enabled: true, executable: wrapper, kind: "codex", model: `par-034-${role}`, timeoutMs: profileMs, capabilities: [], sandbox: "read-only" };
  }
  writeJson(project, ".nodulus/settings.json", settings);
  const workflow = readParallelWorkflow(project);
  workflow.nodes = [...roles];
  workflow.execution.maxConcurrency = 2;
  workflow.execution.dependsOn = { seed: [], b: ["seed"], a: ["seed"] };
  workflow.execution.resources = { seed: [], b: [], a: [] };
  workflow.outputs = [{ name: "bFinal", from: "b.report", contract: "report.v1" }, { name: "aFinal", from: "a.report", contract: "report.v1" }];
  writeJson(project, ".nodulus/workflows/example.json", workflow);
  const template = readProjectJson(project, ".nodulus/nodes/prepare.json");
  for (const nodeId of roles) {
    const instruction = `.nodulus/instructions/${nodeId}.md`;
    writeFileSync(path.join(project, instruction), `PAR-034 local preflight instructions for ${nodeId}.\n`, "utf8");
    writeJson(project, `.nodulus/nodes/${nodeId}.json`, { ...template, id: nodeId, providerProfile: nodeId, instructions: [instruction], inputs: nodeId === "seed" ? { request: { from: "request", contract: "request.v1" } } : { report: { from: "seed.report", contract: "report.v1" } }, expectedOutputs: [{ name: "report", contract: "report.v1" }] });
  }
  const seedNode = readProjectJson(project, ".nodulus/nodes/seed.json") as { expectedOutputs: Array<Record<string, unknown>> };
  seedNode.expectedOutputs[0] = { ...seedNode.expectedOutputs[0], validator: ".nodulus/validators/prepare.mjs" };
  writeJson(project, ".nodulus/nodes/seed.json", seedNode);
  const validatorLog = validatorLogPath(project);
  writeFileSync(path.join(project, ".nodulus/validators/prepare.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(validatorLog)}, "seed\\n");\nprocess.stdout.write('{"valid":true,"errors":[]}');\n`, "utf8");
}

function observe(project: string, log: Activity): ProviderPort {
  const real = createDefaultProviderPort(project);
  const track = <T>(operation: T): T => {
    if (typeof operation === "object" && operation !== null && "then" in operation && typeof operation.then === "function") log.delegated.push(Promise.resolve(operation).then(() => undefined, () => undefined));
    return operation;
  };
  return {
    ...real,
    isAvailable: (profile, options) => { log.availability.push(typeof profile.model === "string" ? profile.model : "unknown"); return track(real.isAvailable!(profile, options)); },
    invoke: (invocation) => { log.invocations.push(invocation.nodeId); return track(real.invoke(invocation)); },
    ...(real.repairResponse ? { repairResponse: (invocation, raw, errors) => { log.repairs += 1; return track(real.repairResponse!(invocation, raw, errors)); } } : {}),
    ...(real.telemetryForCall ? { telemetryForCall: (callId) => { log.telemetry += 1; return track(real.telemetryForCall!(callId)); } } : {}),
    ...(real.launchForCall ? { launchForCall: (callId) => { log.launches += 1; return track(real.launchForCall!(callId)); } } : {}),
    ...(real.usageForLastCall ? { usageForLastCall: () => { log.legacyUsage += 1; return real.usageForLastCall!(); } } : {}),
  };
}

function capturePublic(promise: Promise<ApplicationRunResult>, log: Activity): Promise<Outcome> {
  const outcome = promise.then((result) => ({ kind: "result" as const, result }), (error: unknown) => ({ kind: "error" as const, error }));
  log.public.push(outcome.then(() => undefined));
  return outcome;
}

async function waitForRequest(project: string, runId: string, marker: Marker, deadline: number, outcome: () => Outcome | undefined): Promise<Request> {
  const resultPath = runIdPath(project, runId, `nodes/${marker.nodeId}/attempt-001/result.json`);
  await waitUntil(() => existsSync(resultPath), deadline, `${marker.nodeId} saved request`, outcome);
  const result = readJson(resultPath) as { status?: string; request?: Request };
  if (result.status !== "needs_input" || !result.request) throw new Error(`PAR-034 ${marker.nodeId} did not save its expected clarification.`);
  expect(result.request).toMatchObject({ nodeId: marker.nodeId, callId: marker.callId, attempt: 1 });
  const relative = `pending/${result.request.id}.json`;
  const pendingPath = runIdPath(project, runId, relative);
  await waitUntil(() => {
    try {
      if (!existsSync(pendingPath)) return false;
      const bytes = readFileSync(pendingPath);
      const checkpoint = readRun(project, runId);
      const entry = checkpoint.graph.pendingRequests[result.request!.id];
      return JSON.stringify(JSON.parse(bytes.toString("utf8"))) === JSON.stringify(result.request) &&
        entry?.nodeId === marker.nodeId && entry.kind === "node" && entry.attempt === 1 &&
        entry.requestRef === relative && entry.requestSha256 === digest(bytes);
    } catch { return false; }
  }, deadline, `${marker.nodeId} checkpoint-committed request reference and hash`, outcome);
  expect(readJson(pendingPath)).toEqual(result.request);
  expect(readRun(project, runId).graph.pendingRequests[result.request.id]).toMatchObject({
    nodeId: marker.nodeId,
    kind: "node",
    attempt: 1,
    requestRef: relative,
    requestSha256: digest(readFileSync(pendingPath)),
  });
  return result.request;
}

async function waitForMarker(file: string, role: Role, deadline: number, outcome: () => Outcome | undefined): Promise<Marker> {
  await waitUntil(() => existsSync(file), deadline, `${role} provider marker`, outcome);
  const marker = readJson(file) as unknown as Marker;
  if (typeof marker.pid !== "number" || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || marker.role !== role || marker.nodeId !== role || typeof marker.callId !== "string" || typeof marker.runId !== "string") throw new Error(`PAR-034 ${role} marker identity was invalid.`);
  return marker;
}

async function waitForSeedAccepted(project: string, runId: string, deadline: number, outcome: () => Outcome | undefined): Promise<void> {
  await waitUntil(() => readRun(project, runId).graph.nodes.seed?.phase === "accepted", deadline, "seed checkpoint acceptance", outcome);
}

async function waitUntil(predicate: () => boolean, deadline: number, description: string, getOutcome: () => Outcome | undefined): Promise<void> {
  while (!predicate()) {
    const current = getOutcome();
    if (current) { if (current.kind === "error") throw current.error; throw new Error(`PAR-034 workflow settled before ${description}.`); }
    if (Date.now() >= deadline) throw new Error(`PAR-034 scenario deadline expired during ${description}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function snapshotActivity(activity: Activity): Omit<Activity, "delegated" | "public"> {
  return { availability: [...activity.availability], invocations: [...activity.invocations], repairs: activity.repairs, telemetry: activity.telemetry, launches: activity.launches, legacyUsage: activity.legacyUsage };
}

function snapshotRunTree(project: string, runId: string): Snapshot {
  const root = runIdPath(project, runId, "");
  const files: Snapshot = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) { files.push({ path: relative, kind: "directory", size: 0 }); visit(absolute); }
      else if (entry.isFile()) { const bytes = readFileSync(absolute); files.push({ path: relative, kind: "file", size: bytes.byteLength, sha256: digest(bytes) }); }
      else throw new Error(`PAR-034 run tree contains an unsupported entry kind at '${relative}'.`);
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertInitialChildrenClosed(observer: OwnedNativeProcessObserver): void {
  expect(observer.observationFailure).toBe(false);
  const children = observer.diagnostics;
  expect(children.length).toBeGreaterThan(0);
  for (const child of children) {
    expect(child.stages).toEqual(expect.arrayContaining(["spawn", "exit", "close"]));
    expect(child.exitCode).toBe(0);
    expect(child.signal).toBeNull();
  }
}

function captureAcceptedFiles(project: string, runId: string, accepted: Accepted | undefined): CapturedEvidence {
  if (!accepted) throw new Error("PAR-034 expected the seed to have an accepted manifest.");
  const references: Array<{ reference: string; expectedHash: string | undefined }> = [
    { reference: accepted.resultRef ?? "", expectedHash: accepted.resultSha256 },
    { reference: accepted.validationRef ?? "", expectedHash: accepted.validationSha256 },
    { reference: accepted.responseRef ?? "", expectedHash: accepted.responseSha256 },
    ...(accepted.artifacts ?? []).map((artifact) => ({ reference: artifact.ref ?? "", expectedHash: artifact.sha256 })),
  ];
  return references.map(({ reference, expectedHash }) => {
    if (!reference || !expectedHash) throw new Error("PAR-034 accepted seed manifest has incomplete reference/hash evidence.");
    const bytes = readFileSync(runIdPath(project, runId, reference));
    const sha256 = digest(bytes);
    expect(sha256).toBe(expectedHash);
    return { reference, bytes, sha256 };
  });
}

function assertCapturedFilesUnchanged(project: string, runId: string, captured: CapturedEvidence): void {
  for (const entry of captured) {
    const current = readFileSync(runIdPath(project, runId, entry.reference));
    expect(digest(current)).toBe(entry.sha256);
    expect(current.equals(entry.bytes)).toBe(true);
  }
}

function mutateJson(project: string, relative: string, update: (value: Record<string, unknown>) => Record<string, unknown>): void {
  const absolute = path.join(project, relative);
  const current = readJson(absolute) as Record<string, unknown>;
  writeFileSync(absolute, `${JSON.stringify(update(current), null, 2)}\n`, "utf8");
}

function appendFile(file: string): void { writeFileSync(file, `${readFileSync(file, "utf8")}\n`, "utf8"); }

function readRun(project: string, runId: string): RunState { return readJson(runIdPath(project, runId, "run.json")) as unknown as RunState; }
function readEvents(project: string, runId: string): Array<Record<string, unknown>> { return readFileSync(runIdPath(project, runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); }
function readMetrics(project: string, runId: string): unknown[] { const value = JSON.parse(readFileSync(runIdPath(project, runId, "metrics.json"), "utf8")) as unknown; if (!Array.isArray(value)) throw new Error("PAR-034 expected graph metric array."); return value; }
function readFixtureEvents(file: string): Array<Record<string, unknown>> { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); }
function readJson(file: string): Record<string, unknown> { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; }
function runIdPath(project: string, runId: string, relative: string): string { return path.join(project, ".nodulus", "runs", runId, relative); }
function validatorLogPath(project: string): string { return path.join(project, ".nodulus", "fixtures", "validator-invocations.jsonl"); }
function runRequest(project: string): { projectRoot: string; cwd: string; workflow: string; sources: Array<{ kind: "inline"; text: string }>; referencesFile: string } { return { projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline", text: "Review the saved parallel workflow state without replaying accepted work." }], referencesFile: "reference-list.json" }; }
function answer(role: "a" | "b"): Record<string, string> { return role === "a" ? { aApproval: "A-approved" } : { bApproval: "B-approved" }; }
function release(file: string): void { mkdirSync(path.dirname(file), { recursive: true }); if (!existsSync(file)) writeFileSync(file, "release\n", { encoding: "utf8", flag: "wx" }); }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function assertOwnedProject(project: string, identity: string, label: string): void { const temp = realpathSync.native(tmpdir()); const current = realpathSync.native(project); if (current !== identity || path.dirname(identity) !== temp || !path.basename(identity).startsWith(`nodulus-${label}-`)) throw new Error("PAR-034 refused removal outside the exact owned temporary project."); }
function requireResult(outcome: Outcome): ApplicationRunResult { if (outcome.kind === "error") throw outcome.error; return outcome.result; }
function withDeadline<T>(promise: Promise<T>, deadline: number, operation: string): Promise<T> { const remaining = deadline - Date.now(); if (remaining <= 0) return Promise.reject(new Error(`PAR-034 deadline expired before ${operation}.`)); let timer: ReturnType<typeof setTimeout> | undefined; return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`PAR-034 deadline expired during ${operation}.`)), remaining); })]).finally(() => { if (timer !== undefined) clearTimeout(timer); }); }
function isProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false; return true; } }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error("PAR-034 cleanup failed with a non-Error value."); }

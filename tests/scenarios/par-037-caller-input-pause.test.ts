import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { resumeWorkflow, runWorkflow, type ApplicationRunResult, type ProviderPort } from "../../src/index.js";
import type { ProviderInvocation } from "../../src/core/ports/provider.js";
import { createInitializedProject } from "../support/intake-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type Outcome = { kind: "result"; value: ApplicationRunResult } | { kind: "rejected"; error: unknown };
type RecordValue = Record<string, unknown>;
type CallerRequest = { id: string; nodeId: null; kind: "caller_inputs"; attempt: 0; answerContract: RecordValue };
type Checkpoint = { schemaVersion: number; status: string; completedNodes: string[]; graph: { admissionClosed: boolean; nodes: Record<string, { phase: string; attempt: number }>; callerInputs: RecordValue; pendingRequests: Record<string, RecordValue> } };
type Activity = {
  availability: string[];
  invocations: Array<{ callId: string; nodeId: string; attempt: number; parentCallId?: string; inputGoal: unknown; model: unknown }>;
  repairs: number;
  telemetry: number;
  launches: number;
  legacyUsage: number;
  delegated: Promise<void>[];
};
type FixtureEvent = { stage: string; callId?: string; runId?: string; nodeId?: string; attempt?: number; model?: string; capturedInstruction?: boolean; liveInstruction?: boolean };

const fixtureSource = fileURLToPath(new URL("../fixtures/par-037-caller-input-provider.mjs", import.meta.url));
const scenarioBudgetMs = 20_000;
const cleanupBudgetMs = 10_000;
const profileTimeoutMs = 20_000;
const testCeilingMs = 35_000;
const fixtureLifetimeMs = 60_000;
const labelPrefix = "par-037-caller-input-";

test.each(["missing", "invalid"] as const)("PAR-037 pauses before admission for %s required caller input", async (variant) => {
  await exerciseInitialPause(variant);
}, testCeilingMs);

test("PAR-037 validates workspace references before applying a caller answer and uses captured context", async () => {
  await exerciseCapturedCallerInputContinuation();
}, testCeilingMs);

async function exerciseInitialPause(variant: "missing" | "invalid"): Promise<void> {
  const deadline = Date.now() + scenarioBudgetMs;
  const label = `${labelPrefix}${variant}-café`;
  const project = createInitializedProject(label);
  const identity = realpathSync.native(project);
  const state = configureProject(project);
  const activity = createActivity();
  const promises: Promise<Outcome>[] = [];
  let cleanupErrors: Error[] = [];
  let primaryError: unknown;
  let hasPrimaryError = false;

  try {
    assertOwnedProject(project, identity, label);
    const request = runRequest(project, variant === "invalid" ? { goal: 42 } : undefined);
    const initial = capturePublic(runWorkflow(request, observeProvider(project, activity)), activity);
    promises.push(initial);
    const outcome = await withDeadline(initial, deadline, `${variant} caller-input pause`);
    const result = requireResult(outcome, `initial ${variant} caller-input run`);
    const actualError = result.status === "error" ? errorCode(result.result) : "none";
    expect(result.status, `PAR-037 ${variant} initial caller input should pause before admission; observed code=${actualError}`).toBe("needs_input");

    const requestValue = callerRequestFromResult(result.result);
    const runId = result.runId;
    assertCallerPause(project, runId, requestValue, variant === "invalid" ? { goal: 42 } : {});
    expect(activitySnapshot(activity)).toEqual(emptyActivity());
    expect(readFixtureEvents(state.events)).toEqual([]);
    const beforeInvalidAnswer = snapshotRunTree(project, runId);
    const invalidAnswer = capturePublic(resumeWorkflow({ projectRoot: project, runId, requestId: requestValue.id, answers: { goal: 42 } }, observeProvider(project, activity)), activity);
    promises.push(invalidAnswer);
    const rejected = await withDeadline(invalidAnswer, deadline, "invalid caller-input answer");
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind === "rejected") expect(errorCode(rejected.error)).toBe("ANSWERS_INVALID");
    expect(snapshotRunTree(project, runId)).toEqual(beforeInvalidAnswer);
    expect(activitySnapshot(activity)).toEqual(emptyActivity());
    expect(readFixtureEvents(state.events)).toEqual([]);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    cleanupErrors = await settleAndCleanup(project, identity, label, promises, activity, hasPrimaryError);
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "PAR-037 caller-input pause and cleanup both failed.");
  if (!hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-037 caller-input pause cleanup failed.");
  if (hasPrimaryError) throw primaryError;
}

async function exerciseCapturedCallerInputContinuation(): Promise<void> {
  const deadline = Date.now() + scenarioBudgetMs;
  const label = `${labelPrefix}captured-context-café`;
  const project = createInitializedProject(label);
  const identity = realpathSync.native(project);
  const state = configureProject(project);
  const activity = createActivity();
  const promises: Promise<Outcome>[] = [];
  let cleanupErrors: Error[] = [];
  let primaryError: unknown;
  let hasPrimaryError = false;
  let referenceBytes: Buffer | undefined;
  let runId: string | undefined;

  try {
    assertOwnedProject(project, identity, label);
    const referencePath = path.join(project, "workspace-note.md");
    referenceBytes = Buffer.from("Captured workspace reference.\n", "utf8");
    writeFileSync(referencePath, referenceBytes);
    const referenceManifest = path.join(project, ".nodulus", "fixtures", "references.json");
    writeJson(project, ".nodulus/fixtures/references.json", { references: [{ path: "workspace-note.md", mode: "workspace" }] });
    const initial = capturePublic(runWorkflow({ ...runRequest(project), referencesFile: referenceManifest }, observeProvider(project, activity)), activity);
    promises.push(initial);
    const outcome = await withDeadline(initial, deadline, "initial captured caller-input pause");
    const result = requireResult(outcome, "initial captured caller-input run");
    const actualError = result.status === "error" ? errorCode(result.result) : "none";
    expect(result.status, `PAR-037 caller input should pause before admission; observed code=${actualError}`).toBe("needs_input");
    runId = result.runId;
    const request = callerRequestFromResult(result.result);
    assertCallerPause(project, runId, request, {});
    expect(activitySnapshot(activity)).toEqual(emptyActivity());
    expect(readFixtureEvents(state.events)).toEqual([]);

    const inputBytes = readRunBytes(project, runId, "inputs.json");
    const inputSha256 = digest(inputBytes);
    const beforeChangedReference = snapshotRunTree(project, runId);
    writeFileSync(referencePath, "Changed workspace reference.\n", "utf8");
    const changedReference = capturePublic(resumeWorkflow({ projectRoot: project, runId, requestId: request.id, answers: { goal: "restore captured context" } }, observeProvider(project, activity)), activity);
    promises.push(changedReference);
    const changedOutcome = await withDeadline(changedReference, deadline, "changed-reference preflight");
    expect(changedOutcome.kind).toBe("rejected");
    if (changedOutcome.kind === "rejected") expect(errorCode(changedOutcome.error)).toBe("WORKSPACE_REFERENCE_CHANGED");
    expect(snapshotRunTree(project, runId)).toEqual(beforeChangedReference);
    expect(readRunBytes(project, runId, "inputs.json")).toEqual(inputBytes);
    expect(activitySnapshot(activity)).toEqual(emptyActivity());
    expect(readFixtureEvents(state.events)).toEqual([]);

    writeFileSync(referencePath, referenceBytes);
    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const liveSettings = readProjectJson(project, ".nodulus/settings.json") as RecordValue;
    const liveProfiles = liveSettings.providerProfiles as Record<string, RecordValue>;
    liveProfiles.fixture = { ...liveProfiles.fixture, executable: state.liveProvider, model: "live-mutated-model", timeoutMs: 1 };
    writeJson(project, ".nodulus/settings.json", liveSettings);
    writeFileSync(path.join(project, ".nodulus", "instructions", "goal.md"), "LIVE MUTATED INSTRUCTIONS.\n", "utf8");
    expect(existsSync(settingsPath)).toBe(true);

    const resumed = capturePublic(resumeWorkflow({ projectRoot: project, runId, requestId: request.id, answers: { goal: "Restore the captured caller goal" } }, observeProvider(project, activity)), activity);
    promises.push(resumed);
    const resumedOutcome = await withDeadline(resumed, deadline, "valid caller-input continuation");
    const final = requireResult(resumedOutcome, "valid caller-input continuation");
    expect(final.status).toBe("success");
    expect(final.runId).toBe(runId);
    expect(final.result).toMatchObject({ artifacts: [{ name: "finalReport", contract: "report.v1", data: { text: "caller input accepted" } }] });

    const checkpoint = readCheckpoint(runFile(project, runId, "run.json"));
    expect(checkpoint).toMatchObject({ status: "success", completedNodes: ["root"], graph: { callerInputs: { goal: "Restore the captured caller goal" }, nodes: { root: { phase: "accepted", attempt: 1 } } } });
    expect(readRunBytes(project, runId, "inputs.json")).toEqual(inputBytes);
    expect(digest(readRunBytes(project, runId, "inputs.json"))).toBe(inputSha256);
    assertCallerAnswerCommit(project, runId, request, { goal: "Restore the captured caller goal" });
    expect(activity.invocations).toHaveLength(1);
    expect(activity.invocations[0]).toMatchObject({ nodeId: "root", attempt: 1, inputGoal: "Restore the captured caller goal", model: "captured-goal-model" });
    expect(activity.invocations[0]?.parentCallId).toBeUndefined();
    expect(activity.availability).toEqual(["captured-goal-model"]);
    expect(activity.repairs).toBe(0);
    const callId = activity.invocations[0]?.callId;
    if (!callId) throw new Error("PAR-037 root invocation did not record its runtime call ID.");
    const savedCall = readJson(runFile(project, runId, `calls/${callId}/request.json`));
    expect(savedCall).toMatchObject({ nodeId: "root", callId, attempt: 1, requestedModel: "captured-goal-model", parentCallId: null });
    expect(readJson(runFile(project, runId, `calls/${callId}/transport.json`))).toMatchObject({ callId, started: true, exitCode: 0, cancelled: false, timedOut: false, outputLimitExceeded: false });
    const fixtureEvents = readFixtureEvents(state.events);
    expect(fixtureEvents.map(({ stage }) => stage)).toEqual(["version", "readiness", "version", "readiness", "inference"]);
    expect(fixtureEvents.find(({ stage }) => stage === "inference")).toMatchObject({ runId, nodeId: "root", callId, attempt: 1, model: "captured-goal-model", capturedInstruction: true, liveInstruction: false });
    expect(existsSync(state.providerSentinel)).toBe(false);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    cleanupErrors = await settleAndCleanup(project, identity, label, promises, activity, hasPrimaryError);
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([asError(primaryError), ...cleanupErrors], "PAR-037 captured-context continuation and cleanup both failed.");
  if (!hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "PAR-037 captured-context continuation cleanup failed.");
  if (hasPrimaryError) throw primaryError;
}

function configureProject(project: string): { events: string; providerSentinel: string; liveProvider: string } {
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const events = path.join(fixtureDirectory, "par-037-events.jsonl");
  const providerSentinel = path.join(project, "unexpected-provider-executable.txt");
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(events, "", { encoding: "utf8", flag: "wx" });
  writeFileSync(path.join(fixtureDirectory, "par-037-caller-input-provider.mjs"), readFileSync(fixtureSource, "utf8"), "utf8");
  writeJson(project, ".nodulus/fixtures/par-037-control.json", { eventsPath: path.relative(project, events), fixtureLifetimeMs, capturedInstruction: "CAPTURED CALLER-INPUT INSTRUCTIONS", liveInstruction: "LIVE MUTATED INSTRUCTIONS" });

  const wrapperName = process.platform === "win32" ? "par-037-provider.cmd" : "par-037-provider.sh";
  const wrapper = path.join(fixtureDirectory, wrapperName);
  const liveProvider = path.join(fixtureDirectory, process.platform === "win32" ? "par-037-live-provider.cmd" : "par-037-live-provider.sh");
  if (process.platform === "win32") {
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-037-caller-input-provider.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-037-caller-input-provider.mjs' "$@"\n`, "utf8");
    chmodSync(wrapper, 0o755);
  }
  if (process.platform === "win32") {
    writeFileSync(liveProvider, `@echo off\r\necho invoked > "${providerSentinel}"\r\n"${process.execPath}" ".nodulus\\fixtures\\par-037-caller-input-provider.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    writeFileSync(liveProvider, `#!/bin/sh\nprintf 'invoked\\n' > ${shellQuote(providerSentinel)}\nexec ${shellQuote(process.execPath)} '.nodulus/fixtures/par-037-caller-input-provider.mjs' "$@"\n`, "utf8");
    chmodSync(liveProvider, 0o755);
  }

  const settings = readProjectJson(project, ".nodulus/settings.json") as RecordValue;
  settings.providerProfiles = {
    fixture: { enabled: true, executable: wrapper, kind: "codex", model: "captured-goal-model", timeoutMs: profileTimeoutMs, capabilities: [], sandbox: "read-only", reasoningEffort: "medium" },
  };
  writeJson(project, ".nodulus/settings.json", settings);
  writeJson(project, ".nodulus/contracts/goal.v1.schema.json", { type: "string", minLength: 5 });
  writeJson(project, ".nodulus/contracts/report.v1.schema.json", { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false });
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 2,
    id: "example",
    nodes: ["root"],
    inputs: { goal: { contract: "goal.v1" } },
    execution: { kind: "dag", maxConcurrency: 1, dependsOn: { root: [] }, resources: { root: [] } },
    outputs: [{ name: "finalReport", from: "root.report", contract: "report.v1" }],
  });
  writeJson(project, ".nodulus/nodes/root.json", {
    schemaVersion: 1,
    id: "root",
    providerProfile: "fixture",
    instructions: [".nodulus/instructions/goal.md"],
    inputs: { goal: { from: "caller.goal", contract: "goal.v1" } },
    expectedOutputs: [{ name: "report", contract: "report.v1" }],
  });
  writeFileSync(path.join(project, ".nodulus", "instructions", "goal.md"), "CAPTURED CALLER-INPUT INSTRUCTIONS\n", "utf8");
  return { events, providerSentinel, liveProvider };
}

function observeProvider(project: string, activity: Activity): ProviderPort {
  const delegate = createDefaultProviderPort(project);
  return {
    ...delegate,
    invoke(invocation) {
      const callId = invocation.call?.callId;
      if (!callId) throw new Error("PAR-037 invocation is missing its runtime call ID.");
      activity.invocations.push({ nodeId: invocation.nodeId, callId, attempt: invocation.attempt, ...(invocation.call?.parentCallId === undefined ? {} : { parentCallId: invocation.call.parentCallId }), inputGoal: structuredClone(invocation.inputs.goal), model: invocation.providerProfile.model });
      return trackDelegated(delegate.invoke(invocation), activity);
    },
    ...(delegate.isAvailable ? { isAvailable: (profile: RecordValue, options?: Parameters<NonNullable<ProviderPort["isAvailable"]>>[1]) => {
      activity.availability.push(typeof profile.model === "string" ? profile.model : "unknown");
      return trackDelegated(delegate.isAvailable!(profile, options), activity);
    } } : {}),
    ...(delegate.repairResponse ? { repairResponse: (invocation: ProviderInvocation, raw: string, errors: string[]) => {
      activity.repairs += 1;
      return trackDelegated(delegate.repairResponse!(invocation, raw, errors), activity);
    } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall: (callId: string) => { activity.telemetry += 1; return delegate.telemetryForCall!(callId); } } : {}),
    ...(delegate.launchForCall ? { launchForCall: (callId: string) => { activity.launches += 1; return delegate.launchForCall!(callId); } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall: () => { activity.legacyUsage += 1; return delegate.usageForLastCall!(); } } : {}),
  };
}

function createActivity(): Activity { return { availability: [], invocations: [], repairs: 0, telemetry: 0, launches: 0, legacyUsage: 0, delegated: [] }; }
function emptyActivity(): Omit<Activity, "delegated"> { return { availability: [], invocations: [], repairs: 0, telemetry: 0, launches: 0, legacyUsage: 0 }; }
function activitySnapshot(activity: Activity): Omit<Activity, "delegated"> { return { availability: [...activity.availability], invocations: structuredClone(activity.invocations), repairs: activity.repairs, telemetry: activity.telemetry, launches: activity.launches, legacyUsage: activity.legacyUsage }; }

function capturePublic(promise: Promise<ApplicationRunResult>, activity: Activity): Promise<Outcome> {
  const outcome = promise.then<Outcome, Outcome>((value) => ({ kind: "result", value }), (error: unknown) => ({ kind: "rejected", error }));
  activity.delegated.push(outcome.then(() => undefined));
  return outcome;
}

function trackDelegated<T>(operation: T, activity: Activity): T {
  if (typeof operation === "object" && operation !== null && "then" in operation && typeof operation.then === "function") {
    activity.delegated.push(Promise.resolve(operation).then(() => undefined, () => undefined));
  }
  return operation;
}

function runRequest(project: string, callerInputs?: Record<string, unknown>) {
  return { projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline" as const, text: "Generate the requested caller-input report." }], ...(callerInputs === undefined ? {} : { callerInputs }) };
}

function requireResult(outcome: Outcome, description: string): ApplicationRunResult {
  if (outcome.kind === "rejected") throw new Error(`PAR-037 ${description} rejected: ${describeError(outcome.error)}`);
  return outcome.value;
}

function callerRequestFromResult(result: unknown): CallerRequest {
  if (!isRecord(result) || !isRecord(result.request)) throw new Error("PAR-037 pause result has no singular caller-input request.");
  const request = result.request;
  if (typeof request.id !== "string" || !isRecord(request.answerContract)) throw new Error("PAR-037 caller-input request has invalid identity or answer contract.");
  return request as unknown as CallerRequest;
}

function assertCallerPause(project: string, runId: string, request: CallerRequest, capturedCallerInputs: RecordValue): void {
  expect(request.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  expect(request).toMatchObject({ nodeId: null, attempt: 0 });
  expect(request.answerContract).toMatchObject({ type: "object", required: ["goal"], additionalProperties: false, properties: { goal: { $ref: "#/$defs/goal.v1" } } });
  const runRoot = runDirectory(project, runId);
  const checkpoint = readCheckpoint(path.join(runRoot, "run.json"));
  expect(checkpoint).toMatchObject({ schemaVersion: 2, status: "needs_input", completedNodes: [], graph: { admissionClosed: true, nodes: { root: { phase: "not_started", attempt: 0 } }, callerInputs: capturedCallerInputs } });
  expect(Object.keys(checkpoint.graph.pendingRequests)).toEqual([request.id]);
  const pending = readJson(path.join(runRoot, `pending/${request.id}.json`));
  const bytes = readFileSync(path.join(runRoot, `pending/${request.id}.json`));
  expect(pending).toEqual(request);
  expect(checkpoint.graph.pendingRequests).toMatchObject({ [request.id]: { nodeId: null, kind: "caller_inputs", attempt: 0, requestRef: `pending/${request.id}.json`, requestSha256: digest(bytes) } });
  expect(existsSync(path.join(runRoot, "nodes", "root"))).toBe(false);
  expect(existsSync(path.join(runRoot, "calls"))).toBe(false);
  const events = readRunEvents(project, runId);
  expect(events.filter((event) => event.event === "run.intake.completed")).toHaveLength(1);
  expect(events.filter((event) => event.event === "run.needs_input" && Array.isArray(event.requestIds) && event.requestIds.includes(request.id))).toHaveLength(1);
  expect(events.every((event) => typeof event.sequence === "number" && Number.isSafeInteger(event.sequence))).toBe(true);
  const sequences = events.map((event) => event.sequence as number);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(sequences[0]).toBe(1);
  for (let index = 1; index < sequences.length; index += 1) expect(sequences[index]).toBe(sequences[index - 1]! + 1);
  expect(events.some((event) => typeof event.event === "string" && /^(?:node\.|provider\.call\.)/.test(event.event))).toBe(false);
}

function readCheckpoint(file: string): Checkpoint {
  const value = readJson(file);
  if (!isRecord(value.graph) || !isRecord(value.graph.nodes) || !isRecord(value.graph.pendingRequests) || !isRecord(value.graph.callerInputs) ||
      typeof value.schemaVersion !== "number" || typeof value.status !== "string" || !Array.isArray(value.completedNodes) ||
      typeof value.graph.admissionClosed !== "boolean") throw new Error("PAR-037 graph checkpoint has an invalid caller-input projection.");
  return value as unknown as Checkpoint;
}

function assertCallerAnswerCommit(project: string, runId: string, request: CallerRequest, answer: RecordValue): void {
  const answerRef = `answers/${request.id}.json`;
  const bytes = readRunBytes(project, runId, answerRef);
  expect(JSON.parse(bytes.toString("utf8"))).toEqual(answer);
  const checkpoint = readCheckpoint(runFile(project, runId, "run.json"));
  expect(checkpoint.graph.pendingRequests).toMatchObject({ [request.id]: { nodeId: null, kind: "caller_inputs", attempt: 0, answerRef, answerSha256: digest(bytes) } });
  const events = readRunEvents(project, runId);
  const answered = events.filter((event) => event.event === "request.answered" && event.requestId === request.id);
  expect(answered).toHaveLength(1);
  expect(answered[0]).toMatchObject({ requestId: request.id, kind: "caller_inputs", nodeId: null });
  expect(answered[0]).not.toHaveProperty("answer");
  expect(answered[0]).not.toHaveProperty("answers");
  const eventText = JSON.stringify(answered[0]);
  expect(eventText).not.toContain(JSON.stringify(answer));
  for (const value of Object.values(answer)) expect(eventText).not.toContain(String(value));
}

async function settleAndCleanup(project: string, identity: string, label: string, promises: Promise<Outcome>[], activity: Activity, retain: boolean): Promise<Error[]> {
  const errors: Error[] = [];
  const deadline = Date.now() + cleanupBudgetMs;
  try { await withDeadline(Promise.all(promises), deadline, "public run/resume settlement"); }
  catch (error) { errors.push(asError(error)); }
  try { await withDeadline(Promise.all(activity.delegated), deadline, "default provider child settlement"); }
  catch (error) { errors.push(asError(error)); }
  if (retain || errors.length > 0) {
    console.error(`PAR-037 retained project for diagnosis: ${project}`);
    return errors;
  }
  try {
    assertOwnedProject(project, identity, label);
    rmSync(project, { recursive: true, force: true });
    if (existsSync(project)) throw new Error("PAR-037 owned project remained after cleanup.");
  } catch (error) { errors.push(asError(error)); }
  return errors;
}

function assertOwnedProject(project: string, identity: string, label: string): void {
  const temp = realpathSync.native(tmpdir());
  const current = realpathSync.native(project);
  const relative = path.relative(temp, current);
  if (current !== identity || path.dirname(current) !== temp || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(current).startsWith(`nodulus-${label}-`)) throw new Error("PAR-037 cleanup target is not the exact owned temporary project.");
}

function snapshotRunTree(project: string, runId: string): Array<[string, Buffer]> {
  const root = runDirectory(project, runId);
  const result: Array<[string, Buffer]> = [];
  const visit = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const childRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) result.push([childRelative, readFileSync(child)]);
    }
  };
  visit(root, "");
  return result.sort(([left], [right]) => left.localeCompare(right));
}

function readFixtureEvents(file: string): FixtureEvent[] {
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
}
function readRunEvents(project: string, runId: string): Array<RecordValue> { return readFileSync(runFile(project, runId, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RecordValue); }
function runDirectory(project: string, runId: string): string { return path.join(project, ".nodulus", "runs", runId); }
function runFile(project: string, runId: string, relative: string): string { return path.join(runDirectory(project, runId), relative); }
function readRunBytes(project: string, runId: string, relative: string): Buffer { return readFileSync(runFile(project, runId, relative)); }
function readJson(file: string): RecordValue { const value: unknown = JSON.parse(readFileSync(file, "utf8")); if (!isRecord(value)) throw new Error(`PAR-037 expected JSON object at ${path.basename(file)}.`); return value; }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function errorCode(value: unknown): string {
  if (!isRecord(value)) return "unknown";
  if (typeof value.code === "string") return value.code;
  return isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : "unknown";
}
function isRecord(value: unknown): value is RecordValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function describeError(error: unknown): string { return isRecord(error) ? `${typeof error.code === "string" ? error.code : "unknown"}: ${typeof error.message === "string" ? error.message.slice(0, 400) : "no message"}` : "non-object rejection"; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(typeof error === "string" ? error : "PAR-037 unknown cleanup failure."); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

async function withDeadline<T>(promise: Promise<T>, deadline: number, description: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`PAR-037 shared deadline expired before ${description}.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`PAR-037 shared deadline expired during ${description}.`)), remaining); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

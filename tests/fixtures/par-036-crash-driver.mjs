import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { errorMonitor } from "node:events";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const publicApiPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const providerPath = fileURLToPath(new URL("../../dist/adapters/providers/default-provider-port.js", import.meta.url));
const { runWorkflow } = await import(pathToFileURL(publicApiPath).href);
const { createDefaultProviderPort } = await import(pathToFileURL(providerPath).href);
const [operation, nonce, projectRoot, controlDirectory, aEntryPath, deadlineText] = process.argv.slice(2);
const protocol = "par-036-crash-driver-v1";
const maxChildRecords = 64;
const maxEnvelopeBytes = 192_000;
const deadline = Number(deadlineText);
const state = new AsyncLocalStorage();
const processChannel = channel("child_process");
const childRecords = [];
const childRecordByProcess = new WeakMap();
const delegatedSettlements = [];
const delegatedOperations = [];
const observations = { availability: [], invocations: [], repairs: [], overflow: false, childObservationFailure: false };
let publicStarted = false;

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, filePath);
}

function validIdentity() {
  return operation === "initial" && typeof nonce === "string" && /^[0-9a-f-]{36}$/iu.test(nonce)
    && typeof projectRoot === "string" && path.isAbsolute(projectRoot)
    && typeof controlDirectory === "string" && path.isAbsolute(controlDirectory)
    && typeof aEntryPath === "string" && path.isAbsolute(aEntryPath)
    && Number.isSafeInteger(deadline) && deadline > Date.now();
}

function safeError(error) {
  let name = "Error";
  let code;
  let message = "Non-Error rejection value.";
  try {
    if (error instanceof Error) {
      name = error.name.slice(0, 80);
      message = error.message.slice(0, 900);
      if (typeof error.code === "string") code = error.code.slice(0, 100);
    } else if (typeof error === "string") message = error.slice(0, 900);
  } catch { message = "Rejection details could not be read safely."; }
  return { name, ...(code === undefined ? {} : { code }), message };
}

function outcomeOf(promise) {
  return Promise.resolve(promise).then(
    (result) => ({ kind: "result", result: { runId: result.runId, status: result.status, result: result.result } }),
    (error) => ({ kind: "error", error: safeError(error) }),
  );
}

function track(operationValue, context) {
  const record = {
    identity: delegatedOperations.length + 1,
    nodeId: context.nodeId,
    operation: context.operation,
    callId: typeof context.callId === "string" ? context.callId : null,
    attempt: Number.isSafeInteger(context.attempt) ? context.attempt : null,
    settled: false,
  };
  if (delegatedOperations.length >= 64) observations.overflow = true;
  else delegatedOperations.push(record);
  if (operationValue !== null && (typeof operationValue === "object" || typeof operationValue === "function")
    && "then" in operationValue && typeof operationValue.then === "function") {
    delegatedSettlements.push(Promise.resolve(operationValue).then(
      () => { record.settled = true; },
      () => { record.settled = true; },
    ));
  } else record.settled = true;
  return operationValue;
}

function safeNodeId(profile) {
  const model = typeof profile?.model === "string" ? profile.model : "";
  for (const nodeId of ["seed", "a", "b"]) if (model === `par-036-${nodeId}`) return nodeId;
  return "unknown";
}

function observeChild(message) {
  try {
    if (typeof message !== "object" || message === null || !("process" in message)) return;
    const candidate = message.process;
    if (typeof candidate !== "object" || candidate === null || !("once" in candidate) || typeof candidate.once !== "function") return;
    const child = candidate;
    if (childRecordByProcess.has(child)) return;
    if (childRecords.length >= maxChildRecords) {
      observations.overflow = true;
      return;
    }
    const context = state.getStore();
    const record = {
      identity: childRecords.length + 1,
      nodeId: context?.nodeId ?? "unlabelled",
      operation: context?.operation ?? "unlabelled",
      callId: typeof context?.callId === "string" ? context.callId : null,
      attempt: Number.isSafeInteger(context?.attempt) ? context.attempt : null,
      ordinal: context ? ++context.childOrdinal : null,
      pid: typeof child.pid === "number" && Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null,
      spawned: false,
      exited: false,
      closed: false,
      exitCode: null,
      signal: null,
      errorName: null,
      spawnedAt: null,
      exitedAt: null,
      closedAt: null,
      closePromise: undefined,
      closeResolve: undefined,
    };
    record.closePromise = new Promise((resolve) => { record.closeResolve = resolve; });
    childRecordByProcess.set(child, record);
    childRecords.push(record);
    const now = () => Number(process.hrtime.bigint() / 1_000_000n);
    child.once("spawn", () => {
      record.spawned = true;
      record.spawnedAt = now();
      record.pid = typeof child.pid === "number" && Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    });
    child.once(errorMonitor, (error) => { record.errorName = error instanceof Error ? error.name.slice(0, 64) : "UnknownError"; });
    child.once("exit", (code, signal) => {
      record.exited = true;
      record.exitedAt = now();
      record.exitCode = code ?? null;
      record.signal = signal ?? null;
    });
    child.once("close", (code, signal) => {
      record.closed = true;
      record.closedAt = now();
      record.exitCode = code ?? null;
      record.signal = signal ?? null;
      record.closeResolve();
    });
  } catch { observations.childObservationFailure = true; }
}

processChannel.subscribe(observeChild);

function childSnapshot() {
  return childRecords.map(({ identity, nodeId, operation: childOperation, callId, attempt, ordinal, pid, spawned, exited, closed, exitCode, signal, errorName, spawnedAt, exitedAt, closedAt }) => ({
    identity, nodeId, operation: childOperation, callId, attempt, ordinal, pid, spawned, exited, closed,
    exitCode, signal, ...(errorName === null ? {} : { errorName }), spawnedAt, exitedAt, closedAt,
  }));
}

function observedProvider() {
  const delegate = createDefaultProviderPort(projectRoot);
  return {
    invoke(invocation) {
      const record = {
        nodeId: invocation.nodeId,
        runId: invocation.runId,
        callId: typeof invocation.call?.callId === "string" ? invocation.call.callId : null,
        attempt: Number.isSafeInteger(invocation.call?.attempt) ? invocation.call.attempt : invocation.attempt,
      };
      if (observations.invocations.length >= 16) observations.overflow = true;
      else observations.invocations.push(record);
      const context = { ...record, operation: "invoke", childOrdinal: 0 };
      return track(state.run(context, () => delegate.invoke(invocation)), context);
    },
    ...(delegate.isAvailable ? { isAvailable(profile, options) {
      const record = { nodeId: safeNodeId(profile), model: typeof profile.model === "string" ? profile.model.slice(0, 80) : "unknown" };
      if (observations.availability.length >= 16) observations.overflow = true;
      else observations.availability.push(record);
      const context = { ...record, callId: null, attempt: null, operation: "availability", childOrdinal: 0 };
      return track(state.run(context, () => delegate.isAvailable(profile, options)), context);
    } } : {}),
    ...(delegate.repairResponse ? { repairResponse(invocation, previousRawResponse, validationErrors) {
      const record = {
        nodeId: invocation.nodeId,
        runId: invocation.runId,
        callId: typeof invocation.call?.callId === "string" ? invocation.call.callId : null,
        attempt: Number.isSafeInteger(invocation.call?.attempt) ? invocation.call.attempt : invocation.attempt,
      };
      if (observations.repairs.length >= 16) observations.overflow = true;
      else observations.repairs.push(record);
      const context = { ...record, operation: "repair_response", childOrdinal: 0 };
      return track(state.run(context, () => delegate.repairResponse(invocation, previousRawResponse, validationErrors)), context);
    } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall(callId) { return delegate.telemetryForCall(callId); } } : {}),
    ...(delegate.launchForCall ? { launchForCall(callId) { return delegate.launchForCall(callId); } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall() { return delegate.usageForLastCall(); } } : {}),
  };
}

async function waitForAEntry() {
  const publicSettledPath = path.join(controlDirectory, "public-settled.json");
  while (Date.now() < deadline) {
    if (existsSync(aEntryPath)) return JSON.parse(readFileSync(aEntryPath, "utf8"));
    if (existsSync(publicSettledPath)) throw new Error("Public run settled before the held A provider entry marker appeared.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The held A provider entry marker was not observed before the scenario deadline.");
}

async function waitForChildrenToClose() {
  while (true) {
    const observed = childRecords.length;
    const open = childRecords.filter((record) => !record.closed);
    if (open.length === 0 && observed === childRecords.length) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Owned provider child close wait expired with ${open.length} open processes.`);
    let timer;
    try {
      await Promise.race([
        Promise.all(open.map((record) => record.closePromise)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned provider child close wait expired with ${open.length} open processes.`)), remaining); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
    if (observed === childRecords.length && childRecords.every((record) => record.closed)) return;
  }
}

function writeEnvelope(envelope, exitCode = 0) {
  let serialized;
  try { serialized = JSON.stringify(envelope); }
  catch { serialized = ""; }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxEnvelopeBytes) {
    serialized = JSON.stringify({ protocol, operation, nonce, ok: false, error: { name: "Error", message: "Bounded crash driver envelope could not be serialized." } });
    process.exitCode = 1;
  } else if (exitCode !== 0) process.exitCode = exitCode;
  process.stdout.write(`${serialized}\n`);
}

async function main() {
  if (!validIdentity()) throw new Error("Invalid PAR-036 driver identity or operation.");
  atomicJson(path.join(controlDirectory, "driver-ready.json"), { protocol, nonce, pid: process.pid });
  const provider = observedProvider();
  const publicPromise = runWorkflow({
    projectRoot,
    cwd: projectRoot,
    workflow: "example",
    sources: [{ kind: "inline", text: "Run the crash-recovery graph with accepted seed work and a held active branch." }],
  }, provider);
  publicStarted = true;
  const publicOutcome = outcomeOf(publicPromise);
  void publicOutcome.then((outcome) => {
    try {
      atomicJson(path.join(controlDirectory, "public-settled.json"), {
        protocol, nonce, pid: process.pid, kind: outcome.kind,
        ...(outcome.kind === "result" ? { status: outcome.result.status, runId: outcome.result.runId } : { error: outcome.error }),
      });
    } catch { observations.childObservationFailure = true; }
  }).catch(() => { observations.childObservationFailure = true; });

  let entryFailure;
  try {
    const fixtureMarker = await waitForAEntry();
    const activeSnapshot = {
      protocol, nonce, driverPid: process.pid,
      nodeId: fixtureMarker.nodeId, runId: fixtureMarker.runId, callId: fixtureMarker.callId,
      attempt: fixtureMarker.attempt, fixturePid: fixtureMarker.pid,
      observations: structuredClone(observations), childProcesses: childSnapshot(),
      delegatedOperations: structuredClone(delegatedOperations),
      childObservationFailure: observations.childObservationFailure,
    };
    atomicJson(path.join(controlDirectory, "driver-active.json"), activeSnapshot);
  } catch (error) { entryFailure = safeError(error); }
  const outcome = await publicOutcome;
  await Promise.all(delegatedSettlements);
  await waitForChildrenToClose();
  const final = {
    protocol, operation, nonce, outcome,
    publicStarted,
    observations, childProcesses: childSnapshot(), delegatedOperations,
    settled: { public: true, delegated: true, childrenClosed: true },
    childObservationFailure: observations.childObservationFailure,
    ...(entryFailure === undefined ? {} : { entryFailure }),
  };
  writeEnvelope(final, entryFailure === undefined ? 0 : 1);
}

try {
  await main();
} catch (error) {
  try {
    const pending = await Promise.resolve(error);
    writeEnvelope({ protocol, operation, nonce, publicStarted, ok: false, error: safeError(pending), observations, childProcesses: childSnapshot(), delegatedOperations, childObservationFailure: observations.childObservationFailure }, 1);
  } catch { writeEnvelope({ protocol, operation, nonce, publicStarted, ok: false, error: { name: "Error", message: "PAR-036 driver setup failed." }, observations, childProcesses: childSnapshot(), delegatedOperations, childObservationFailure: observations.childObservationFailure }, 1); }
} finally {
  processChannel.unsubscribe(observeChild);
}

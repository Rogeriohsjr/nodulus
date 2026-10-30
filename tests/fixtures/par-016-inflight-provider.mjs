import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);
if (mode === "provider") await runProvider();
else if (mode === "run") await runScenario();
else throw new Error("Unknown P16B2 fixture mode.");

async function runProvider() {
  const request = await readStdinJson();
  mkdirSync(request.stateDirectory, { recursive: true });
  writeJsonAtomic(path.join(request.stateDirectory, `started-${request.nodeId}.json`), {
    pid: process.pid, nodeId: request.nodeId, callId: request.callId,
  });
  const response = JSON.stringify({
    status: "success",
    artifacts: [{ name: "report", contract: "report.v1", data: { text: `durable:${request.nodeId}` } }],
  });
  writeJsonAtomic(path.join(request.stateDirectory, `finished-${request.nodeId}.json`), {
    pid: process.pid, nodeId: request.nodeId, callId: request.callId, finished: true, response,
  });
  process.stdout.write(response);
}

async function runScenario() {
  const [projectRoot, stateDirectory, scenarioDeadlineText] = args;
  if (!projectRoot || !stateDirectory || !scenarioDeadlineText) throw new Error("P16B2 fixture arguments are invalid.");
  const scenarioDeadline = Number(scenarioDeadlineText);
  if (!Number.isSafeInteger(scenarioDeadline) || scenarioDeadline <= Date.now()) throw new Error("P16B2 scenario deadline is invalid or expired.");
  mkdirSync(stateDirectory, { recursive: true });
  const stateEvents = path.join(stateDirectory, "events.jsonl");
  const actual = new (await import("../../dist/adapters/storage/local-intake-storage.js")).LocalIntakeStorage();
  const { runWorkflow } = await import("../../dist/index.js");
  const { runCapturedProcess } = await import("../../dist/adapters/providers/captured-process.js");
  let sequence = 0;
  let runId;
  let releaseAError;
  let releaseBReturn;
  let bAcceptedHeld;
  const aErrorGate = new Promise((resolve) => { releaseAError = resolve; });
  const bReturnGate = new Promise((resolve) => { releaseBReturn = resolve; });
  const bAcceptedGate = new Promise((resolve) => { bAcceptedHeld = resolve; });
  let originalStorageError;
  let originalStorageErrorSeen = false;
  let aFailureDelivered = false;
  let bAcceptanceCaptured = false;
  const probeCounts = {};
  const invokeCounts = {};
  const launchByCall = new Map();
  let publicRun;
  let primaryError;
  let hasPrimaryError = false;
  const cleanupErrors = [];

  const record = (event, fields = {}) => {
    const value = { sequence: ++sequence, event, ...fields };
    appendFileSync(stateEvents, `${JSON.stringify(value)}\n`, "utf8");
    return value;
  };
  const provider = {
    async isAvailable(profile) {
      const model = String(profile.model ?? "unknown");
      probeCounts[model] = (probeCounts[model] ?? 0) + 1;
      record("provider_probe", { profileModel: model });
      return true;
    },
    async invoke(invocation) {
      const nodeId = invocation.nodeId;
      const callId = invocation.call?.callId;
      if (typeof callId !== "string") throw new Error("P16B2 invocation omitted its call ID.");
      invokeCounts[nodeId] = (invokeCounts[nodeId] ?? 0) + 1;
      if (invokeCounts[nodeId] !== 1 || (nodeId !== "a" && nodeId !== "b")) throw new Error(`Unexpected P16B2 provider action for '${nodeId}'.`);
      const captured = await runCapturedProcess(
        process.execPath,
        [fixturePath, "provider"],
        { cwd: projectRoot, stdin: JSON.stringify({ nodeId, callId, stateDirectory }), timeoutMs: 8_000, ...(invocation.signal ? { signal: invocation.signal } : {}) },
        invocation,
        "invoke",
        null,
      );
      launchByCall.set(callId, captured.started);
      if (!captured.started || captured.exitCode !== 0 || captured.cancelled || captured.timedOut || captured.outputLimitExceeded) {
        throw new Error(`P16B2 provider child '${nodeId}' did not complete successfully: ${captured.stderr}`);
      }
      const started = readJson(path.join(stateDirectory, `started-${nodeId}.json`));
      const finished = readJson(path.join(stateDirectory, `finished-${nodeId}.json`));
      if (started.callId !== callId || finished.callId !== callId || started.pid !== finished.pid || finished.finished !== true || !pidExited(started.pid)) {
        throw new Error(`P16B2 provider '${nodeId}' lacks actual child completion evidence.`);
      }
      const transportBytes = readFileSync(path.join(projectRoot, ".nodulus", "runs", invocation.runId, "calls", callId, "transport.json"));
      record("provider_process_captured", {
        nodeId, callId, pid: started.pid, pidExited: true, started: captured.started,
        exitCode: captured.exitCode, timedOut: captured.timedOut, cancelled: captured.cancelled,
        outputLimitExceeded: captured.outputLimitExceeded, rawResponse: captured.stdout, transportSha256: sha256(transportBytes),
      });
      if (nodeId === "a") {
        const blockerPath = path.join(projectRoot, ".nodulus", "runs", invocation.runId, "nodes", "a", "artifacts", "report.json");
        mkdirSync(path.dirname(blockerPath), { recursive: true });
        mkdirSync(blockerPath);
        record("a_blocker_created", { target: blockerPath, blockerIsDirectory: statSync(blockerPath).isDirectory() });
      }
      if (nodeId === "b") {
        await waitFor(() => originalStorageErrorSeen, scenarioDeadline, "A actual artifact-write failure");
        record("b_response_delivered", { nodeId, callId });
      }
      return captured.stdout;
    },
    telemetryForCall() { return null; },
    launchForCall(callId) { return launchByCall.get(callId) ?? null; },
  };
  const storage = {
    async readUtf8(...values) { return actual.readUtf8(...values); },
    async createRun(...values) { const created = await actual.createRun(...values); runId = values[1]; return created; },
    async readRunFile(...values) { return actual.readRunFile(...values); },
    async acquireRunLock(...values) { return actual.acquireRunLock(...values); },
    async writeRunFiles(...values) {
      const [root, targetRunId, files] = values;
      try {
        await actual.writeRunFiles(...values);
      } catch (error) {
        if (root === projectRoot && targetRunId === runId && Object.hasOwn(files, "nodes/a/artifacts/report.json")) {
          originalStorageError = error;
          originalStorageErrorSeen = true;
          const blocker = path.join(projectRoot, ".nodulus", "runs", targetRunId, "nodes", "a", "artifacts", "report.json");
          record("a_storage_write_failed_held", {
            nodeId: "a", target: blocker, blockerIsDirectory: isDirectory(blocker),
            errorName: error?.name, errorCode: error?.code, errorMessage: error?.message,
            errorSyscall: error?.syscall, errorPath: error?.path, errorDest: error?.dest,
          });
          await aErrorGate;
          aFailureDelivered = true;
          record("a_storage_error_released", { sameException: error === originalStorageError });
        }
        throw error;
      }
      if (root === projectRoot && targetRunId === runId && Object.hasOwn(files, "run.json") && !bAcceptanceCaptured) {
        const checkpointPath = path.join(projectRoot, ".nodulus", "runs", runId, "run.json");
        const checkpointBytes = readFileSync(checkpointPath);
        const checkpoint = JSON.parse(checkpointBytes.toString("utf8"));
        if (checkpoint.graph?.nodes?.b?.phase === "accepted") {
          const eventsBytes = readFileSync(path.join(projectRoot, ".nodulus", "runs", runId, "events.jsonl"));
          const runEvents = eventsBytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
          const bAcceptedEvent = runEvents.find((event) => event.event === "node.accepted" && event.nodeId === "b");
          const aCompletedEvent = runEvents.find((event) => event.event === "provider.call.completed" && event.nodeId === "a" && event.operation === "invoke");
          bAcceptanceCaptured = true;
          const held = record("b_accepted_checkpoint_held", {
            runId, checkpointBase64: checkpointBytes.toString("base64"), checkpointSha256: sha256(checkpointBytes),
            eventsBase64: eventsBytes.toString("base64"), eventsSha256: sha256(eventsBytes),
            aCallCompletedBeforeB: Boolean(aCompletedEvent && bAcceptedEvent && aCompletedEvent.sequence < bAcceptedEvent.sequence),
            aNode: checkpoint.graph.nodes.a, bNode: checkpoint.graph.nodes.b,
          });
          bAcceptedHeld(held);
          await bReturnGate;
          record("b_successful_storage_return_released", { sequenceBeforeReturn: held.sequence });
        }
      }
    },
  };

  const coordinate = (async () => {
    try {
      const held = await withTimeout(bAcceptedGate, remaining(scenarioDeadline), "B durable accepted checkpoint");
      record("b_storage_return_held", { sourceSequence: held.sequence });
      releaseAError();
      await new Promise((resolve) => setImmediate(resolve));
      record("a_error_delivery_microtask_barrier");
      releaseBReturn();
    } catch (error) {
      record("coordinator_failed", { message: error instanceof Error ? error.message : "Non-Error coordinator failure." });
      releaseAError();
      releaseBReturn();
      throw error;
    }
  })();
  void coordinate.catch(() => undefined);

  let outcome;
  try {
    publicRun = runWorkflow({
      projectRoot, cwd: projectRoot, workflow: "example",
      sources: [{ kind: "inline", text: "Exercise durable acceptance while sibling storage failure poisons admission." }],
    }, provider, { storage });
    outcome = await withTimeout(publicRun, remaining(scenarioDeadline), "public P16B2 workflow").then(
      (result) => ({ kind: "result", result }),
      (error) => ({ kind: "rejection", error: serializeError(error) }),
    );
    await withTimeout(coordinate, remaining(scenarioDeadline), "P16B2 handoff coordinator");
    record("workflow_settled", { runId, kind: outcome.kind, status: outcome.result?.status, result: outcome.result?.result, error: outcome.error });
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    releaseAError();
    releaseBReturn();
    const cleanupDeadline = Date.now() + 8_000;
    if (publicRun) {
      try { await withTimeout(Promise.resolve(publicRun).then(() => undefined, () => undefined), remaining(cleanupDeadline), "public workflow cleanup"); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await withTimeout(coordinate.catch(() => undefined), remaining(cleanupDeadline), "coordinator cleanup"); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (hasPrimaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], "P16B2 scenario and bounded cleanup both failed.");
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "P16B2 bounded cleanup failed.");
  const checkpointPath = path.join(projectRoot, ".nodulus", "runs", runId, "run.json");
  const finalCheckpoint = readFileSync(checkpointPath);
  const acceptedSnapshot = findEvent(stateEvents, "b_accepted_checkpoint_held");
  record("final_checkpoint", { sha256: sha256(finalCheckpoint), matchesAcceptedSnapshot: bAcceptanceCaptured && sha256(finalCheckpoint) === acceptedSnapshot?.checkpointSha256 });
  process.stdout.write(JSON.stringify({ runId, outcome, probeCounts, invokeCounts, originalStorageErrorSeen, aFailureDelivered, bAcceptanceCaptured }));
}

function findEvent(file, name) {
  const events = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return events.find((entry) => entry.event === name);
}
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function isDirectory(file) { try { return statSync(file).isDirectory(); } catch { return false; } }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function pidExited(pid) { try { process.kill(pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; } }
async function waitFor(predicate, deadline, label) {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`P16B2 timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error(`P16B2 cleanup deadline expired before ${label}.`));
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`P16B2 timed out waiting for ${label}.`)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
function remaining(deadline) { return Math.max(0, deadline - Date.now()); }
function serializeError(error) {
  return { name: error?.name, code: error?.code, message: error?.message, path: error?.path, syscall: error?.syscall };
}
function readStdinJson() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } });
  });
}
function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, file);
}

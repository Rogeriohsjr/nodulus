import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);

if (mode === "provider") await runProvider();
else if (mode === "run") await runScenario();
else throw new Error(`Unknown P16B fixture mode '${String(mode)}'.`);

async function runProvider() {
  const request = await readStdinJson();
  mkdirSync(request.stateDirectory, { recursive: true });
  writeJsonAtomic(path.join(request.stateDirectory, `started-${request.nodeId}.json`), {
    pid: process.pid,
    nodeId: request.nodeId,
    callId: request.callId,
  });
  writeJsonAtomic(path.join(request.stateDirectory, `finished-${request.nodeId}.json`), {
    pid: process.pid,
    nodeId: request.nodeId,
    callId: request.callId,
    finished: true,
  });
  process.stdout.write(JSON.stringify({
    status: "success",
    artifacts: [{ name: "report", contract: "report.v1", data: { text: `done:${request.nodeId}` } }],
  }));
}

async function runScenario() {
  const [projectRoot, stateDirectory] = args;
  if (!projectRoot || !stateDirectory) throw new Error("P16B fixture arguments are invalid.");
  mkdirSync(stateDirectory, { recursive: true });
  const eventPath = path.join(stateDirectory, "events.jsonl");
  const actual = new (await import("../../dist/adapters/storage/local-intake-storage.js")).LocalIntakeStorage();
  const { runWorkflow } = await import("../../dist/index.js");
  const { runCapturedProcess } = await import("../../dist/adapters/providers/captured-process.js");
  let eventSequence = 0;
  let runId;
  let releaseBHeld;
  const bHeld = new Promise((resolve) => { releaseBHeld = resolve; });
  const probeCounts = {};
  const invokeCounts = {};
  const launchByCall = new Map();

  const recordEvent = (event, fields = {}) => {
    const record = { sequence: ++eventSequence, event, ...fields };
    appendFileSync(eventPath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  };
  const provider = {
    async isAvailable(profile) {
      const profileModel = String(profile.model ?? "unknown");
      probeCounts[profileModel] = (probeCounts[profileModel] ?? 0) + 1;
      recordEvent("provider_probe", { profileModel });
      return true;
    },
    async invoke(invocation) {
      const nodeId = invocation.nodeId;
      const callId = invocation.call?.callId;
      invokeCounts[nodeId] = (invokeCounts[nodeId] ?? 0) + 1;
      if (invokeCounts[nodeId] !== 1) throw new Error(`Unexpected duplicate provider action for '${nodeId}'.`);
      if (nodeId !== "a" && nodeId !== "b") throw new Error(`Unexpected provider action for '${nodeId}'.`);
      const response = await runCapturedProcess(
        process.execPath,
        [fixturePath, "provider"],
        {
          cwd: projectRoot,
          stdin: JSON.stringify({ callId, nodeId, stateDirectory }),
          timeoutMs: 8_000,
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        },
        invocation,
        "invoke",
        null,
      );
      launchByCall.set(callId, response.started);
      if (!response.started || response.cancelled || response.timedOut || response.outputLimitExceeded || response.exitCode !== 0) {
        throw new Error(`P16B provider child '${nodeId}' did not complete successfully: ${response.stderr}`);
      }
      const processRecord = readProviderRecord(stateDirectory, nodeId);
      if (processRecord.callId !== callId || !pidExited(processRecord.pid)) {
        throw new Error(`P16B provider process '${nodeId}' lacks successful exit evidence.`);
      }
      const transportBytes = readFileSync(path.join(projectRoot, ".nodulus", "runs", invocation.runId, "calls", callId, "transport.json"));
      recordEvent("provider_process_captured", {
        nodeId,
        callId,
        pid: processRecord.pid,
        pidExited: true,
        started: response.started,
        exitCode: response.exitCode,
        timedOut: response.timedOut,
        cancelled: response.cancelled,
        outputLimitExceeded: response.outputLimitExceeded,
        rawResponse: response.stdout,
        transportSha256: createHash("sha256").update(transportBytes).digest("hex"),
      });

      if (nodeId === "b") {
        recordEvent("b_raw_delivery_held", { nodeId, callId, pid: processRecord.pid });
        releaseBHeld();
        await waitForGraphStop(invocation.signal, recordEvent, callId);
        recordEvent("b_raw_response_delivery", { nodeId, callId, rawResponse: response.stdout });
        return response.stdout;
      }

      await bHeld;
      if (invocation.signal?.aborted) throw new Error("A received graph stop before its own storage failure was induced.");
      const target = path.join(projectRoot, ".nodulus", "runs", invocation.runId, "nodes", "a", "artifacts", "report.json");
      mkdirSync(path.dirname(target), { recursive: true });
      mkdirSync(target);
      const blockerMarker = path.join(target, "owned-blocker.json");
      writeJsonAtomic(blockerMarker, { runId: invocation.runId, nodeId: "a", target });
      const targetIsDirectory = statSync(target).isDirectory();
      recordEvent("a_blocker_created", { nodeId, callId, target, blockerMarker, targetIsDirectory });
      recordEvent("a_raw_response_delivery", { nodeId, callId, rawResponse: response.stdout });
      return response.stdout;
    },
    telemetryForCall() { return null; },
    launchForCall(callId) { return launchByCall.get(callId) ?? null; },
  };

  const storage = {
    async readUtf8(...values) { return actual.readUtf8(...values); },
    async createRun(...values) {
      const result = await actual.createRun(...values);
      runId = values[1];
      recordCheckpointPublication(projectRoot, runId, recordEvent, "createRun");
      return result;
    },
    async readRunFile(...values) { return actual.readRunFile(...values); },
    async writeRunFiles(...values) {
      const [root, targetRunId, files] = values;
      try {
        await actual.writeRunFiles(...values);
      } catch (error) {
        if (Object.hasOwn(files, "nodes/a/artifacts/report.json")) {
          const target = path.join(projectRoot, ".nodulus", "runs", targetRunId, "nodes", "a", "artifacts", "report.json");
          let targetIsDirectory = false;
          try { targetIsDirectory = statSync(target).isDirectory(); } catch { /* retain the original OS failure */ }
          recordEvent("a_storage_write_failed", {
            runId: targetRunId,
            target,
            targetIsDirectory,
            errorName: error?.name,
            errorCode: error?.code,
            errorMessage: error?.message,
            errorSyscall: error?.syscall,
            errorPath: error?.path,
            errorDest: error?.dest,
          });
        }
        throw error;
      }
      if (root === projectRoot && Object.hasOwn(files, "run.json")) {
        recordCheckpointPublication(projectRoot, targetRunId, recordEvent, "writeRunFiles");
      }
    },
    async acquireRunLock(...values) { return actual.acquireRunLock(...values); },
  };

  const outcome = await runWorkflow({
    projectRoot,
    cwd: projectRoot,
    workflow: "example",
    sources: [{ kind: "inline", text: "Exercise concurrent storage poisoning." }],
  }, provider, { storage }).then(
    (result) => ({ kind: "result", result }),
    (error) => ({ kind: "rejection", error: { code: error?.code, message: error?.message } }),
  );
  recordEvent("workflow_settled", { runId, kind: outcome.kind, status: outcome.result?.status, result: outcome.result?.result, error: outcome.error });
  process.stdout.write(JSON.stringify({ runId, outcome, probeCounts, invokeCounts }));
}

function recordCheckpointPublication(projectRoot, runId, recordEvent, source) {
  const bytes = readFileSync(path.join(projectRoot, ".nodulus", "runs", runId, "run.json"));
  recordEvent("checkpoint_published", {
    runId,
    source,
    checkpointBytesBase64: bytes.toString("base64"),
    checkpointSha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function readProviderRecord(directory, nodeId) {
  const started = JSON.parse(readFileSync(path.join(directory, `started-${nodeId}.json`), "utf8"));
  const finished = JSON.parse(readFileSync(path.join(directory, `finished-${nodeId}.json`), "utf8"));
  if (!Number.isSafeInteger(started.pid) || started.pid <= 0 || started.nodeId !== nodeId ||
      finished.pid !== started.pid || finished.nodeId !== nodeId || finished.callId !== started.callId || finished.finished !== true) {
    throw new Error(`P16B provider PID/completion records for '${nodeId}' are invalid.`);
  }
  return { pid: started.pid, nodeId, callId: started.callId };
}

function pidExited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}

function waitForGraphStop(signal, recordEvent, callId) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      const reason = signal.reason;
      recordEvent("b_graph_stop_observed", {
        callId,
        reason: {
          source: reason?.source,
          kind: reason?.kind,
          code: reason?.code,
          message: reason?.message,
        },
      });
      if (reason?.source !== "nodulus.graph" || reason?.kind !== "graph_stop" || reason?.code !== "GRAPH_CANCELLED") {
        reject(new Error("B raw response was released without the expected graph-stop reason."));
      } else resolve();
    };
    if (!signal) return reject(new Error("B provider invocation has no AbortSignal."));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  renameSync(temporary, filePath);
}

function readStdinJson() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
  });
}

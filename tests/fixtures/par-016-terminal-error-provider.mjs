import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);
if (mode === "provider") await runProvider();
else if (mode === "run") await runScenario();
else throw new Error(`Unknown P16C fixture mode '${String(mode)}'.`);

async function runProvider() {
  const request = await readStdinJson();
  mkdirSync(request.stateDirectory, { recursive: true });
  writeJsonAtomic(path.join(request.stateDirectory, `started-${request.nodeId}.json`), {
    pid: process.pid,
    nodeId: request.nodeId,
    callId: request.callId,
  });
  writeFileSync(path.join(request.stateDirectory, `finished-${request.nodeId}.json`), JSON.stringify({
    pid: process.pid,
    nodeId: request.nodeId,
    callId: request.callId,
    finished: true,
  }), "utf8");
  process.stdout.write(JSON.stringify({
    status: "error",
    error: { code: "CONTROL_NODE_ERROR", message: "controlled terminal node failure" },
  }));
}

async function runScenario() {
  const [projectRoot, modeName, stateDirectory, readyPath, allowFailurePath, deadlineText] = args;
  const deadlineAt = Number(deadlineText);
  if (!projectRoot || !stateDirectory || !readyPath || !allowFailurePath || !Number.isFinite(deadlineAt) ||
      (modeName !== "events_blocker" && modeName !== "checkpoint_lock")) {
    throw new Error("P16C run fixture arguments are invalid.");
  }
  mkdirSync(stateDirectory, { recursive: true });
  const externalEventsPath = path.join(stateDirectory, "events.jsonl");
  const readyTemporary = `${readyPath}.${process.pid}.tmp`;
  const actual = new (await import("../../dist/adapters/storage/local-intake-storage.js")).LocalIntakeStorage();
  const { runWorkflow } = await import("../../dist/index.js");
  const { runCapturedProcess } = await import("../../dist/adapters/providers/captured-process.js");
  let sequence = 0;
  let runId;
  const failureAllowed = waitForAllowFile(allowFailurePath, deadlineAt);
  void failureAllowed.catch(() => undefined);
  const probeCounts = {};
  const invokeCounts = {};
  let repairCount = 0;
  const launchByCall = new Map();

  const record = (event, fields = {}) => {
    const entry = { sequence: ++sequence, event, ...fields };
    appendFileSync(externalEventsPath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  };
  const provider = {
    async isAvailable(profile) {
      const profileModel = String(profile.model ?? "unknown");
      probeCounts[profileModel] = (probeCounts[profileModel] ?? 0) + 1;
      record("provider_probe", { profileModel });
      return true;
    },
    async invoke(invocation) {
      const nodeId = invocation.nodeId;
      const callId = invocation.call?.callId;
      invokeCounts[nodeId] = (invokeCounts[nodeId] ?? 0) + 1;
      if (nodeId !== "root" || invokeCounts[nodeId] !== 1) throw new Error(`Unexpected provider invoke for '${nodeId}'.`);
      const response = await runCapturedProcess(
        process.execPath,
        [fixturePath, "provider"],
        { cwd: projectRoot, stdin: JSON.stringify({ callId, nodeId, stateDirectory }), timeoutMs: 8_000 },
        invocation,
        "invoke",
        null,
      );
      launchByCall.set(callId, response.started);
      if (!response.started || response.cancelled || response.timedOut || response.outputLimitExceeded || response.exitCode !== 0) {
        throw new Error(`P16C provider child '${nodeId}' did not exit successfully: ${response.stderr}`);
      }
      const processRecord = readJson(path.join(stateDirectory, `finished-${nodeId}.json`));
      if (processRecord.nodeId !== nodeId || processRecord.callId !== callId || processRecord.finished !== true || !pidExited(processRecord.pid)) {
        throw new Error(`P16C provider process '${nodeId}' lacks successful exit evidence.`);
      }
      const callDirectory = path.join(projectRoot, ".nodulus", "runs", invocation.runId, "calls", callId);
      const transportBytes = readFileSync(path.join(callDirectory, "transport.json"));
      record("provider_process_captured", {
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
      return response.stdout;
    },
    async repairResponse() {
      repairCount += 1;
      throw new Error("A valid terminal CONTROL_NODE_ERROR must not enter response repair.");
    },
    telemetryForCall() { return null; },
    launchForCall(callId) { return launchByCall.get(callId) ?? null; },
  };

  const storage = {
    async readUtf8(...values) { return actual.readUtf8(...values); },
    async createRun(...values) {
      const result = await actual.createRun(...values);
      runId = values[1];
      return result;
    },
    async readRunFile(...values) { return actual.readRunFile(...values); },
    async acquireRunLock(...values) { return actual.acquireRunLock(...values); },
    async writeRunFiles(...values) {
      const [root, targetRunId, files] = values;
      const checkpointCandidate = typeof files["run.json"] === "string";
      const eventCandidate = typeof files["events.jsonl"] === "string";
      const candidateEvents = eventCandidate ? parseEvents(files["events.jsonl"]) : [];
      const failedEvent = candidateEvents.find((entry) => entry.event === "node.failed" && entry.nodeId === "root");
      if (root === projectRoot && targetRunId === runId && checkpointCandidate && eventCandidate && failedEvent) {
        const runDirectory = path.join(projectRoot, ".nodulus", "runs", targetRunId);
        const checkpointPath = path.join(runDirectory, "run.json");
        const eventsPath = path.join(runDirectory, "events.jsonl");
        const resultPath = path.join(runDirectory, "nodes", "root", "attempt-001", "result.json");
        const validationPath = path.join(runDirectory, "nodes", "root", "attempt-001", "validation.json");
        const resultText = readFileSync(resultPath, "utf8");
        const validationText = readFileSync(validationPath, "utf8");
        const checkpointBytes = readFileSync(checkpointPath);
        const eventsBytes = readFileSync(eventsPath);
        const backupPath = path.join(runDirectory, "p16c-events-before-failure.jsonl");
        const blockerPath = path.join(runDirectory, "events.jsonl", "owned-blocker.json");
        const ready = {
          runId: targetRunId,
          mode: modeName,
          checkpointBase64: checkpointBytes.toString("base64"),
          checkpointSha256: createHash("sha256").update(checkpointBytes).digest("hex"),
          eventsBase64: eventsBytes.toString("base64"),
          eventsSha256: createHash("sha256").update(eventsBytes).digest("hex"),
          resultText,
          validationText,
          failedEvent,
          checkpointPath,
          eventsPath,
          backupPath,
          blockerPath,
        };
        writeFileSync(readyTemporary, `${JSON.stringify(ready)}\n`, "utf8");
        renameSync(readyTemporary, readyPath);
        record("terminal_evidence_ready", {
          runId: targetRunId,
          checkpointSha256: ready.checkpointSha256,
          eventsSha256: ready.eventsSha256,
          resultPath,
          validationPath,
          failedEvent,
        });
        await failureAllowed;

        if (modeName === "events_blocker") {
          renameSync(eventsPath, backupPath);
          mkdirSync(eventsPath);
          writeFileSync(blockerPath, `${JSON.stringify({ runId: targetRunId, target: eventsPath })}\n`, "utf8");
          record("events_target_blocked", { target: eventsPath, backupPath, targetIsDirectory: statSync(eventsPath).isDirectory() });
        }
      }

      try {
        await actual.writeRunFiles(...values);
      } catch (error) {
        if (root === projectRoot && targetRunId === runId && failedEvent) {
          const target = modeName === "checkpoint_lock" ? path.join(projectRoot, ".nodulus", "runs", targetRunId, "run.json") : path.join(projectRoot, ".nodulus", "runs", targetRunId, "events.jsonl");
          record("node_failed_storage_error", {
            runId: targetRunId,
            target,
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
    },
  };

  const outcome = await runWorkflow({
    projectRoot,
    cwd: projectRoot,
    workflow: "example",
    sources: [{ kind: "inline", text: "Exercise terminal graph failure publication." }],
  }, provider, { storage }).then(
    (result) => ({ kind: "result", result }),
    (error) => ({ kind: "rejection", error: { code: error?.code, message: error?.message } }),
  );
  record("workflow_settled", { runId, kind: outcome.kind, status: outcome.result?.status, error: outcome.result?.result?.error, rejection: outcome.error });
  process.stdout.write(JSON.stringify({ runId, outcome, probeCounts, invokeCounts, repairCount }));

  function waitForAllowFile(file, deadline) {
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (existsSync(file)) return resolve();
        if (Date.now() >= deadline) return reject(new Error("P16C failure gate exceeded its fixture deadline."));
        setTimeout(poll, 20);
      };
      poll();
    });
  }
}

function parseEvents(contents) {
  return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }

function pidExited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, "utf8");
  renameSync(temp, file);
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

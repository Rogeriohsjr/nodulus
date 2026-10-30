import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);
if (mode === "provider") await runProvider();
else if (mode === "run") await runScenario();
else throw new Error("Unknown P16D fixture mode.");

async function runProvider() {
  const request = await readStdinJson();
  mkdirSync(request.stateDirectory, { recursive: true });
  writeJsonAtomic(path.join(request.stateDirectory, `started-${request.nodeId}.json`), {
    pid: process.pid, nodeId: request.nodeId, callId: request.callId, runId: request.runId,
  });
  if (request.holdResponse) await waitForFile(request.releasePath, request.deadline, `release for ${request.nodeId}`);
  const response = JSON.stringify({
    status: "success",
    artifacts: [{ name: "report", contract: "report.v1", data: { text: `policy:${request.nodeId}` } }],
  });
  writeJsonAtomic(path.join(request.stateDirectory, `finished-${request.nodeId}.json`), {
    pid: process.pid, nodeId: request.nodeId, callId: request.callId, runId: request.runId, finished: true, response,
  });
  process.stdout.write(response);
}

async function runScenario() {
  const [projectRoot, stateDirectory, modeName, deadlineText] = args;
  if (!projectRoot || !stateDirectory || (modeName !== "dependent" && modeName !== "current") || !deadlineText) {
    throw new Error("P16D fixture arguments are invalid.");
  }
  const deadline = Number(deadlineText);
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error("P16D absolute scenario deadline is invalid or expired.");
  mkdirSync(stateDirectory, { recursive: true });
  const eventPath = path.join(stateDirectory, "events.jsonl");
  const actual = new (await import("../../dist/adapters/storage/local-intake-storage.js")).LocalIntakeStorage();
  const { runWorkflow } = await import("../../dist/index.js");
  const { runCapturedProcess } = await import("../../dist/adapters/providers/captured-process.js");
  let sequence = 0;
  const probes = {};
  const invocations = {};
  const repairs = {};
  const launchByCall = new Map();
  let runId;
  let outcome;

  const record = (event, fields = {}) => {
    const value = { sequence: ++sequence, event, ...fields };
    appendFileSync(eventPath, `${JSON.stringify(value)}\n`, "utf8");
    return value;
  };
  const provider = {
    async isAvailable(profile) {
      const model = String(profile.model ?? "unknown");
      probes[model] = (probes[model] ?? 0) + 1;
      record("provider_probe", { model });
      return true;
    },
    async invoke(invocation) {
      const nodeId = invocation.nodeId;
      const callId = invocation.call?.callId;
      if (typeof callId !== "string") throw new Error("P16D provider invocation omitted its call ID.");
      invocations[nodeId] = (invocations[nodeId] ?? 0) + 1;
      if (invocations[nodeId] !== 1) throw new Error(`Unexpected P16D replay for '${nodeId}'.`);
      const holdResponse = (modeName === "dependent" && nodeId === "a") || (modeName === "current" && nodeId === "held");
      const releasePath = path.join(stateDirectory, `release-${nodeId}.json`);
      const captured = await runCapturedProcess(
        process.execPath,
        [fixturePath, "provider"],
        {
          cwd: projectRoot,
          stdin: JSON.stringify({ nodeId, callId, runId: invocation.runId, stateDirectory, holdResponse, releasePath, deadline }),
          timeoutMs: 8_000,
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        },
        invocation,
        "invoke",
        null,
      );
      launchByCall.set(callId, captured.started);
      if (!captured.started || captured.exitCode !== 0 || captured.cancelled || captured.timedOut || captured.outputLimitExceeded) {
        throw new Error(`P16D provider child '${nodeId}' did not complete successfully: ${captured.stderr}`);
      }
      const started = readJson(path.join(stateDirectory, `started-${nodeId}.json`));
      const finished = readJson(path.join(stateDirectory, `finished-${nodeId}.json`));
      if (started.callId !== callId || started.runId !== invocation.runId || finished.callId !== callId || finished.pid !== started.pid || !finished.finished || !pidExited(started.pid)) {
        throw new Error(`P16D provider process '${nodeId}' lacks real exit evidence.`);
      }
      const transport = readFileSync(path.join(projectRoot, ".nodulus", "runs", invocation.runId, "calls", callId, "transport.json"));
      record("provider_process_captured", {
        nodeId, callId, pid: started.pid, pidExited: true, started: captured.started,
        exitCode: captured.exitCode, timedOut: captured.timedOut, cancelled: captured.cancelled,
        outputLimitExceeded: captured.outputLimitExceeded, rawResponse: captured.stdout,
        transportSha256: hash(transport),
      });
      return captured.stdout;
    },
    async repairResponse(invocation, previousRaw) {
      const nodeId = invocation.nodeId;
      repairs[nodeId] = (repairs[nodeId] ?? 0) + 1;
      record("provider_repair_started", { nodeId, callId: invocation.call?.callId, attempt: invocation.call?.attempt });
      return previousRaw;
    },
    telemetryForCall() { return null; },
    launchForCall(callId) { return launchByCall.get(callId) ?? null; },
  };
  const storage = {
    async readUtf8(...values) { return actual.readUtf8(...values); },
    async createRun(...values) { const result = await actual.createRun(...values); runId = values[1]; return result; },
    async readRunFile(...values) { return actual.readRunFile(...values); },
    async writeRunFiles(...values) { return actual.writeRunFiles(...values); },
    async acquireRunLock(...values) { return actual.acquireRunLock(...values); },
  };

  const publicRun = runWorkflow({
    projectRoot,
    cwd: projectRoot,
    workflow: "example",
    sources: [{ kind: "inline", text: "Exercise captured workspace validator policy before provider action." }],
  }, provider, { storage });
  outcome = await withTimeout(publicRun, remaining(deadline), "public P16D workflow").then(
    (result) => ({ kind: "result", result }),
    (error) => ({ kind: "rejection", error: serializeError(error) }),
  );
  record("workflow_settled", { runId, kind: outcome.kind, status: outcome.result?.status, result: outcome.result?.result, error: outcome.error });
  const finalTransports = [];
  for (const event of readEvents(eventPath).filter((entry) => entry.event === "provider_process_captured")) {
    const bytes = readFileSync(path.join(projectRoot, ".nodulus", "runs", runId, "calls", event.callId, "transport.json"));
    finalTransports.push({ callId: event.callId, baselineSha256: event.transportSha256, finalSha256: hash(bytes), bytesBase64: bytes.toString("base64") });
  }
  record("final_transport_hashes", { captures: finalTransports });
  process.stdout.write(JSON.stringify({ runId, outcome, probes, invocations, repairs }));
}

async function waitForFile(file, deadline, label) {
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`P16D fixture timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function readEvents(file) { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function pidExited(pid) { try { process.kill(pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; } }
function remaining(deadline) { return Math.max(0, deadline - Date.now()); }
function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error(`P16D deadline expired before ${label}.`));
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`P16D timed out waiting for ${label}.`)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
function serializeError(error) { return { name: error?.name, code: error?.code, message: error?.message }; }
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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);

if (mode === "provider") {
  await runProvider();
} else if (mode === "run") {
  await runCrashScenario();
} else if (mode === "inspect") {
  await inspectAfterCrash();
} else {
  throw new Error(`Unknown PAR-016 fixture mode '${String(mode)}'.`);
}

async function runProvider() {
  const request = await readStdinJson();
  const stateDirectory = request.stateDirectory;
  const nodeId = request.nodeId;
  mkdirSync(stateDirectory, { recursive: true });
  writeJsonAtomic(path.join(stateDirectory, `started-${nodeId}.json`), {
    pid: process.pid,
    nodeId,
    callId: request.callId,
  });
  writeJsonAtomic(path.join(stateDirectory, `finished-${nodeId}.json`), {
    pid: process.pid,
    nodeId,
    callId: request.callId,
    finished: true,
  });
  process.stdout.write(JSON.stringify({
    status: "success",
    artifacts: [{ name: "report", contract: "report.v1", data: { text: `done:${nodeId}` } }],
  }));
}

async function runCrashScenario() {
  const [projectRoot, milestone, markerPath, providerState] = args;
  if (!projectRoot || !markerPath || !providerState || (milestone !== "before_acceptance" && milestone !== "after_acceptance")) {
    throw new Error("PAR-016 run fixture arguments are invalid.");
  }

  const [{ runWorkflow }, { LocalIntakeStorage }, { runCapturedProcess }] = await Promise.all([
    import("../../dist/index.js"),
    import("../../dist/adapters/storage/local-intake-storage.js"),
    import("../../dist/adapters/providers/captured-process.js"),
  ]);
  const actual = new LocalIntakeStorage();
  const invocationCounts = new Map();
  const launchByCall = new Map();
  const provider = {
    async isAvailable() { return true; },
    async invoke(invocation) {
      const nodeId = invocation.nodeId;
      invocationCounts.set(nodeId, (invocationCounts.get(nodeId) ?? 0) + 1);
      const callId = invocation.call?.callId;
      const response = await runCapturedProcess(
        process.execPath,
        [fixturePath, "provider"],
        {
          cwd: projectRoot,
          stdin: JSON.stringify({
            callId,
            nodeId,
            inputs: invocation.inputs,
            stateDirectory: providerState,
          }),
          timeoutMs: 8_000,
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        },
        invocation,
        "invoke",
        null,
      );
      launchByCall.set(callId, response.started);
      if (!response.started || response.cancelled || response.timedOut || response.outputLimitExceeded || response.exitCode !== 0) {
        throw new Error(`PAR-016 provider child for '${nodeId}' failed: ${response.stderr}`);
      }
      return response.stdout;
    },
    telemetryForCall() { return null; },
    launchForCall(callId) { return launchByCall.get(callId) ?? null; },
  };
  const storage = {
    readUtf8: (...values) => actual.readUtf8(...values),
    createRun: (...values) => actual.createRun(...values),
    readRunFile: (...values) => actual.readRunFile(...values),
    async writeRunFiles(...values) {
      await actual.writeRunFiles(...values);
      const [root, runId, files] = values;
      if (root !== projectRoot) return;

      if (milestone === "before_acceptance" &&
          Object.hasOwn(files, "nodes/root/attempt-001/result.json") &&
          Object.hasOwn(files, "nodes/root/attempt-001/validation.json") &&
          Object.hasOwn(files, "nodes/root/artifacts/report.json")) {
        const checkpoint = JSON.parse(await actual.readRunFile(projectRoot, runId, "run.json"));
        const result = JSON.parse(await actual.readRunFile(projectRoot, runId, "nodes/root/attempt-001/result.json"));
        const validation = JSON.parse(await actual.readRunFile(projectRoot, runId, "nodes/root/attempt-001/validation.json"));
        const artifact = JSON.parse(await actual.readRunFile(projectRoot, runId, "nodes/root/artifacts/report.json"));
        if (checkpoint.graph?.nodes?.root?.phase !== "active" || checkpoint.graph.nodes.root.accepted !== undefined ||
            result.status !== "success" || validation.valid !== true || artifact.data?.text !== "done:root") {
          throw new Error("PAR-016 before-acceptance evidence did not match the intended active checkpoint boundary.");
        }
        writeMilestone(markerPath, { runId, milestone, workerPid: process.pid, providerPid: providerPid(providerState, "root") });
        process.exit(0);
      }

      if (milestone === "after_acceptance" && Object.hasOwn(files, "run.json") && Object.hasOwn(files, "events.jsonl")) {
        const checkpoint = JSON.parse(await actual.readRunFile(projectRoot, runId, "run.json"));
        const accepted = checkpoint.graph?.nodes?.root?.accepted;
        if (checkpoint.graph?.nodes?.root?.phase !== "accepted" || accepted?.callId === undefined) return;
        writeMilestone(markerPath, { runId, milestone, workerPid: process.pid, providerPid: providerPid(providerState, "root") });
        process.exit(0);
      }
    },
    async acquireRunLock(...values) { return actual.acquireRunLock(...values); },
  };

  const outcome = await runWorkflow({
    projectRoot,
    cwd: projectRoot,
    workflow: "example",
    sources: [{ kind: "inline", text: "Crash at the selected graph checkpoint boundary." }],
  }, provider, { storage });
  process.stdout.write(JSON.stringify({ outcome, invocationCounts: Object.fromEntries(invocationCounts) }));
}

async function inspectAfterCrash() {
  const [projectRoot, runId] = args;
  if (!projectRoot || !runId) throw new Error("PAR-016 inspect fixture arguments are invalid.");
  const { getRunStatus, resumeWorkflow } = await import("../../dist/index.js");
  const counts = { readiness: 0, invoke: 0 };
  const provider = {
    async isAvailable() { counts.readiness += 1; return true; },
    async invoke() { counts.invoke += 1; return "unexpected replay"; },
  };
  const status = await getRunStatus(projectRoot, runId);
  let resumeError;
  try {
    await resumeWorkflow({
      projectRoot,
      runId,
      requestId: "00000000-0000-4000-8000-000000000000",
      answers: {},
    }, provider);
  } catch (error) {
    resumeError = { code: error?.code, message: error?.message };
  }
  process.stdout.write(JSON.stringify({
    status: status.status,
    checkpoint: status.checkpoint,
    resumeError,
    providerProbeCount: counts.readiness,
    providerInvokeCount: counts.invoke,
  }));
}

function writeMilestone(markerPath, value) {
  const temporary = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  renameSync(temporary, markerPath);
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  renameSync(temporary, filePath);
}

function providerPid(directory, nodeId) {
  const record = JSON.parse(readFileSync(path.join(directory, `finished-${nodeId}.json`), "utf8"));
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || record.nodeId !== nodeId || record.finished !== true) {
    throw new Error(`PAR-016 provider completion record for '${nodeId}' is invalid.`);
  }
  try {
    process.kill(record.pid, 0);
    throw new Error(`PAR-016 provider child ${record.pid} was still alive at the durable evidence boundary.`);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return record.pid;
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

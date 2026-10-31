import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const ownerWatchdogMs = 60_000;
const args = process.argv.slice(2);

function writeAtomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, file);
}

function fixedError(error) {
  const value = error && typeof error === "object" ? error : {};
  return {
    name: typeof value.name === "string" ? value.name.slice(0, 100) : "Error",
    code: typeof value.code === "string" ? value.code.slice(0, 100) : null,
    message: typeof value.message === "string" ? value.message.slice(0, 500) : "Operation failed.",
  };
}

async function runOwner() {
  const [, projectRoot, runId, controlDirectory, nonce] = args;
  if (!projectRoot || !runId || !controlDirectory || !nonce) throw new Error("PAR-034 owner arguments are incomplete.");
  const { LocalIntakeStorage } = await import("../../dist/adapters/storage/local-intake-storage.js");
  const storage = new LocalIntakeStorage();
  const lock = await storage.acquireRunLock(projectRoot, runId);
  const lockPath = path.join(projectRoot, ".nodulus", "runs", runId, ".resume.lock");
  const lockRecord = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lockRecord.pid !== process.pid || typeof lockRecord.token !== "string" || lockRecord.token.length === 0) {
    throw new Error("PAR-034 actual storage lock did not match its owner process and token.");
  }

  const readyPath = path.join(controlDirectory, "owner-ready.json");
  const releasePath = path.join(controlDirectory, "owner-release.json");
  writeAtomicJson(readyPath, { pid: process.pid, runId, nonce, lockPid: lockRecord.pid, token: lockRecord.token });
  const deadline = Date.now() + ownerWatchdogMs;
  while (Date.now() < deadline) {
    try {
      const release = JSON.parse(readFileSync(releasePath, "utf8"));
      if (release.nonce !== nonce || release.pid !== process.pid) throw new Error("PAR-034 owner release identity mismatch.");
      await lock.release();
      process.stdout.write(JSON.stringify({ kind: "released", pid: process.pid, runId, nonce }) + "\n");
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("PAR-034 owner fixture watchdog expired.");
}

async function runResume() {
  const [, projectRoot, runId, requestId, answerText, nonce] = args;
  if (!projectRoot || !runId || !requestId || !answerText || !nonce) throw new Error("PAR-034 resume arguments are incomplete.");
  const answers = JSON.parse(answerText);
  const [{ resumeWorkflow }, { createDefaultProviderPort }] = await Promise.all([
    import("../../dist/index.js"),
    import("../../dist/adapters/providers/default-provider-port.js"),
  ]);
  const delegate = createDefaultProviderPort(projectRoot);
  const activity = { availability: 0, invoke: 0, repairResponse: 0, telemetry: 0, launch: 0, legacyUsage: 0 };
  const delegated = [];
  const track = (operation) => {
    if (operation && (typeof operation === "object" || typeof operation === "function") && typeof operation.then === "function") {
      delegated.push(Promise.resolve(operation).then(() => undefined, () => undefined));
    }
    return operation;
  };
  const provider = {
    ...(delegate.isAvailable ? { isAvailable(...callArgs) { activity.availability += 1; return track(delegate.isAvailable(...callArgs)); } } : {}),
    invoke(...callArgs) { activity.invoke += 1; return track(delegate.invoke(...callArgs)); },
    ...(delegate.repairResponse ? { repairResponse(...callArgs) { activity.repairResponse += 1; return track(delegate.repairResponse(...callArgs)); } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall(...callArgs) { activity.telemetry += 1; return track(delegate.telemetryForCall(...callArgs)); } } : {}),
    ...(delegate.launchForCall ? { launchForCall(...callArgs) { activity.launch += 1; return track(delegate.launchForCall(...callArgs)); } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall(...callArgs) { activity.legacyUsage += 1; return track(delegate.usageForLastCall(...callArgs)); } } : {}),
  };

  let envelope;
  try {
    const result = await resumeWorkflow({ projectRoot, runId, requestId, answers }, provider);
    envelope = { kind: "result", nonce, result };
  } catch (error) {
    envelope = { kind: "error", nonce, error: fixedError(error) };
  }
  await Promise.all(delegated);
  process.stdout.write(JSON.stringify({ ...envelope, activity, settled: { public: true, delegated: true } }) + "\n");
}

try {
  if (args[0] === "owner") await runOwner();
  else if (args[0] === "resume") await runResume();
  else throw new Error("PAR-034 fixture role is invalid.");
} catch (error) {
  process.stderr.write(`${JSON.stringify(fixedError(error))}\n`);
  process.exitCode = 74;
}

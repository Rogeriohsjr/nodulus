import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [controlPath, eventPath, role, ...args] = process.argv.slice(2);
if (!controlPath || !eventPath || !role) throw new Error("P15C2 fixture requires control, events, and a role.");
const control = JSON.parse(readFileSync(controlPath, "utf8"));
const fixturePath = fileURLToPath(import.meta.url);
const record = (stage, extra = {}) => appendFileSync(eventPath, `${JSON.stringify({ stage, atMs: Date.now(), pid: process.pid, role, ...extra })}\n`, "utf8");
const atomicJson = (target, value) => {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, target);
};
const waitForFile = async (target, label) => {
  const deadline = Date.now() + control.fixtureLifetimeMs;
  while (!existsSync(target)) {
    if (Date.now() >= deadline) throw new Error(`P15C2 fixture lifetime expired waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

if (role === "__descendant") {
  record("descendant-started");
  atomicJson(control.descendantStartedPath, { pid: process.pid });
  await waitForFile(control.descendantReleasePath, "owned descendant release");
  record("descendant-exited");
  process.exit(0);
}

if (role === "__intermediate") {
  record("intermediate-started");
  const child = spawn(process.execPath, [fixturePath, controlPath, eventPath, "__descendant"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "ignore",
    detached: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("P15C2 intermediate did not expose the orphan PID.");
  atomicJson(control.intermediateChildPath, { pid: process.pid, descendantPid: child.pid });
  record("intermediate-spawned-descendant", { descendantPid: child.pid });
  child.unref();
  process.exit(0);
}

if (role === "codex-readiness" || role === "codex-stopper") {
  if (args[0] === "--version") {
    record("version");
    process.stdout.write("codex-cli 0.156.1\n");
    process.exit(0);
  }
  if (args[0] === "login" && args[1] === "status") {
    record("readiness");
    if (role === "codex-readiness") {
      const intermediate = spawn(process.execPath, [fixturePath, controlPath, eventPath, "__intermediate"], {
        cwd: process.cwd(), windowsHide: true, stdio: "ignore",
      });
      await new Promise((resolve, reject) => {
        intermediate.once("close", (code) => code === 0 ? resolve() : reject(new Error(`P15C2 intermediate exited ${String(code)}.`)));
        intermediate.once("error", reject);
      });
      const child = JSON.parse(readFileSync(control.intermediateChildPath, "utf8"));
      atomicJson(control.heldRootStartedPath, { pid: process.pid, intermediatePid: child.pid, descendantPid: child.descendantPid });
      record("readiness-root-ready", { intermediatePid: child.pid, descendantPid: child.descendantPid });
      await waitForFile(control.heldRootReleasePath, "readiness root release");
    }
    process.stdout.write("Logged in\n");
    process.exit(0);
  }
  if (args[0] !== "exec") {
    record("unexpected-command", { args });
    process.stderr.write("Unexpected P15C2 Codex command.");
    process.exit(64);
  }
  record("inference-started");
  if (role === "codex-stopper") await waitForFile(control.stopperReleasePath, "separate graph failure release");
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("P15C2 Codex fixture did not receive an output path.");
  const outputPath = path.resolve(process.cwd(), args[outputIndex + 1]);
  const terminal = { status: "error", error: { code: "P15C2_TRIGGER", message: "Independent sibling requested graph stop." } };
  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(terminal) }), "utf8");
  record("stopper-inference-completed");
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  process.exit(0);
}

if (role === "opencode") {
  if (args[0] === "--version") {
    record("version");
    process.stdout.write("opencode 1.18.32\n");
    process.exit(0);
  }
  if (args[0] === "models" && args[1] === "ollama") {
    record("models");
    process.stdout.write("ollama/p15c2-fixture-model\n");
    process.exit(0);
  }
  if (args[0] !== "run") {
    record("unexpected-command", { args });
    process.stderr.write("Unexpected P15C2 OpenCode command.");
    process.exit(64);
  }
  const agentIndex = args.indexOf("--agent");
  const agent = agentIndex < 0 ? "" : args[agentIndex + 1];
  const sessionIndex = args.indexOf("--session");
  const session = sessionIndex < 0 ? undefined : args[sessionIndex + 1];
  if (agent === "build") {
    const messageID = "p15c2-build-final";
    const malformed = JSON.stringify({ status: "success", artifacts: [] });
    process.stdout.write(`${JSON.stringify({ type: "text", part: { messageID, sessionID: "p15c2-session", text: malformed } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "step_finish", part: { messageID, sessionID: "p15c2-session", reason: "stop" } })}\n`);
    record("build-completed", { agent, session: "p15c2-session" });
    process.exit(0);
  }
  if (agent === "nodulus-response") {
    if (session !== "p15c2-session") throw new Error(`P15C2 repair session mismatch: ${String(session)}.`);
    const intermediate = spawn(process.execPath, [fixturePath, controlPath, eventPath, "__intermediate"], {
      cwd: process.cwd(), windowsHide: true, stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      intermediate.once("close", (code) => code === 0 ? resolve() : reject(new Error(`P15C2 intermediate exited ${String(code)}.`)));
      intermediate.once("error", reject);
    });
    const child = JSON.parse(readFileSync(control.intermediateChildPath, "utf8"));
    atomicJson(control.heldRootStartedPath, { pid: process.pid, intermediatePid: child.pid, descendantPid: child.descendantPid, session, agent });
    record("repair-root-ready", { intermediatePid: child.pid, descendantPid: child.descendantPid, session, agent });
    await waitForFile(control.heldRootReleasePath, "repair root release");
    record("repair-root-released", { session, agent });
    const repaired = JSON.stringify({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "late repaired response" } }] });
    process.stdout.write(`${JSON.stringify({ type: "text", part: { messageID: "p15c2-repair-final", sessionID: session, text: repaired } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "step_finish", part: { messageID: "p15c2-repair-final", sessionID: session, reason: "stop" } })}\n`);
    process.exit(0);
  }
  record("unexpected-agent", { agent, args });
  process.stderr.write(`Unexpected P15C2 OpenCode agent '${agent}'.`);
  process.exit(65);
}

record("unexpected-role", { args });
process.stderr.write(`Unexpected P15C2 CLI role '${role}'.`);
process.exit(66);

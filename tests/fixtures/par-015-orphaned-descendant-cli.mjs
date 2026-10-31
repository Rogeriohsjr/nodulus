import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [controlPath, eventPath, roleOrMode, ...args] = process.argv.slice(2);
if (!controlPath || !eventPath || !roleOrMode) throw new Error("P15C1 CLI fixture requires control, events, and role/mode arguments.");
const control = JSON.parse(readFileSync(controlPath, "utf8"));
const fixturePath = fileURLToPath(import.meta.url);
const record = (stage, extra = {}) => appendFileSync(eventPath, `${JSON.stringify({ stage, atMs: Date.now(), pid: process.pid, role: roleOrMode, ...extra })}\n`, "utf8");
const atomicJson = (target, value) => {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, target);
};
const waitForFile = async (target, label) => {
  const deadline = Date.now() + control.fixtureLifetimeMs;
  while (!existsSync(target)) {
    if (Date.now() >= deadline) throw new Error(`P15C1 fixture lifetime expired waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

if (roleOrMode === "__descendant") {
  record("descendant-started");
  atomicJson(control.descendantStartedPath, { pid: process.pid });
  await waitForFile(control.descendantReleasePath, "owned descendant release");
  record("descendant-exited");
  process.exit(0);
}

if (roleOrMode === "__intermediate") {
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
  if (!child.pid) throw new Error("P15C1 intermediate process did not expose the descendant PID.");
  atomicJson(control.intermediateChildPath, { pid: process.pid, descendantPid: child.pid });
  record("intermediate-spawned-descendant", { descendantPid: child.pid });
  child.unref();
  process.exit(0);
}

if (args[0] === "--version") {
  record("version");
  process.stdout.write("codex-cli 0.156.1\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  record("readiness");
  process.stdout.write("Logged in\n");
  process.exit(0);
}
if (args[0] !== "exec") {
  record("unexpected-command", { args });
  process.stderr.write("Unexpected P15C1 Codex fixture command.");
  process.exit(64);
}

const outputIndex = args.indexOf("--output-last-message");
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("P15C1 fixture did not receive an output path.");
const outputPath = path.resolve(process.cwd(), args[outputIndex + 1]);

if (roleOrMode === "held") {
  record("held-inference-started");
  const intermediate = spawn(process.execPath, [fixturePath, controlPath, eventPath, "__intermediate"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    intermediate.once("close", (code) => code === 0 ? resolve() : reject(new Error(`P15C1 intermediate exited ${String(code)}.`)));
    intermediate.once("error", reject);
  });
  const intermediateChild = JSON.parse(readFileSync(control.intermediateChildPath, "utf8"));
  atomicJson(control.heldRootStartedPath, { pid: process.pid, intermediatePid: intermediateChild.pid, descendantPid: intermediateChild.descendantPid });
  record("held-root-ready", { intermediatePid: intermediateChild.pid, descendantPid: intermediateChild.descendantPid });
  await waitForFile(control.heldRootReleasePath, "held root release");
  const terminal = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "late held inference result" } }] };
  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(terminal) }), "utf8");
  record("held-inference-completed");
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  process.exit(0);
}

if (roleOrMode === "stopper") {
  record("stopper-inference-started");
  await waitForFile(control.stopperReleasePath, "separate failure trigger");
  const terminal = { status: "error", error: { code: "P15C1_TRIGGER", message: "Independent graph branch requested stop." } };
  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(terminal) }), "utf8");
  record("stopper-inference-completed");
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  process.exit(0);
}

record("unexpected-role", { args });
process.stderr.write(`Unexpected P15C1 provider role '${roleOrMode}'.`);
process.exit(65);

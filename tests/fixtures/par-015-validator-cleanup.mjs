import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const controlRelative = ".nodulus/fixtures/par-015-validator-control.json";
const eventsRelative = ".nodulus/fixtures/par-015-validator-events.jsonl";
const fixtureArgs = process.argv.slice(2);
const [firstArgument, secondArgument, thirdArgument, ...cliArgs] = fixtureArgs;
const role = thirdArgument === "codex-held" || thirdArgument === "codex-stopper" || thirdArgument === "__intermediate" || thirdArgument === "__descendant"
  ? thirdArgument
  : "validator";
const controlPath = role === "validator" ? path.resolve(process.cwd(), controlRelative) : firstArgument;
const eventPath = role === "validator" ? path.resolve(process.cwd(), eventsRelative) : secondArgument;
const args = role.startsWith("codex-") ? cliArgs : [];
if (!controlPath || !eventPath) throw new Error("P15C3 fixture requires its owned control and event paths.");
const control = JSON.parse(readFileSync(controlPath, "utf8"));
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
    if (Date.now() >= deadline) throw new Error(`P15C3 fixture lifetime expired waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

if (role === "__descendant") {
  record("descendant-started");
  atomicJson(control.descendantStartedPath, { pid: process.pid });
  await waitForFile(control.descendantReleasePath, "validator descendant release");
  record("descendant-exited");
  process.exit(0);
}

if (role === "__intermediate") {
  record("intermediate-started");
  const child = spawn(process.execPath, [fixturePath, controlPath, eventPath, "__descendant"], {
    cwd: process.cwd(), windowsHide: true, stdio: "ignore", detached: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("P15C3 intermediate did not expose its detached descendant PID.");
  atomicJson(control.intermediateChildPath, { pid: process.pid, descendantPid: child.pid });
  record("intermediate-spawned-descendant", { descendantPid: child.pid });
  child.unref();
  process.exit(0);
}

if (role === "codex-held" || role === "codex-stopper") {
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
    process.stderr.write("Unexpected P15C3 Codex command.");
    process.exit(64);
  }
  record("inference-started");
  if (role === "codex-stopper") await waitForFile(control.stopperReleasePath, "independent failure release");
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("P15C3 Codex fixture did not receive an output path.");
  const outputPath = path.resolve(process.cwd(), args[outputIndex + 1]);
  const terminal = role === "codex-held"
    ? { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "validated artifact" } }] }
    : { status: "error", error: { code: "P15C3_TRIGGER", message: "Independent sibling requested graph stop." } };
  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(terminal) }), "utf8");
  record("inference-completed", { role });
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  process.exit(0);
}

if (role === "validator") {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const artifact = JSON.parse(input);
  if (artifact.text !== "validated artifact") throw new Error("P15C3 validator did not receive the expected real artifact data.");
  record("validator-input-consumed", { text: artifact.text });
  const intermediate = spawn(process.execPath, [fixturePath, controlPath, eventPath, "__intermediate"], {
    cwd: process.cwd(), windowsHide: true, stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    intermediate.once("close", (code) => code === 0 ? resolve() : reject(new Error(`P15C3 intermediate exited ${typeof code === "number" ? code : "unknown"}.`)));
    intermediate.once("error", reject);
  });
  const child = JSON.parse(readFileSync(control.intermediateChildPath, "utf8"));
  atomicJson(control.validatorRootStartedPath, { pid: process.pid, intermediatePid: child.pid, descendantPid: child.descendantPid });
  record("validator-root-ready", { intermediatePid: child.pid, descendantPid: child.descendantPid });
  await waitForFile(control.validatorRootReleasePath, "validator root release");
  record("validator-released");
  process.stdout.write(JSON.stringify({ valid: true, errors: [] }));
  process.exit(0);
}

record("unexpected-role", { role, args });
process.stderr.write("Unexpected P15C3 fixture role.");
process.exit(65);

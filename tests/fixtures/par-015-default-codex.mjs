import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [controlPath, eventPath, ...args] = process.argv.slice(2);
if (!controlPath || !eventPath) throw new Error("P15 fixture requires control and event paths");
const control = JSON.parse(readFileSync(controlPath, "utf8"));
const resolve = (value) => path.resolve(process.cwd(), value);
const record = (stage, extra = {}) => {
  const target = resolve(eventPath);
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, JSON.stringify({ stage, role: control.role, atMs: Date.now(), pid: process.pid, ...extra }) + "\n", "utf8");
};
const writeMarker = (target, value) => {
  const absolute = resolve(target);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), "utf8");
  renameSync(temporary, absolute);
};
const waitForRelease = async (target) => {
  const deadline = Date.now() + 15_000;
  const absolute = resolve(target);
  while (!existsSync(absolute)) {
    if (Date.now() >= deadline) throw new Error("P15 fixture release watchdog expired");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
};

if (args[0] === "__descendant") {
  record("descendant-started");
  writeMarker(control.descendantStartedPath, { pid: process.pid });
  await waitForRelease(control.descendantReleasePath);
  record("descendant-completed");
} else if (args[0] === "--version") {
  record("version");
  process.stdout.write("codex-cli 0.156.1\n");
} else if (args[0] === "login" && args[1] === "status") {
  record("readiness-started");
  if (control.mode === "held-readiness") {
    writeMarker(control.readinessStartedPath, { pid: process.pid });
    await waitForRelease(control.readinessReleasePath);
  }
  record("readiness-completed");
  process.stdout.write("Logged in\n");
} else if (args[0] === "exec") {
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("P15 fixture did not receive an output path");
  const outputPath = args[outputIndex + 1];
  if (control.mode === "held-error") {
    record("prepare-inference-started");
    writeMarker(control.prepareStartedPath, { pid: process.pid });
    await waitForRelease(control.prepareReleasePath);
    const terminal = { status: "error", error: { code: control.errorCode, message: "P15 held prepare branch returned its control error." } };
    writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(terminal) }), "utf8");
    record("prepare-inference-completed");
    process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
  } else if (control.mode === "inference-tree") {
    const fixturePath = fileURLToPath(import.meta.url);
    const descendant = spawn(process.execPath, [fixturePath, controlPath, eventPath, "__descendant"], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolvePromise, reject) => {
      descendant.once("spawn", resolvePromise);
      descendant.once("error", reject);
    });
    record("inference-started", { descendantPid: descendant.pid });
    writeMarker(control.parentStartedPath, { pid: process.pid, descendantPid: descendant.pid });
    await waitForRelease(control.parentReleasePath);
    const terminal = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "left completed during fixture cleanup" } }] };
    writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(terminal) }), "utf8");
    record("inference-completed");
    process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
  } else if (control.mode === "held-readiness") {
    record("left-inference-started");
    writeMarker(control.inferenceStartedPath, { pid: process.pid });
    const terminal = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "left inference entered after readiness cleanup" } }] };
    writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(terminal) }), "utf8");
    record("left-inference-completed");
    process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
  } else {
    record("right-inference-started");
    const terminal = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "unexpected queued right node" } }] };
    writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(terminal) }), "utf8");
    process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
  }
} else {
  record("unexpected-command");
  process.stderr.write("Unexpected P15 Codex fixture command.");
  process.exitCode = 64;
}

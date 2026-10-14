import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [controlPath, eventsPath] = process.argv.slice(2);
if (!controlPath || !eventsPath) throw new Error("FB-080 fixture requires control and event paths");
const control = JSON.parse(readFileSync(controlPath, "utf8"));
mkdirSync(path.dirname(eventsPath), { recursive: true });
const record = (stage, extra = {}) => appendFileSync(eventsPath, JSON.stringify({ stage, atMs: Date.now(), pid: process.pid, ...extra }) + "\n", "utf8");
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const args = process.argv.slice(4);

if (args[0] === "--version") {
  record("version");
  process.stdout.write("codex-cli 0.156.1\n");
} else if (args[0] === "login" && args[1] === "status") {
  record("auth-started");
  if (control.authDelayMs) await wait(control.authDelayMs);
  record("auth-completed");
  process.stdout.write("Logged in\n");
} else if (args[0] === "exec") {
  record("inference-started");
  if (control.inferenceDelayMs) await wait(control.inferenceDelayMs);
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("FB-080 fixture did not receive an output path");
  const outcome = { status: "success", artifacts: [{ name: "prepared", contract: "prepared.v1", data: { text: "FB-080 local provider fixture" } }] };
  writeFileSync(args[outputIndex + 1], JSON.stringify({ response: JSON.stringify(outcome) }), "utf8");
  record("inference-completed");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
} else {
  record("unexpected", { args });
  process.stderr.write("Unexpected FB-080 fixture arguments: " + JSON.stringify(args));
  process.exitCode = 64;
}

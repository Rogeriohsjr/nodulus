import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const project = process.cwd();
const directory = path.join(project, ".nodulus", "fixtures");
const controlPath = path.join(directory, "fb-070-control.json");
const control = JSON.parse(readFileSync(controlPath, "utf8"));
const probeLog = path.join(directory, "fb-070-probes.jsonl");
const callLog = path.join(directory, "fb-070-invocations.jsonl");
const args = process.argv.slice(2);
const record = (file, value) => appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if (args[0] === "--version") {
  record(probeLog, { args });
  process.stdout.write("Claude Code 2.1.294\n");
} else if (args[0] === "auth" && args[1] === "status") {
  record(probeLog, { args, marker: "auth-started" });
  writeFileSync(path.join(directory, "fb-070-auth-started"), "started", "utf8");
  if (control.mode === "slow-auth") await wait(control.delayMs ?? 15_000);
  if (control.mode === "slow-auth") writeFileSync(path.join(directory, "fb-070-auth-completed"), "completed", "utf8");
  process.stdout.write(JSON.stringify({ loggedIn: true }));
} else if (args.includes("-p")) {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const callCount = existsSync(callLog) ? readFileSync(callLog, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
  record(callLog, { args, prompt });
  writeFileSync(path.join(directory, "fb-070-invocation-started"), String(callCount + 1), "utf8");
  if (control.mode === "slow-inference") await wait(control.delayMs ?? 15_000);
  if (control.mode === "slow-inference") writeFileSync(path.join(directory, "fb-070-invocation-completed"), "completed", "utf8");

  const raw = control.mode === "pause-first" && callCount === 0
    ? JSON.stringify({ status: "needs_input", request: { id: "fb-070-clarification", questions: [{ id: "detail", message: "Provide a detail." }], answerContract: { type: "object", properties: { detail: { type: "string" } }, required: ["detail"], additionalProperties: false } } })
    : JSON.stringify({ status: "success", artifacts: [{ name: "prepared", contract: "prepared.v1", data: { text: "prepared" } }] });
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { response: raw } }));
} else {
  process.stderr.write("Unexpected Claude fixture arguments: " + JSON.stringify(args));
  process.exitCode = 64;
}

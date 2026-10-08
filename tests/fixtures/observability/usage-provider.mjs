import { appendFileSync, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
const directory = path.join(process.cwd(), ".nodulus/fixtures");
const control = JSON.parse(readFileSync(path.join(directory, "usage-control.json"), "utf8"));
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
if (args[0] === "--version") { process.stdout.write(`${control.kind} ${control.version}`); process.exit(0); }
if (control.kind === "codex" && JSON.stringify(args) === JSON.stringify(["login", "status"])) { if (control.failAuthAfterInference && existsSync(path.join(directory, "provider-invocations.jsonl"))) process.exit(1); process.stdout.write("Logged in"); process.exit(0); }
if (control.kind === "cursor" && JSON.stringify(args) === JSON.stringify(["status", "--format", "json"])) { process.stdout.write(JSON.stringify({ isAuthenticated: true })); process.exit(0); }
if (control.kind === "opencode" && JSON.stringify(args) === JSON.stringify(["models", "ollama"])) { process.stdout.write("ollama/qwen3.5:9b\n"); process.exit(0); }
const expected = control.kind === "codex" ? "exec" : control.kind === "cursor" ? "-p" : "run";
if (args[0] !== expected) { process.stderr.write("Unexpected fixture arguments"); process.exit(64); }
const log = path.join(directory, "provider-invocations.jsonl");
if (existsSync(log)) { process.stderr.write("Unexpected second inference"); process.exit(65); }
if (control.blockTelemetryWrite) {
  const runs = path.join(process.cwd(), ".nodulus/runs");
  for (const run of readdirSync(runs)) {
    const calls = path.join(runs, run, "calls");
    if (existsSync(calls)) for (const call of readdirSync(calls)) mkdirSync(path.join(calls, call, "telemetry.json"));
  }
}
let stdin = ""; for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(log, JSON.stringify({ argv: args, stdin, cwd: process.cwd() }) + "\n");
if (control.kind === "codex") writeFileSync(flag("--output-last-message"), JSON.stringify({ response: control.outcome }));
if (control.kind === "cursor" && flag("--output-format") === "stream-json") {
  const terminal = JSON.parse(control.stdout);
  process.stdout.write(`${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: terminal.result }] } })}\n${JSON.stringify(terminal)}\n`);
} else process.stdout.write(control.stdout);

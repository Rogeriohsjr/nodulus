import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const role = process.argv[2];
const args = process.argv.slice(3);
const project = process.cwd();
const controlPath = path.join(project, ".nodulus", "fixtures", "par-030-control.json");
const control = JSON.parse(readFileSync(controlPath, "utf8"));

function record(stage, detail = {}) {
  appendFileSync(control.eventsPath, `${JSON.stringify({ stage, role, pid: process.pid, atMs: Date.now(), ...detail })}\n`, "utf8");
}

function writeMarker(target, value) {
  const absolute = path.resolve(project, target);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, absolute);
}

function requestForCall(callId) {
  const runsDirectory = path.join(project, ".nodulus", "runs");
  for (const entry of readdirSync(runsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const requestPath = path.join(runsDirectory, entry.name, "calls", callId, "request.json");
    if (!existsSync(requestPath)) continue;
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    if (request.callId === callId) return request;
  }
  throw new Error("P4A could not identify the captured call request.");
}

async function waitForRelease(target, label) {
  const deadline = Date.now() + control.fixtureLifetimeMs;
  const absolute = path.resolve(project, target);
  while (!existsSync(absolute)) {
    if (Date.now() >= deadline) throw new Error(`P4A fixture watchdog expired waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

if (args[0] === "--version") {
  record("version");
  process.stdout.write("codex-cli 0.156.1\n");
} else if (args[0] === "login" && args[1] === "status") {
  record("readiness");
  process.stdout.write("Logged in\n");
} else if (args[0] === "exec") {
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("P4A fixture did not receive an output path.");
  const outputPath = path.resolve(project, args[outputIndex + 1]);
  const callId = path.basename(path.dirname(outputPath));
  const request = requestForCall(callId);
  if (request.nodeId !== role) throw new Error(`P4A fixture profile '${role}' received call for node '${request.nodeId}'.`);
  const identity = { nodeId: request.nodeId, runId: request.runId, callId: request.callId, attempt: request.attempt };
  record("inference-started", identity);
  writeMarker(control.startedPaths[role], { ...identity, role, pid: process.pid });
  if (role === "a" || role === "b") await waitForRelease(control.releasePaths[role], `${role} release`);

  let outcome;
  if (role === "seed" || role === "queued") {
    outcome = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: `${role} report` } }] };
  } else if (role === "a" || (role === "b" && control.case === "two-questions")) {
    outcome = {
      status: "needs_input",
      request: {
        id: `provider-untrusted-${role}`,
        questions: [{ id: `question-${role}`, message: `Please supply the ${role} answer.` }],
        answerContract: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
      },
    };
  } else if (role === "b" && control.case === "terminal-error") {
    outcome = { status: "error", error: { code: "P4_BRANCH_FAILED", message: "The B branch returned its controlled terminal error." } };
  } else {
    throw new Error(`P4A fixture received an unexpected inference role or case: ${role}/${control.case}.`);
  }

  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(outcome) }), "utf8");
  record("inference-completed", identity);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
} else {
  record("unexpected-command");
  process.stderr.write("Unexpected P4A Codex command.");
  process.exitCode = 64;
}

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const role = process.argv[2];
const args = process.argv.slice(3);
const project = process.cwd();
const control = JSON.parse(readFileSync(path.join(project, ".nodulus", "fixtures", "par-035-control.json"), "utf8"));

function record(stage, detail = {}) {
  writeFileSync(control.eventsPath, `${JSON.stringify({ stage, role, pid: process.pid, atMs: Date.now(), ...detail })}\n`, { encoding: "utf8", flag: "a" });
}

function writeMarker(target, value) {
  const absolute = path.resolve(project, target);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, absolute);
}

function requestForCall(callId) {
  const runRoot = path.join(project, ".nodulus", "runs");
  for (const run of (awaitableEntries(runRoot))) {
    const requestPath = path.join(run, "calls", callId, "request.json");
    try {
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      if (request.callId === callId) return request;
    } catch { /* the call directory may not belong to this invocation */ }
  }
  throw new Error("PAR-035 fixture could not identify the captured call request.");
}

function awaitableEntries(directory) {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name));
}

function readPromptAnswers(prompt) {
  const header = "## Answers to clarification questions\n\n";
  const start = prompt.indexOf(header);
  if (start < 0) return {};
  const body = prompt.slice(start + header.length);
  const nextSection = body.search(/\n\n## /);
  const value = JSON.parse(nextSection < 0 ? body : body.slice(0, nextSection));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("PAR-035 fixture found a non-object answer section.");
  return value;
}

async function waitForRelease(target, label) {
  const deadline = Date.now() + control.fixtureLifetimeMs;
  const absolute = path.resolve(project, target);
  while (!existsSync(absolute)) {
    if (Date.now() >= deadline) throw new Error(`PAR-035 fixture watchdog expired waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readStdin() {
  return await new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(text));
  });
}

if (args[0] === "--version") {
  record("version");
  process.stdout.write("codex-cli 0.156.1\n");
} else if (args[0] === "login" && args[1] === "status") {
  record("readiness");
  process.stdout.write("Logged in\n");
} else if (args[0] === "exec") {
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("PAR-035 fixture did not receive an output path.");
  const outputPath = path.resolve(project, args[outputIndex + 1]);
  const callId = path.basename(path.dirname(outputPath));
  const request = requestForCall(callId);
  if (request.nodeId !== role) throw new Error(`PAR-035 profile '${role}' received node '${request.nodeId}'.`);
  const promptAnswers = readPromptAnswers(await readStdin());
  const identity = { nodeId: request.nodeId, runId: request.runId, callId: request.callId, attempt: request.attempt };
  const markerKey = `${role}-${request.attempt}`;
  record("inference-started", { ...identity, promptAnswers });
  writeMarker(control.startedPaths[markerKey], { ...identity, role, pid: process.pid, promptAnswers });
  await waitForRelease(control.releasePaths[markerKey], `${markerKey} release`);

  let outcome;
  if (role === "seed" && request.attempt === 1) {
    if (JSON.stringify(promptAnswers) !== "{}") throw new Error("PAR-035 seed received unexpected answers.");
    outcome = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "seed report" } }] };
  } else if (role === "a" && request.attempt === 1) {
    if (JSON.stringify(promptAnswers) !== "{}") throw new Error("PAR-035 A attempt 1 received unexpected answers.");
    outcome = question("first-request", "firstAnswer", "First approval", "first-approved");
  } else if (role === "a" && request.attempt === 2) {
    assertAnswers(promptAnswers, { firstAnswer: "first-approved" }, "A attempt 2");
    outcome = question("second-request", "secondAnswer", "Second approval", "second-approved");
  } else if (role === "a" && request.attempt === 3) {
    assertAnswers(promptAnswers, { firstAnswer: "first-approved", secondAnswer: "second-approved" }, "A attempt 3");
    outcome = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "both approvals accepted" } }] };
  } else {
    throw new Error(`PAR-035 fixture received unexpected inference identity ${role}/${request.attempt}.`);
  }

  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(outcome) }), "utf8");
  record("inference-completed", identity);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
} else {
  record("unexpected-command");
  process.stderr.write("Unexpected PAR-035 Codex command.");
  process.exitCode = 64;
}

function question(providerId, key, message, value) {
  return {
    status: "needs_input",
    request: {
      id: `provider-untrusted-${providerId}`,
      questions: [{ id: providerId, message }],
      answerContract: {
        type: "object",
        required: [key],
        properties: { [key]: { const: value, type: "string" } },
        additionalProperties: false,
      },
    },
  };
}

function assertAnswers(actual, expected, description) {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) throw new Error(`PAR-035 ${description} received non-object answers.`);
  const actualKeys = Object.keys(actual).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const expectedKeys = Object.keys(expected).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) || expectedKeys.some((key) => actual[key] !== expected[key])) {
    throw new Error(`PAR-035 ${description} received unexpected answers.`);
  }
}

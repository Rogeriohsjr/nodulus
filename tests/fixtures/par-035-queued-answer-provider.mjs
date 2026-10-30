import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const role = process.argv[2];
const args = process.argv.slice(3);
const project = process.cwd();
const control = JSON.parse(readFileSync(path.join(project, ".nodulus", "fixtures", "par-035-queued-control.json"), "utf8"));

function record(stage, detail = {}) {
  writeFileSync(control.eventsPath, `${JSON.stringify({ stage, role, pid: process.pid, atMs: Date.now(), ...detail })}\n`, { encoding: "utf8", flag: "a" });
}

function marker(target, value) {
  const absolute = path.resolve(project, target);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, absolute);
}

function findRequest(callId) {
  const runs = path.join(project, ".nodulus", "runs");
  for (const run of readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const requestPath = path.join(runs, run.name, "calls", callId, "request.json");
    try {
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      if (request.callId === callId) return request;
    } catch { /* Another run or call directory. */ }
  }
  throw new Error("PAR-035 fixture could not find its captured invocation.");
}

function promptAnswers(prompt) {
  const header = "## Answers to clarification questions\n\n";
  const offset = prompt.indexOf(header);
  if (offset < 0) return {};
  const body = prompt.slice(offset + header.length);
  const end = body.search(/\n\n## /);
  const parsed = JSON.parse(end < 0 ? body : body.slice(0, end));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("PAR-035 prompt answers are not an object.");
  return parsed;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

async function waitForRelease(key) {
  const target = path.resolve(project, control.releasePaths[key]);
  const deadline = Date.now() + control.fixtureLifetimeMs;
  while (!existsSync(target)) {
    if (Date.now() >= deadline) throw new Error(`PAR-035 fixture watchdog expired waiting for ${key}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function answer(expected, actual, description) {
  const actualKeys = Object.keys(actual).sort(compareStrings);
  const expectedKeys = Object.keys(expected).sort(compareStrings);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) || expectedKeys.some((key) => actual[key] !== expected[key])) {
    throw new Error(`PAR-035 ${description} received incorrect answers.`);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function question(id, answerKey, message, acceptedValue) {
  return {
    status: "needs_input",
    request: {
      id: `provider-untrusted-${id}`,
      questions: [{ id, message }],
      answerContract: {
        type: "object",
        required: [answerKey],
        properties: { [answerKey]: { const: acceptedValue, type: "string" } },
        additionalProperties: false,
      },
    },
  };
}

async function main() {
  if (args[0] === "--version") {
    record("version");
    process.stdout.write("codex-cli 0.156.1\n");
    return;
  }
  if (args[0] === "login" && args[1] === "status") {
    record("readiness");
    process.stdout.write("Logged in\n");
    return;
  }
  if (args[0] !== "exec") {
    record("unexpected-command");
    throw new Error("PAR-035 fixture received an unsupported Codex operation.");
  }
  const outputFlag = args.indexOf("--output-last-message");
  if (outputFlag < 0 || typeof args[outputFlag + 1] !== "string") throw new Error("PAR-035 fixture has no output path.");
  const outputPath = path.resolve(project, args[outputFlag + 1]);
  const callId = path.basename(path.dirname(outputPath));
  const request = findRequest(callId);
  if (request.nodeId !== role) throw new Error(`PAR-035 profile '${role}' received node '${request.nodeId}'.`);
  const answers = promptAnswers(await readStdin());
  const key = `${role}-${request.attempt}`;
  const identity = { nodeId: request.nodeId, runId: request.runId, callId: request.callId, attempt: request.attempt };
  const markerValue = { ...identity, role, pid: process.pid, promptAnswers: answers };
  record("inference-started", { ...identity, promptAnswers: answers });
  marker(control.startedPaths[key], markerValue);
  await waitForRelease(key);

  let outcome;
  if (role === "seed" && request.attempt === 1) {
    answer({}, answers, "seed/1");
    outcome = success("seed-report");
  } else if (role === "d" && request.attempt === 1) {
    answer({}, answers, "d/1");
    outcome = success("d-report");
  } else if (role === "a" && request.attempt === 1) {
    answer({}, answers, "a/1");
    outcome = question("a-first", "aFirst", "Approve first A stage", "a-one");
  } else if (role === "a" && request.attempt === 2) {
    answer({ aFirst: "a-one" }, answers, "a/2");
    outcome = question("a-second", "aSecond", "Approve second A stage", "a-two");
  } else if (role === "a" && request.attempt === 3) {
    answer({ aFirst: "a-one", aSecond: "a-two" }, answers, "a/3");
    outcome = success("a-one+a-two");
  } else if (role === "b" && request.attempt === 1) {
    answer({}, answers, "b/1");
    outcome = question("b-first", "bFirst", "Approve B stage", "b-one");
  } else if (role === "b" && request.attempt === 2) {
    answer({ bFirst: "b-one" }, answers, "b/2");
    outcome = success("b-one");
  } else if (role === "c" && request.attempt === 1) {
    answer({}, answers, "c/1");
    outcome = success("c-report");
  } else {
    throw new Error(`PAR-035 fixture received unexpected identity ${role}/${request.attempt}.`);
  }

  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(outcome) }), "utf8");
  record("inference-completed", identity);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
}

function success(text) {
  return { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text } }] };
}

main().catch((error) => {
  record("inference-failed", { message: error instanceof Error ? error.message.slice(0, 300) : "unknown failure" });
  process.stderr.write(error instanceof Error ? error.message : "PAR-035 fixture failed");
  process.exitCode = 1;
});

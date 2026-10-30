import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const role = process.argv[2];
const args = process.argv.slice(3);
const project = process.cwd();
const control = JSON.parse(readFileSync(path.join(project, ".nodulus", "fixtures", "par-031-control.json"), "utf8"));

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
  throw new Error("P4B fixture could not identify the captured call request.");
}

function readPromptAnswers(prompt) {
  const header = "## Answers to clarification questions\n\n";
  const start = prompt.indexOf(header);
  if (start < 0) return {};
  const body = prompt.slice(start + header.length);
  const nextSection = body.search(/\n\n## /);
  const jsonText = nextSection < 0 ? body : body.slice(0, nextSection);
  const answers = JSON.parse(jsonText);
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    throw new Error("P4B fixture found a non-object clarification answer section.");
  }
  return answers;
}

async function waitForRelease(target, label) {
  const deadline = Date.now() + control.fixtureLifetimeMs;
  const absolute = path.resolve(project, target);
  while (!existsSync(absolute)) {
    if (Date.now() >= deadline) throw new Error(`P4B fixture watchdog expired waiting for ${label}.`);
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
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("P4B fixture did not receive an output path.");
  const outputPath = path.resolve(project, args[outputIndex + 1]);
  const callId = path.basename(path.dirname(outputPath));
  const request = requestForCall(callId);
  if (request.nodeId !== role) throw new Error(`P4B fixture profile '${role}' received call for node '${request.nodeId}'.`);
  const prompt = await new Promise((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { content += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(content));
  });
  const promptAnswers = readPromptAnswers(prompt);
  const identity = { nodeId: request.nodeId, runId: request.runId, callId: request.callId, attempt: request.attempt };
  record("inference-started", { ...identity, promptAnswers });
  writeMarker(control.startedPaths[`${role}-${request.attempt}`], { ...identity, role, pid: process.pid });

  if (request.attempt === 1 && (role === "a" || role === "b")) {
    await waitForRelease(control.releasePaths[role], `${role} initial question release`);
  }

  let outcome;
  if (role === "seed" && request.attempt === 1) {
    outcome = { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: "seed report" } }] };
  } else if ((role === "a" || role === "b") && request.attempt === 1) {
    const key = role === "a" ? "aApproval" : "bApproval";
    const value = role === "a" ? "A-approved" : "B-approved";
    outcome = {
      status: "needs_input",
      request: {
        id: `provider-untrusted-${role}`,
        questions: [{ id: `${role}-question`, message: `Provide the ${role.toUpperCase()} approval.` }],
        answerContract: {
          type: "object",
          required: [key],
          properties: { [key]: { const: value, type: "string" } },
          additionalProperties: false,
        },
      },
    };
  } else if ((role === "a" || role === "b") && request.attempt === 2) {
    const key = role === "a" ? "aApproval" : "bApproval";
    const value = role === "a" ? "A-approved" : "B-approved";
    if (JSON.stringify(promptAnswers) !== JSON.stringify({ [key]: value })) {
      throw new Error(`P4B ${role} continuation received an unexpected clarification answer object.`);
    }
    outcome = {
      status: "success",
      artifacts: [{ name: "report", contract: "report.v1", data: { text: `${role}-continued-${value}` } }],
    };
  } else {
    throw new Error(`P4B fixture received unexpected inference identity ${role}/${request.attempt}.`);
  }

  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(outcome) }), "utf8");
  record("inference-completed", identity);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
} else {
  record("unexpected-command");
  process.stderr.write("Unexpected P4B Codex command.");
  process.exitCode = 64;
}

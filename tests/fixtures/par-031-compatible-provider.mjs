import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const project = process.cwd();
const control = JSON.parse(readFileSync(path.join(project, ".nodulus", "fixtures", "par-031-compatible-control.json"), "utf8"));

function record(stage, detail = {}) {
  appendFileSync(control.eventsPath, `${JSON.stringify({ stage, pid: process.pid, atMs: Date.now(), ...detail })}\n`, "utf8");
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
  throw new Error("P4B1 fixture could not identify the captured call request.");
}

function readPromptAnswers(prompt) {
  const header = "## Answers to clarification questions\n\n";
  const start = prompt.indexOf(header);
  if (start < 0) return {};
  const body = prompt.slice(start + header.length);
  const nextSection = body.search(/\n\n## /);
  const answers = JSON.parse(nextSection < 0 ? body : body.slice(0, nextSection));
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    throw new Error("P4B1 fixture found a non-object clarification answer section.");
  }
  return answers;
}

async function readStdin() {
  let contents = "";
  for await (const chunk of process.stdin) contents += chunk;
  return contents;
}

async function waitForRelease(target, label) {
  const deadline = Date.now() + control.fixtureLifetimeMs;
  const absolute = path.resolve(project, target);
  while (!existsSync(absolute)) {
    if (Date.now() >= deadline) throw new Error(`P4B1 fixture watchdog expired waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function reportArtifacts() {
  const alpha = { name: "alpha", contract: "report.v1", data: { text: "seed alpha" } };
  const beta = { name: "beta", contract: "report.v1", data: { text: "seed beta" } };
  return control.mode === "codex" ? [beta, alpha] : [alpha, beta];
}

function outcomeFor(invocation, answers) {
  const { nodeId, call } = invocation;
  const attempt = call?.attempt;
  if (nodeId === "seed" && attempt === 1) {
    return { status: "success", artifacts: reportArtifacts() };
  }
  if ((nodeId === "a" || nodeId === "b") && attempt === 1) {
    const key = nodeId === "a" ? "aApproval" : "bApproval";
    const value = nodeId === "a" ? "A-approved" : "B-approved";
    return {
      status: "needs_input",
      request: {
        id: `provider-untrusted-${nodeId}`,
        questions: [{ id: `${nodeId}-question`, message: `Provide the ${nodeId.toUpperCase()} approval.` }],
        answerContract: {
          type: "object",
          required: [key],
          properties: { [key]: { const: value, type: "string" } },
          additionalProperties: false,
        },
      },
    };
  }
  if ((nodeId === "a" || nodeId === "b") && attempt === 2) {
    const key = nodeId === "a" ? "aApproval" : "bApproval";
    const value = nodeId === "a" ? "A-approved" : "B-approved";
    if (JSON.stringify(answers) !== JSON.stringify({ [key]: value })) {
      throw new Error(`P4B1 ${nodeId} continuation received an unexpected answer object.`);
    }
    return { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: `${nodeId}-continued-${value}` } }] };
  }
  throw new Error(`P4B1 fixture received unexpected inference identity ${nodeId}/${String(attempt)}.`);
}

async function runOpaqueProvider() {
  const invocation = JSON.parse(await readStdin());
  if (control.mode !== "opaque") throw new Error("P4B1 opaque fixture mode does not match its control file.");
  const nodeId = invocation.nodeId;
  const call = invocation.call;
  if (!call || typeof call.callId !== "string" || !Number.isSafeInteger(call.attempt)) {
    throw new Error("P4B1 opaque provider received no runtime call identity.");
  }
  const identity = { nodeId, runId: invocation.runId, callId: call.callId, attempt: call.attempt };
  const answers = readPromptAnswers(invocation.prompt);
  record("opaque-inference-started", { ...identity, promptAnswers: answers });
  writeMarker(control.startedPaths[`${nodeId}-${call.attempt}`], { ...identity, pid: process.pid });
  if (call.attempt === 1 && (nodeId === "a" || nodeId === "b")) {
    await waitForRelease(control.releasePaths[nodeId], `${nodeId} initial question release`);
  }
  const outcome = outcomeFor(invocation, answers);
  record("opaque-inference-completed", identity);
  process.stdout.write(JSON.stringify(outcome));
}

async function runCodexCli() {
  const [role, ...cliArgs] = args;
  if (cliArgs[0] === "--version") {
    record("version", { role });
    process.stdout.write("codex-cli 0.156.1\n");
    return;
  }
  if (cliArgs[0] === "login" && cliArgs[1] === "status") {
    record("readiness", { role });
    process.stdout.write("Logged in\n");
    return;
  }
  if (cliArgs[0] !== "exec") throw new Error("P4B1 Codex fixture received an unexpected command.");
  const outputIndex = cliArgs.indexOf("--output-last-message");
  if (outputIndex < 0 || !cliArgs[outputIndex + 1]) throw new Error("P4B1 Codex fixture received no output path.");
  const outputPath = path.resolve(project, cliArgs[outputIndex + 1]);
  const callId = path.basename(path.dirname(outputPath));
  const request = requestForCall(callId);
  if (request.nodeId !== role) throw new Error(`P4B1 profile '${role}' received call for '${request.nodeId}'.`);
  const promptAnswers = readPromptAnswers(await readStdin());
  const invocation = { nodeId: request.nodeId, runId: request.runId, call: { callId: request.callId, attempt: request.attempt, ...(request.parentCallId ? { parentCallId: request.parentCallId } : {}) }, prompt: "", answers: promptAnswers };
  const identity = { nodeId: request.nodeId, runId: request.runId, callId: request.callId, attempt: request.attempt };
  record("inference-started", { ...identity, promptAnswers });
  writeMarker(control.startedPaths[`${role}-${request.attempt}`], { ...identity, pid: process.pid });
  if (request.attempt === 1 && (role === "a" || role === "b")) {
    await waitForRelease(control.releasePaths[role], `${role} initial question release`);
  }
  const outcome = outcomeFor(invocation, promptAnswers);
  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(outcome) }), "utf8");
  record("inference-completed", identity);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
}

if (args[0] === "opaque") await runOpaqueProvider();
else await runCodexCli();

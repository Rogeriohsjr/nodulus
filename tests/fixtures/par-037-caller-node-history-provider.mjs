import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const project = process.cwd();
const control = JSON.parse(readFileSync(path.join(project, ".nodulus", "fixtures", "par-037-history-control.json"), "utf8"));
const eventsPath = path.resolve(project, control.eventsPath);

function record(event) {
  appendFileSync(eventsPath, `${JSON.stringify({ ...event, pid: process.pid })}\n`, "utf8");
}

function findCall(callId) {
  const runs = path.join(project, ".nodulus", "runs");
  for (const runId of readdirSync(runs)) {
    const candidate = path.join(runs, runId, "calls", callId, "request.json");
    try {
      const request = JSON.parse(readFileSync(candidate, "utf8"));
      if (request.callId === callId) return request;
    } catch { /* this run has no request file for the call */ }
  }
  throw new Error("PAR-037 mixed-history fixture could not find its saved call request.");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let content = "";
    let settled = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (settled) return;
      content += chunk;
      if (Buffer.byteLength(content, "utf8") > 64 * 1024) {
        settled = true;
        process.stdin.pause();
        reject(new Error("PAR-037 mixed-history fixture stdin exceeded its bound."));
      }
    });
    process.stdin.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
    process.stdin.on("end", () => { if (!settled) { settled = true; resolve(content); } });
  });
}

const lifetimeMs = Number.isSafeInteger(control.fixtureLifetimeMs) && control.fixtureLifetimeMs > 0 ? control.fixtureLifetimeMs : 60_000;
const watchdog = setTimeout(() => {
  try { record({ stage: "watchdog-expired" }); } catch { /* still enforce the fixture lifetime */ }
  process.exit(70);
}, lifetimeMs);
watchdog.unref();

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--version") {
    record({ stage: "version" });
    process.stdout.write("codex-cli 0.156.1\n");
    return;
  }
  if (args[0] === "login" && args[1] === "status") {
    record({ stage: "readiness" });
    process.stdout.write("Logged in\n");
    return;
  }
  if (args[0] !== "exec") {
    record({ stage: "unexpected-command" });
    process.stderr.write("Unexpected PAR-037 mixed-history Codex fixture command.");
    process.exitCode = 64;
    return;
  }

  const outputIndex = args.indexOf("--output-last-message");
  const modelIndex = args.indexOf("--model");
  if (outputIndex < 0 || typeof args[outputIndex + 1] !== "string") throw new Error("PAR-037 fixture did not receive an output path.");
  const outputPath = path.resolve(project, args[outputIndex + 1]);
  const callId = path.basename(path.dirname(outputPath));
  const request = findCall(callId);
  const prompt = await readStdin();
  const model = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
  record({
    stage: "inference",
    runId: request.runId,
    nodeId: request.nodeId,
    callId: request.callId,
    attempt: request.attempt,
    ...(typeof model === "string" ? { model } : {}),
    containsCallerGoal: prompt.includes(control.callerGoal),
    containsNodeAnswer: prompt.includes(JSON.stringify(control.nodeAnswer, null, 2)),
  });
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const outcome = request.attempt === 1
    ? {
      status: "needs_input",
      request: {
        id: "provider-untrusted-root-question",
        questions: [{ id: "rootApproval", message: "Approve using the supplied goal." }],
        answerContract: {
          type: "object",
          required: ["rootApproval"],
          properties: { rootApproval: { const: control.nodeAnswer.rootApproval } },
          additionalProperties: false,
        },
      },
    }
    : {
      status: "success",
      artifacts: [{ name: "report", contract: "report.v1", data: { text: control.resultText } }],
    };
  if (request.attempt === 2 && !prompt.includes(JSON.stringify(control.nodeAnswer, null, 2))) {
    throw new Error("PAR-037 attempt 2 prompt did not contain the expected node answer.");
  }
  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(outcome) }), "utf8");
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
}

main().then(() => clearTimeout(watchdog), (error) => {
  clearTimeout(watchdog);
  try { record({ stage: "fixture-error" }); } catch { /* retain the original child error */ }
  process.stderr.write(error instanceof Error ? error.message.slice(0, 300) : "PAR-037 fixture failed.");
  process.exitCode = 1;
});

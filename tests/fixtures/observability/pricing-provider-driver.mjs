import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { runWorkflow } from "../../../dist/application/run-workflow.js";
import { resumeWorkflow } from "../../../dist/application/resume-workflow.js";

const [action, project, requestId] = process.argv.slice(2);
const logPath = path.join(project, ".nodulus", "fixtures", "pricing-calls.jsonl");
let savedCallId;
const index = readFileSync(logPath, "utf8").split(/\r?\n/u).filter((line) => line.trim() !== "").length;

const provider = {
  isAvailable: async () => true,
  invoke: (invocation) => {
    savedCallId = invocation.call?.callId;
    appendFileSync(logPath, `${JSON.stringify({ nodeId: invocation.nodeId, callId: savedCallId, index })}\n`);
    return index === 0
      ? JSON.stringify({
        status: "needs_input",
        request: {
          id: "confirm",
          questions: [{ id: "confirmed", message: "Confirm?" }],
          answerContract: {
            type: "object",
            properties: { confirmed: { type: "boolean" } },
            required: ["confirmed"],
            additionalProperties: false,
          },
        },
      })
      : JSON.stringify({ status: "success", artifacts: [{ name: "example", contract: "example.v1", data: { message: "priced" } }] });
  },
  telemetryForCall: (callId) => callId === savedCallId ? {
    schemaVersion: 1,
    callId,
    provider: "codex",
    cliVersion: "0.144.4",
    reportedModel: "fictional-verified",
    reported: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, reasoningTokens: 20, costUsd: 0 },
    normalized: { inputTokens: 1000, outputTokens: 100 },
    coverage: "complete",
    stepCount: 1,
    source: { eventType: "turn.completed", recordIds: [`turn-${index}`], transportRef: "fixture", parserVersion: 1 },
    semantics: { inputCache: "included", outputReasoning: "included", evidence: "verified" },
    diagnostics: [],
  } : null,
  usageForLastCall: () => ({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, costUsd: 0 }),
};

try {
  if (action === "run") {
    const result = await runWorkflow({ projectRoot: project, cwd: project, workflow: "example", sources: [{ kind: "inline", text: "pricing" }] }, provider);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (action === "resume") {
    const runs = readdirSync(path.join(project, ".nodulus", "runs"));
    if (runs.length !== 1) throw new Error(`Expected one run directory, found ${runs.length}.`);
    const result = await resumeWorkflow({ projectRoot: project, runId: runs[0], requestId, answers: { confirmed: true } }, provider);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else throw new Error(`Unknown action: ${action}`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}

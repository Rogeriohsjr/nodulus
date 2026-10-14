import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [responsesPath, tracePath, markersPath, projectRoot] = process.argv.slice(2);
if (!responsesPath || !tracePath || !markersPath || !projectRoot) throw new Error("Expected response, trace, marker, and project paths");
mkdirSync(markersPath, { recursive: true });
const cursorPath = tracePath + ".cursor";
const cursor = existsSync(cursorPath) ? Number(readFileSync(cursorPath, "utf8")) : 0;
const input = JSON.parse(readFileSync(0, "utf8"));
const invocation = input.invocation ?? input;
const operation = invocation.call?.operation ?? "invoke";
const { responses } = JSON.parse(readFileSync(responsesPath, "utf8"));
const entry = responses[cursor];
if (!entry) throw new Error(`Unexpected or exhausted feedback-limit call #${cursor + 1} for ${invocation.nodeId}`);
if (entry.nodeId !== invocation.nodeId) throw new Error(`Unexpected feedback-limit call #${cursor + 1}: expected ${entry.nodeId}, got ${invocation.nodeId}`);
if (entry.operation && entry.operation !== operation) throw new Error(`Unexpected operation for ${invocation.nodeId}: expected ${entry.operation}, got ${operation}`);
writeFileSync(cursorPath, String(cursor + 1), "utf8");
let deadlineAtMs;
try {
  const checkpoint = JSON.parse(readFileSync(path.join(projectRoot, ".nodulus", "runs", invocation.runId, "run.json"), "utf8"));
  deadlineAtMs = checkpoint.feedbackRouting?.regions?.["content-review"]?.deadlineAtMs;
} catch { /* the first checkpoint may not contain a routing deadline yet */ }
appendFileSync(tracePath, JSON.stringify({ nodeId: invocation.nodeId, operation, attempt: invocation.call?.attempt ?? invocation.attempt, callId: invocation.call?.callId, inputs: invocation.inputs, deadlineAtMs }) + "\n", "utf8");
writeFileSync(path.join(markersPath, `started-${cursor + 1}`), "started\n", "utf8");
if (Number.isFinite(entry.delayMs) && entry.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
if (entry.fail === true) {
  writeFileSync(path.join(markersPath, `completed-${cursor + 1}`), "failed\n", "utf8");
  process.stderr.write("Controlled fixture provider failure\n");
  process.exit(17);
}
writeFileSync(path.join(markersPath, `completed-${cursor + 1}`), "completed\n", "utf8");
if (typeof entry.rawOutcome === "string") {
  process.stdout.write(entry.rawOutcome);
  process.exit(0);
}
const data = entry.kind === "decision"
  ? { decisionCode: entry.decisionCode, reason: entry.reason, findings: entry.findings, artifactRefs: invocation.inputs?.artifactReferences }
  : { text: entry.text };
process.stdout.write(JSON.stringify({ status: "success", artifacts: [{ name: entry.name ?? (entry.kind === "decision" ? "decision" : "continued"), contract: entry.contract ?? (entry.kind === "decision" ? "workflow-decision.v1" : "continued.v1"), data }] }));

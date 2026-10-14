import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [responsesPath, tracePath] = process.argv.slice(2);
if (!responsesPath || !tracePath) throw new Error("Expected response and trace paths");
const cursorPath = `${tracePath}.cursor`;
const cursor = existsSync(cursorPath) ? Number(readFileSync(cursorPath, "utf8")) : 0;
const invocation = JSON.parse(readFileSync(0, "utf8"));
const { responses } = JSON.parse(readFileSync(responsesPath, "utf8"));
const entry = responses[cursor];
if (!entry) throw new Error(`Unexpected or exhausted provider call #${cursor + 1} for ${invocation.nodeId}`);
if (entry.nodeId !== invocation.nodeId) throw new Error(`Unexpected provider call #${cursor + 1}: expected ${entry.nodeId}, got ${invocation.nodeId}`);
writeFileSync(cursorPath, String(cursor + 1), "utf8");
appendFileSync(tracePath, `${JSON.stringify(invocation)}\n`, "utf8");
if (typeof entry.rawOutcome === "string") {
  process.stdout.write(entry.rawOutcome);
  process.exit(0);
}
const data = entry.kind === "decision"
  ? { decisionCode: entry.decisionCode, reason: entry.reason, findings: entry.findings, artifactRefs: invocation.inputs?.artifactReferences }
  : { text: entry.text };
process.stdout.write(JSON.stringify({ status: "success", artifacts: [{ name: entry.name ?? "decision", contract: entry.contract ?? "workflow-decision.v1", data }] }));

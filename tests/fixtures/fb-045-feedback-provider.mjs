import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [responsesPath, tracePath] = process.argv.slice(2);
if (!responsesPath || !tracePath) throw new Error("Expected response and trace paths");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const invocation = JSON.parse(input);
const call = invocation.call;
if (!call || !Number.isInteger(call.attempt) || !["invoke", "repair_response"].includes(call.operation)) {
  throw new Error("Provider invocation is missing operation and attempt metadata");
}
const cursorPath = `${tracePath}.fb045.cursor`;
const cursor = existsSync(cursorPath)
  ? Number(readFileSync(cursorPath, "utf8"))
  : existsSync(tracePath) ? readFileSync(tracePath, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
const { responses } = JSON.parse(readFileSync(responsesPath, "utf8"));
const entry = responses[cursor];
if (!entry || entry.nodeId !== invocation.nodeId) throw new Error(`Unexpected provider call #${cursor + 1} for ${invocation.nodeId}`);
writeFileSync(cursorPath, String(cursor + 1), "utf8");
appendFileSync(tracePath, `${JSON.stringify(invocation)}\n`, "utf8");
if (typeof entry.rawOutcome === "string") {
  process.stdout.write(entry.rawOutcome);
} else {
  const data = entry.kind === "decision"
    ? { decisionCode: entry.decisionCode, reason: entry.reason, findings: entry.findings, artifactRefs: invocation.inputs?.artifactReferences ?? [] }
    : { text: entry.text };
  process.stdout.write(JSON.stringify({
    status: "success",
    artifacts: [{ name: entry.name ?? (entry.kind === "decision" ? "decision" : "continued"), contract: entry.contract ?? (entry.kind === "decision" ? "workflow-decision.v1" : "continued.v1"), data }],
  }));
}

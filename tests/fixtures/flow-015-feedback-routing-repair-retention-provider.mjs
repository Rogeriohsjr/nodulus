import { appendFileSync, readFileSync } from "node:fs";

const [responsesPath, tracePath] = process.argv.slice(2);
if (!responsesPath || !tracePath) throw new Error("Expected response and trace paths");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const invocation = JSON.parse(input);
const call = invocation.call;
if (!call || !["invoke", "repair_response"].includes(call.operation) || !Number.isInteger(call.attempt)) {
  throw new Error("Provider invocation is missing runtime-owned operation/attempt metadata");
}
const { entries } = JSON.parse(readFileSync(responsesPath, "utf8"));
const key = `${invocation.nodeId}:${call.operation}:${call.attempt}`;
const entry = entries.find((candidate) => `${candidate.nodeId}:${candidate.operation}:${candidate.attempt}` === key);
if (!entry) throw new Error(`Unexpected provider call ${key}`);
appendFileSync(tracePath, `${JSON.stringify(invocation)}\n`, "utf8");
if (typeof entry.rawOutcome === "string") {
  process.stdout.write(entry.rawOutcome);
} else {
  const data = entry.kind === "decision"
    ? { decisionCode: entry.decisionCode, reason: entry.reason, findings: entry.findings, artifactRefs: invocation.inputs?.artifactReferences ?? [] }
    : { text: entry.text };
  process.stdout.write(JSON.stringify({ status: "success", artifacts: [{ name: entry.name ?? "decision", contract: entry.contract ?? "workflow-decision.v1", data }] }));
}

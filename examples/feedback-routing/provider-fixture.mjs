import { appendFileSync, readFileSync } from "node:fs";

const invocation = JSON.parse(readFileSync(0, "utf8"));
const [tracePath, mode] = process.argv.slice(2);
if (!tracePath) throw new Error("Expected the local invocation trace path");
appendFileSync(tracePath, JSON.stringify(invocation) + "\n", "utf8");

const text = typeof invocation.inputs?.source === "string"
  ? invocation.inputs.source
  : typeof invocation.inputs?.text === "string" ? invocation.inputs.text : "";
const earlier = readFileSync(tracePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const count = (nodeId) => earlier.filter((entry) => entry.nodeId === nodeId).length;
const output = (name, contract, data) => ({ status: "success", artifacts: [{ name, contract, data }] });
let response;

if (invocation.nodeId === "prepare") {
  response = output("source", "text.v1", text);
} else if (invocation.nodeId === "normalize") {
  const source = typeof invocation.inputs?.source === "string" ? invocation.inputs.source : "";
  const normalized = source.normalize("NFC").trim().replace(/\s+/gu, " ");
  const candidate = count("normalize") === 1 && mode !== "always-normalize" ? source : normalized;
  response = output("text", "text.v1", candidate);
} else if (invocation.nodeId === "review") {
  const candidate = typeof invocation.inputs?.text === "string" ? invocation.inputs.text : "";
  const accepted = candidate === candidate.normalize("NFC").trim().replace(/\s+/gu, " ");
  const data = {
    decisionCode: accepted ? "ACCEPT" : "FIX_TEXT",
    reason: accepted ? "Text is normalized." : "Normalize the text before reporting it.",
    findings: accepted ? [] : [{ id: "TEXT-NORMALIZATION", expected: "NFC, trimmed, single-space text" }],
    artifactRefs: invocation.inputs?.artifactReferences ?? [],
  };
  response = output("decision", "workflow-decision.v1", data);
} else if (invocation.nodeId === "report") {
  response = output("report", "text.v1", text);
} else {
  throw new Error("Unexpected node: " + invocation.nodeId);
}

process.stdout.write(JSON.stringify(response));

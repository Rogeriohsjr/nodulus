import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [responsesPath, tracePath] = process.argv.slice(2);
if (!responsesPath || !tracePath) throw new Error("Expected response and trace paths");
const cursorPath = tracePath + ".cursor";
const cursor = existsSync(cursorPath) ? Number(readFileSync(cursorPath, "utf8")) : 0;
const invocation = JSON.parse(readFileSync(0, "utf8"));
const { responses } = JSON.parse(readFileSync(responsesPath, "utf8"));
const entry = responses[cursor];
if (!entry) throw new Error("Unexpected or exhausted provider call #" + (cursor + 1) + " for " + invocation.nodeId);
if (entry.nodeId !== invocation.nodeId) throw new Error("Unexpected provider call #" + (cursor + 1) + ": expected " + entry.nodeId + ", got " + invocation.nodeId);
writeFileSync(cursorPath, String(cursor + 1), "utf8");
appendFileSync(tracePath, JSON.stringify(invocation) + "\n", "utf8");

const references = Array.isArray(invocation.inputs?.artifactReferences) ? invocation.inputs.artifactReferences.map((reference) => ({ ...reference })) : [];
switch (entry.artifactRefsMode) {
  case "missing":
    references.length = 0;
    break;
  case "duplicate":
    if (references[0]) references.push({ ...references[0] });
    break;
  case "stale":
    if (references[0]) references[0].generationId = "stale-generation-id";
    break;
  case "forged-digest":
    if (references[0]) references[0].sha256 = "0".repeat(64);
    break;
  case "unmapped":
    references.push({ runId: invocation.runId, nodeId: "ghost", outputName: "ghost", contract: "ghost.v1", iteration: 1, generationId: "ghost", sha256: "0".repeat(64) });
    break;
}

if (typeof entry.rawOutcome === "string") {
  process.stdout.write(entry.rawOutcome);
  process.exit(0);
}
const data = entry.kind === "decision"
  ? { decisionCode: entry.decisionCode, reason: entry.reason, findings: entry.findings, artifactRefs: references }
  : { text: entry.text };
process.stdout.write(JSON.stringify({
  status: "success",
  artifacts: [{ name: entry.name ?? (entry.kind === "decision" ? "decision" : "continued"), contract: entry.contract ?? (entry.kind === "decision" ? "workflow-decision.v1" : "continued.v1"), data }],
}));

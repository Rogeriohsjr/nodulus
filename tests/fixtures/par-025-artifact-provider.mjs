import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (typeof request.caseId !== "string" || typeof request.nodeId !== "string" || typeof request.callId !== "string" || typeof request.stateDirectory !== "string") {
  throw new Error("P3C provider fixture request is invalid.");
}

mkdirSync(request.stateDirectory, { recursive: true });
const record = { pid: process.pid, nodeId: request.nodeId, callId: request.callId, inputs: request.inputs };
writeFileSync(path.join(request.stateDirectory, `started-${request.nodeId}.json`), JSON.stringify(record), "utf8");

let artifacts;
if (request.nodeId === "producer") {
  if (request.caseId === "missing") artifacts = [];
  else {
    const data = request.caseId === "empty"
      ? { kind: "empty", items: [] }
      : request.caseId === "unavailable"
        ? { kind: "unavailable", reason: "source data is unavailable" }
        : { kind: "empty", items: "not-an-array" };
    artifacts = [{ name: "report", contract: "artifact-state.v1", data }];
  }
} else if (request.nodeId === "consumer") {
  const kind = request.inputs?.state?.kind;
  artifacts = [{ name: "report", contract: "report.v1", data: { text: `consumed:${String(kind)}` } }];
} else throw new Error(`P3C fixture received unexpected node '${request.nodeId}'.`);

const response = JSON.stringify({ status: "success", artifacts });
process.stdout.write(response);
writeFileSync(path.join(request.stateDirectory, `finished-${request.nodeId}.json`), JSON.stringify(record), "utf8");

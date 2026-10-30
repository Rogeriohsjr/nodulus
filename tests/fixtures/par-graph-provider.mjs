import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
  });
}

const request = await readInput();
const startedPath = path.join(request.stateDirectory, `started-${request.nodeId}.json`);
const finishedPath = path.join(request.stateDirectory, `finished-${request.nodeId}.json`);
const releasePath = path.join(request.stateDirectory, `release-${request.nodeId}`);
writeFileSync(startedPath, JSON.stringify({ callId: request.callId, nodeId: request.nodeId, inputs: request.inputs }), "utf8");
const deadline = Date.now() + 10_000;
while (!existsSync(releasePath)) {
  if (Date.now() >= deadline) {
    process.stderr.write(`Fixture watchdog expired for ${request.nodeId}.`);
    process.exitCode = 71;
    process.exit();
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
writeFileSync(finishedPath, JSON.stringify({ callId: request.callId, nodeId: request.nodeId }), "utf8");
process.stdout.write(JSON.stringify({
  status: "success",
  artifacts: [{ name: "report", contract: "report.v1", data: { text: `done:${request.nodeId}` } }],
}));

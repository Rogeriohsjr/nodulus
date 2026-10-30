import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const artifact = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const nodeId = typeof artifact.text === "string" ? artifact.text.replace(/^done:/, "") : "invalid";
const stateDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "validator-process-state");
const startedPath = path.join(stateDirectory, `started-${nodeId}.json`);
const releasePath = path.join(stateDirectory, `release-${nodeId}`);
const finishedPath = path.join(stateDirectory, `finished-${nodeId}.json`);

writeFileSync(startedPath, JSON.stringify({ nodeId, artifact, pid: process.pid }), "utf8");
const deadline = Date.now() + 10_000;
while (!existsSync(releasePath)) {
  if (Date.now() >= deadline) {
    process.stderr.write(`Validator fixture watchdog expired for ${nodeId}.`);
    process.exitCode = 72;
    process.exit();
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
writeFileSync(finishedPath, JSON.stringify({ nodeId, pid: process.pid }), "utf8");
process.stdout.write('{"valid":true,"errors":[]}');

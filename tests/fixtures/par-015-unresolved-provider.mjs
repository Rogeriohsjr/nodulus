import { randomUUID } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
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

const input = await readInput();
const marker = path.join(input.controlDirectory, `started-${input.key}.json`);
const release = path.join(input.controlDirectory, `release-${input.key}`);
const startedTemporary = `${marker}.${randomUUID()}.tmp`;
writeFileSync(startedTemporary, JSON.stringify({ pid: process.pid, key: input.key, operation: input.operation }), { encoding: "utf8", flag: "wx" });
renameSync(startedTemporary, marker);
const deadline = Date.now() + 60_000;
while (!existsSync(release)) {
  if (Date.now() >= deadline) {
    process.stderr.write(`Unresolved provider fixture watchdog expired: ${input.key}`);
    process.exit(71);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const finished = path.join(input.controlDirectory, `finished-${input.key}.json`);
const finishedTemporary = `${finished}.${randomUUID()}.tmp`;
writeFileSync(finishedTemporary, JSON.stringify({ pid: process.pid, key: input.key }), { encoding: "utf8", flag: "wx" });
renameSync(finishedTemporary, finished);
if (input.behavior === "reject") {
  process.stderr.write(`Deliberate late rejection: ${input.key}`);
  process.exit(23);
}
process.stdout.write(input.value ?? "available");

import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

for await (const _chunk of process.stdin) { /* consume the real serialized artifact */ }
const markerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "par-015-validator-started.json");
const temporaryMarkerPath = `${markerPath}.${process.pid}.tmp`;
writeFileSync(temporaryMarkerPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
renameSync(temporaryMarkerPath, markerPath);
setTimeout(() => process.exit(73), 60_000);

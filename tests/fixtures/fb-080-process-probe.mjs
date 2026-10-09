import { writeFileSync } from "node:fs";

const [startedPath] = process.argv.slice(2);
if (!startedPath) throw new Error("FB-080 process probe requires a start marker path");
writeFileSync(startedPath, JSON.stringify({ pid: process.pid, atMs: Date.now() }), "utf8");
setInterval(() => undefined, 1000);

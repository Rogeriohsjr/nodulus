import { appendFileSync, writeFileSync } from "node:fs";

const [startedPath, eventsPath] = process.argv.slice(2);
if (!startedPath || !eventsPath) throw new Error("FB-080 descendant fixture requires marker paths");
writeFileSync(startedPath, JSON.stringify({ pid: process.pid, atMs: Date.now() }), "utf8");
appendFileSync(eventsPath, JSON.stringify({ stage: "descendant-started", atMs: Date.now(), pid: process.pid }) + "\n", "utf8");
setInterval(() => undefined, 1000);

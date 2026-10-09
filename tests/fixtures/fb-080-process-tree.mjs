import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [descendantPath, parentStartedPath, descendantStartedPath, descendantPidPath, eventsPath] = process.argv.slice(2);
if (!descendantPath || !parentStartedPath || !descendantStartedPath || !descendantPidPath || !eventsPath) {
  throw new Error("FB-080 process-tree fixture requires descendant and marker paths");
}
const record = (stage, extra = {}) => appendFileSync(eventsPath, JSON.stringify({ stage, atMs: Date.now(), pid: process.pid, ...extra }) + "\n", "utf8");
const child = spawn(process.execPath, [descendantPath, descendantStartedPath, eventsPath], { windowsHide: true, stdio: "ignore" });
writeFileSync(parentStartedPath, JSON.stringify({ pid: process.pid, atMs: Date.now() }), "utf8");
record("parent-started", { descendantPid: child.pid });
child.once("spawn", () => writeFileSync(descendantPidPath, String(child.pid), "utf8"));
setInterval(() => undefined, 1000);

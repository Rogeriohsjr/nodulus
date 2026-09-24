import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const appPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const { resumeWorkflow } = await import(pathToFileURL(appPath).href);
const [projectRoot, runId, requestId, answersPath, enteredPath, releasePath, callLogPath] = process.argv.slice(2);

const provider = {
  async invoke(invocation) {
    writeFileSync(enteredPath, JSON.stringify({ nodeId: invocation.nodeId, pid: process.pid }), "utf8");
    const prior = existsSync(callLogPath) ? readFileSync(callLogPath, "utf8") : "";
    writeFileSync(callLogPath, `${prior}${JSON.stringify({ nodeId: invocation.nodeId, pid: process.pid, ...(invocation.answers ? { answers: invocation.answers } : {}) })}\n`, "utf8");
    const deadline = Date.now() + 12000;
    while (!existsSync(releasePath)) {
      if (Date.now() > deadline) throw new Error("fixture release handshake timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const output = invocation.nodeId === "review"
      ? { name: "review", contract: "review.v1", data: { text: "recovered review" } }
      : { name: "implementation", contract: "implementation.v1", data: { text: "recovered implementation" } };
    return JSON.stringify({ status: "success", artifacts: [output] });
  },
  isAvailable() { return true; },
};

try {
  const result = await resumeWorkflow({
    projectRoot,
    runId,
    requestId,
    answers: JSON.parse(readFileSync(answersPath, "utf8")),
  }, provider);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: error && typeof error === "object" && "code" in error ? error.code : "DRIVER_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  }));
  process.exitCode = 1;
}

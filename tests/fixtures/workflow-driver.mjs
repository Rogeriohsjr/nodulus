import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const appPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const { getRunStatus, resumeWorkflow, runWorkflow } = await import(pathToFileURL(appPath).href);
const [operation, projectRoot, ...args] = process.argv.slice(2);
const provider = {
  async invoke(invocation) {
    const child = spawnSync(process.execPath, [String(invocation.providerProfile.executable)], {
      cwd: projectRoot,
      input: JSON.stringify(invocation),
      encoding: "utf8",
      timeout: 5000,
    });
    if (child.error || child.status !== 0) throw new Error(`Fixture provider failed: ${child.error?.message ?? child.stderr}`);
    return child.stdout;
  },
  isAvailable(profile) {
    return existsSync(String(profile.executable));
  },
};

try {
  let result;
  if (operation === "run") {
    const [inputsFile, referencesFile] = args;
    result = await runWorkflow({
      projectRoot,
      cwd: projectRoot,
      workflow: "example",
      sources: [{ kind: "inline", text: "Build the requested deliverable." }],
      callerInputs: JSON.parse(readFileSync(inputsFile, "utf8")),
      ...(referencesFile ? { referencesFile } : {}),
    }, provider);
  } else if (operation === "resume") {
    const [runId, requestId, answersFile] = args;
    result = await resumeWorkflow({
      projectRoot,
      runId,
      requestId,
      answers: JSON.parse(readFileSync(answersFile, "utf8")),
    }, provider);
  } else if (operation === "status") {
    const [runId] = args;
    result = await getRunStatus(projectRoot, runId);
  } else {
    throw new Error(`Unknown driver operation '${operation}'.`);
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: error && typeof error === "object" && "code" in error ? error.code : "DRIVER_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  }));
}

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const [projectRoot, runId, requestId, rawAnswers, responsesPath, tracePath] = process.argv.slice(2);
if (!projectRoot || !runId || !requestId || !rawAnswers || !responsesPath || !tracePath) {
  throw new Error("Expected project, run, request, answers, responses and trace arguments");
}
const { resumeWorkflow } = await import(pathToFileURL(path.resolve("dist/application/resume-workflow.js")).href);
const providerFixture = path.resolve("tests/fixtures/fb-045-feedback-provider.mjs");
const provider = {
  async invoke(invocation) {
    const result = spawnSync(process.execPath, [providerFixture, responsesPath, tracePath], {
      cwd: projectRoot,
      input: JSON.stringify(invocation),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `Fixture exited ${result.status}`);
    return result.stdout;
  },
};

try {
  const result = await resumeWorkflow({ projectRoot, runId, requestId, answers: JSON.parse(rawAnswers) }, provider);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error?.code ?? "ERROR", message: error instanceof Error ? error.message : String(error) } }));
}

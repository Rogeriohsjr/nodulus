import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";

test.each([
  { name: "passing test is not RED", source: 'test("requirement", () => expect(1).toBe(1));', reachesImplement: false },
  { name: "assertion failure is RED", source: 'test("requirement", () => expect(1).toBe(2));', reachesImplement: true },
  { name: "syntax failure is not RED", source: 'test("requirement", () => {', reachesImplement: false },
])("DEV-002 $name despite model ACCEPT", async ({ source, reachesImplement }) => {
  const project = mkdtempSync(path.join(tmpdir(), "Nodulus RED gate ü "));
  if (path.dirname(project) !== tmpdir() || !path.basename(project).startsWith("Nodulus RED gate ü ")) throw new Error("Refusing cleanup outside owned fixture");
  try {
    cpSync(path.resolve("examples/development-workflow/.nodulus"), path.join(project, ".nodulus"), { recursive: true });
    cpSync(path.resolve(".agents/skills/nodulus-workflow-builder"), path.join(project, ".agents/skills/nodulus-workflow-builder"), { recursive: true });
    symlinkSync(path.resolve("node_modules"), path.join(project, "node_modules"), "junction");
    mkdirSync(path.join(project, "tests/scenarios"), { recursive: true });
    writeFileSync(path.join(project, "tests/scenarios/assigned.test.mjs"), `import { expect, test } from "vitest";\n${source}\n`);
    writeFileSync(path.join(project, "package.json"), JSON.stringify({ type: "module", scripts: { build: 'node -e "process.exit(0)"' } }));
    writeFileSync(path.join(project, ".nodulus/development-task.json"), JSON.stringify({ mode: "vitest-red", testFile: "tests/scenarios/assigned.test.mjs" }));
    writeFileSync(path.join(project, ".nodulus/workflows/red-checkpoint.json"), JSON.stringify({ schemaVersion: 1, id: "red-checkpoint", nodes: ["dev-tests", "dev-test-review", "dev-implement"] }));
    const calls: string[] = [];

    if (path.dirname(project) !== tmpdir() || !path.basename(project).startsWith("Nodulus RED gate ü ")) throw new Error("Refusing cleanup outside owned fixture");

    const result = await runWorkflow({ projectRoot: project, cwd: project, workflow: "red-checkpoint", sources: [{ kind: "inline", text: "Verify the assigned test checkpoint" }] }, {
      async invoke(invocation) {
        calls.push(invocation.nodeId);
        const review = invocation.nodeId === "dev-test-review";
        return JSON.stringify({ status: "success", artifacts: [{ name: "result", contract: review ? "dev-review.v1" : "dev-work.v1", data: review ? { decision: "ACCEPT", summary: "Boundary model accepts", validation: "Do not trust this report" } : { summary: "Boundary writer", changedFiles: [], validation: "Do not trust this report" } }] });
      },
    });
    expect(result.status).toBe(reachesImplement ? "success" : "error");
    expect(calls).toEqual(reachesImplement ? ["dev-tests", "dev-test-review", "dev-implement"] : ["dev-tests"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

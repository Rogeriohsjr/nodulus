import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWorkflow } from "../../src/application/run-workflow.js";

export async function executePlanFixture(mutate: (plan: any) => void = () => {}, mutateContext: (context: any) => void = () => {}) {
  const project = mkdtempSync(path.join(tmpdir(), "Nodulus planning Ã¼ "));
  cpSync(path.resolve("examples/task-planning/.nodulus"), path.join(project, ".nodulus"), { recursive: true });
  mkdirSync(path.join(project, "src"));
  writeFileSync(path.join(project, "src/example.ts"), "export function example() {}", "utf8");
  const context = { contextHash: "fixture-hash", limits: { maxFiles: 3, maxCases: 3 }, repositories: [{ id: "repo", root: project, files: [
    { path: "src/example.ts", content: "export function example() {}", sha256: "fixture", exists: true },
    { path: "tests/example.test.ts", content: null, sha256: null, exists: false },
    { path: "docs/change.md", content: null, sha256: null, exists: false },
  ], checks: [{ id: "focused", executable: process.execPath, args: ["--version"] }] }] };
  mutateContext(context);
  writeFileSync(path.join(project, ".nodulus/task-context.json"), JSON.stringify(context));
  const plan = { contextHash: "fixture-hash", decision: "ready", summary: "One small change", questions: [], tasks: [{ id: "T1", repoId: "repo", title: "One behavior", kind: "runtime", dependsOn: [], goal: "Return one result", files: [{ path: "src/example.ts", symbol: "example", change: "Return a string" }], references: [{ path: "src/example.ts", symbol: "example" }], acceptance: ["Given a call, returns string"], testing: { mode: "tdd", testFile: "tests/example.test.ts", expectedFailure: "Expected string but got undefined", exception: null, checkIds: ["focused"] }, documentation: ["docs/change.md"] }] };
  mutate(plan);
  let calls = 0;
  try {
    const result = await runWorkflow({ projectRoot: project, cwd: project, workflow: "task-plan", callerInputs: { context }, sources: [{ kind: "inline", text: "Plan one behavior" }] }, { async invoke() { calls++; return JSON.stringify({ status: "success", artifacts: [{ name: "plan", contract: "task-plan.v1", data: plan }] }); } });
    return { status: result.status, result: result.result, calls };
  } finally { rmSync(project, { recursive: true, force: true }); }
}

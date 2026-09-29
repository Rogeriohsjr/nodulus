import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { fileHash } from "../../scripts/task-workflow/io.mjs";

test.each(["valid", "outside", "stale", "check-failure", "test-mutation", "review-reject", "empty-doc"])("TASK-003 %s applies and checks through real workflow validators", async mode => {
  const project = mkdtempSync(path.join(tmpdir(), "Nodulus packet ü "));
  cpSync("examples/task-planning/.nodulus", path.join(project, ".nodulus"), { recursive: true });
  cpSync("scripts/task-workflow", path.join(project, ".nodulus/task-tools"), { recursive: true });
  mkdirSync(path.join(project, "docs"));
  writeFileSync(path.join(project, "source.ts"), "old");
  writeFileSync(path.join(project, "test.ts"), "frozen");
  writeFileSync(path.join(project, "check.cjs"), `const fs=require('node:fs'); ${mode === "test-mutation" ? "fs.writeFileSync('test.ts','changed');" : ""} process.exit(${mode === "check-failure" ? "7" : "fs.readFileSync('source.ts','utf8') === 'new' ? 0 : 1"});`);
  const task = { id: "T1", testing: { mode: "tdd", testFile: "test.ts", checkIds: ["focused"] }, files: [{ path: "source.ts" }], documentation: ["docs/change.md"] };
  const repo = { id: "repo", root: project, checks: [{ id: "focused", executable: process.execPath, args: ["check.cjs"] }] };
  const state = { executionId: "fixture", contextHash: "fixture-hash", task, repo, hashes: { "source.ts": fileHash(path.join(project, "source.ts")), "test.ts": fileHash(path.join(project, "test.ts")), "docs/change.md": null }, completed: [] };
  writeFileSync(path.join(project, ".nodulus/task-execution.json"), JSON.stringify(state));
  if (mode === "stale") writeFileSync(path.join(project, "source.ts"), "coworker");
  const calls: string[] = [];
  try {
    const result = await runWorkflow({ projectRoot: project, cwd: project, workflow: "task-implement", callerInputs: { packet: { task, repository: repo, contextHash: "fixture-hash" } }, sources: [{ kind: "inline", text: "Implement the selected task" }] }, { async invoke(invocation) {
      calls.push(invocation.nodeId);
      const review = invocation.nodeId === "packet-review";
      const docs = invocation.nodeId === "packet-docs";
      return JSON.stringify({ status: "success", artifacts: [{ name: review ? "review" : "changes", contract: review ? "task-review.v1" : "task-change.v1", data: review ? { decision: mode === "review-reject" ? "changes_required" : "accept", summary: "Fixture review" } : { files: [{ path: docs ? "docs/change.md" : mode === "outside" ? "../outside.ts" : "source.ts", content: docs ? mode === "empty-doc" ? "" : "# Actual change" : "new" }], summary: "Fixture changes" } }] });
    } });
    expect(result.status).toBe(mode === "valid" ? "success" : "error");
    const expectedCalls = mode === "valid" || mode === "review-reject" ? 3 : mode === "empty-doc" ? 2 : 1;
    expect(calls).toHaveLength(expectedCalls);
    expect(existsSync(path.join(project, ".nodulus/task-completed/fixture-hash/T1.json"))).toBe(mode === "valid");
    expect(readFileSync(path.join(project, "test.ts"), "utf8")).toBe(mode === "test-mutation" ? "changed" : "frozen");
    if (mode === "outside" || mode === "stale") expect(readFileSync(path.join(project, "source.ts"), "utf8")).toBe(mode === "stale" ? "coworker" : "old");
  } finally { rmSync(project, { recursive: true, force: true }); }
}, 20000);

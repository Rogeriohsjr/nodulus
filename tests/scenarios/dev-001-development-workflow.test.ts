import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, type ProviderInvocation } from "../../src/application/run-workflow.js";

test.each([{ rejectReview: false, failQuality: false }, { rejectReview: true, failQuality: false }, { rejectReview: false, failQuality: true }])("DEV-001 example sequences accepted checkpoints and stops on rejected review ($rejectReview/$failQuality)", async ({ rejectReview, failQuality }) => {
  const project = mkdtempSync(path.join(tmpdir(), "Nodulus development ü "));
  cpSync(path.resolve("examples/development-workflow/.nodulus"), path.join(project, ".nodulus"), { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { check: "node .nodulus/fixture-quality.cjs" } }));
  writeFileSync(path.join(project, ".nodulus/fixture-quality.cjs"), `require("node:fs").writeFileSync(".nodulus/quality-ran", "executed"); process.exit(${failQuality ? 7 : 0});`);
  const calls: ProviderInvocation[] = [];
  try {
    const result = await runWorkflow({ projectRoot: project, cwd: project, workflow: "develop-reviewed", sources: [{ kind: "inline", text: "Develop the isolated exercise" }] }, {
      async invoke(invocation) {
        calls.push(invocation);
        if (invocation.nodeId === "dev-test-review" && rejectReview) return JSON.stringify({ status: "error", error: { code: "REVIEW_CHANGES_REQUIRED", message: "Add boundary assertions" } });
        const review = invocation.nodeId.endsWith("review");
        return JSON.stringify({ status: "success", artifacts: [{ name: "result", contract: review ? "dev-review.v1" : "dev-work.v1", data: review ? { decision: "ACCEPT", summary: "Fixture review", validation: "Fixture boundary only" } : { summary: invocation.nodeId, changedFiles: ["exercise.mjs"], validation: "Fixture boundary only" } }] });
      },
    });
    expect(existsSync(path.join(project, ".nodulus/quality-ran"))).toBe(!rejectReview);
    if (failQuality) expect(result.result).toMatchObject({ error: { code: "VALIDATOR_EXECUTION_FAILED" } });
    expect(result.status).toBe(rejectReview || failQuality ? "error" : "success");
    expect(calls.map((call) => call.nodeId)).toEqual(rejectReview ? ["dev-tests", "dev-test-review"] : ["dev-tests", "dev-test-review", "dev-implement", "dev-review"]);
    expect(calls[1]!.inputs.tests).toMatchObject({ summary: "dev-tests" });
    if (!rejectReview) {
      expect(calls[2]!.inputs.testReview).toMatchObject({ decision: "ACCEPT" });
      expect(calls[3]!.inputs.implementation).toMatchObject({ summary: "dev-implement" });
    }
    if (!failQuality) expect(readFileSync(path.join(project, ".nodulus/runs", result.runId!, "result.json"), "utf8")).toContain(rejectReview ? "REVIEW_CHANGES_REQUIRED" : "ACCEPT");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runProductionCli } from "../support/production-cli.js";
import { cleanupClarificationProject, createClarificationProject } from "../support/clarification-resume.js";

test("ASK-001 asks for a missing declared caller input before invoking the first node", () => {
  const { project, callLog } = createClarificationProject("ask-001");
  const caller = mkdtempSync(path.join(tmpdir(), "nodulus-ask-001-caller-"));
  mkdirSync(caller, { recursive: true });
  writeFileSync(path.join(caller, "inputs.json"), "{}\n", "utf8");
  try {
    const cli = runProductionCli([
      "run", "--project", project, "--workflow", "example", "--request", "Build the target.",
      "--inputs-file", "inputs.json", "--json",
    ], { cwd: caller });
    expect(cli.status).toBe(2);
    const envelope = JSON.parse(cli.stdout);
    expect(envelope).toMatchObject({ schemaVersion: 1, status: "needs_input" });
    expect(envelope.runId).toMatch(/\S/);
    expect(envelope.result.request.answerContract).toMatchObject({
      type: "object",
      required: ["goal"],
      properties: { goal: { $ref: "#/$defs/goal.v1" } },
    });
    const pending = JSON.parse(readFileSync(path.join(project, ".nodulus", "runs", envelope.runId, "pending", "request.json"), "utf8"));
    expect(pending.questions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "goal", message: expect.stringMatching(/goal|target/i) })]));
    expect(existsSync(callLog)).toBe(false);
  } finally {
    cleanupClarificationProject(project);
    rmSync(caller, { recursive: true, force: true });
  }
});

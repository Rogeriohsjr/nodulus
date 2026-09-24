import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { resumeWorkflow } from "../../src/application/resume-workflow.js";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { cleanupClarificationProject, configureSinglePauseNode, createClarificationProject, createClarificationRunRequest, fixtureProvider } from "../support/clarification-resume.js";

const guardCases = [
  { label: "workspace reference drift", code: "WORKSPACE_REFERENCE_CHANGED" },
  { label: "incompatible engine version", code: "ENGINE_VERSION_UNSUPPORTED" },
  { label: "incompatible schema version", code: "RUN_SCHEMA_UNSUPPORTED" },
  { label: "unavailable captured provider", code: "CAPTURED_PROVIDER_UNAVAILABLE" },
];

test.each(guardCases)("ASK-005 refuses $label before mutating the checkpoint", async ({ label, code }) => {
  const { project, providerPath } = createClarificationProject("ask-005");
  configureSinglePauseNode(project);
  const referencePath = path.join(project, "workspace.md");
  const manifestPath = path.join(project, "references.json");
  writeFileSync(referencePath, "captured workspace content\n", "utf8");
  writeFileSync(manifestPath, JSON.stringify({ references: [{ path: "workspace.md", mode: "workspace" }] }), "utf8");
  try {
    const initial = await runWorkflow(createClarificationRunRequest(project, undefined, "references.json"), fixtureProvider(project));
    expect(initial.status).toBe("needs_input");
    const runDirectory = path.join(project, ".nodulus", "runs", initial.runId);
    const pending = JSON.parse(readFileSync(path.join(runDirectory, "pending", "request.json"), "utf8"));
    const before = snapshot(runDirectory, pending.id);
    const callLogBefore = readFileSync(path.join(project, ".nodulus", "fixtures", "calls.jsonl"), "utf8");
    if (label === "workspace reference drift") writeFileSync(referencePath, "changed after pause\n", "utf8");
    if (label === "incompatible engine version" || label === "incompatible schema version") {
      const definitionsPath = path.join(runDirectory, "context", "definitions.json");
      const definitions = JSON.parse(readFileSync(definitionsPath, "utf8"));
      if (label === "incompatible engine version") definitions.engineVersion = "incompatible";
      else definitions.schemaVersion = 999;
      writeFileSync(definitionsPath, `${JSON.stringify(definitions, null, 2)}\n`, "utf8");
    }
    if (label === "unavailable captured provider") rmSync(providerPath, { force: true });

    const error = await resumeWorkflow({
      projectRoot: project,
      runId: initial.runId,
      requestId: pending.id,
      answers: { confirmed: true },
    }, fixtureProvider(project)).then(() => null, (failure: unknown) => failure as { code?: string; message?: string });
    expect(error).toMatchObject({ code });
    expect(error?.message).toMatch(/workspace|engine|schema|provider|available|changed/i);
    expect(snapshot(runDirectory, pending.id)).toEqual(before);
    expect(readFileSync(path.join(project, ".nodulus", "fixtures", "calls.jsonl"), "utf8")).toBe(callLogBefore);
  } finally {
    cleanupClarificationProject(project);
  }
});

function snapshot(runDirectory: string, requestId: string): Record<string, string | null> {
  const paths = ["run.json", "pending/request.json", `answers/${requestId}.json`, "events.jsonl"];
  const answerFiles = path.join(runDirectory, "answers");
  try {
    paths.push(...readdirSync(answerFiles).map((name) => `answers/${name}`));
  } catch { /* no answers saved yet */ }
  return Object.fromEntries([...new Set(paths)].map((relative) => {
    try { return [relative, readFileSync(path.join(runDirectory, relative), "utf8")]; }
    catch { return [relative, null]; }
  }));
}

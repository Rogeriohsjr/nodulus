import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createIntake } from "../../src/core/intake-request.js";
import { inspectWorkflowDefinition } from "../../src/core/inspect-workflow.js";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";

const projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true }); });

const definition = {
  schemaVersion: 1, regionId: "content-review", startNode: "prepare", decisionNode: "review",
  decisionOutput: { name: "decision", contract: "workflow-decision.v1" }, continuationNode: "continue",
  routes: { FIX_DOCS: "docs", FIX_BUILD: "build", APPROVE: "continue" },
  reentrySafeNodes: ["prepare", "docs", "build", "review"],
  limits: { maxIterations: 2, maxProviderCalls: 12, maxElapsedMs: 3600000 },
};

function project(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nodulus-fb-010-")); projects.push(root);
  const base = path.join(root, ".nodulus");
  for (const dir of ["workflows", "nodes", "contracts", "instructions", "validators", "runs"]) mkdirSync(path.join(base, dir), { recursive: true });
  writeJson(root, ".nodulus/settings.json", { schemaVersion: 1, defaultWorkflow: "example", providerProfiles: { fixture: { enabled: true, executable: process.execPath, model: "fixture" } } });
  writeJson(root, ".nodulus/contracts/request.v1.schema.json", { type: "string", minLength: 1 });
  const ids = ["prepare", "docs", "build", "review", "continue"];
  const outs = ["prepared", "readme", "build", "decision", "continued"];
  const contracts = ["prepared.v1", "readme.v1", "build.v1", "workflow-decision.v1", "continued.v1"];
  for (const [i, id] of ids.entries()) {
    writeJson(root, `.nodulus/contracts/${contracts[i]}.schema.json`, { type: "object", additionalProperties: true });
    writeFileSync(path.join(base, "instructions", `${id}.md`), "fixture instructions", "utf8");
    writeJson(root, `.nodulus/nodes/${id}.json`, { schemaVersion: 1, id, providerProfile: "fixture", instructions: [`.nodulus/instructions/${id}.md`], inputs: { source: { from: id === "prepare" ? "request" : `${ids[i - 1]}.${outs[i - 1]}`, contract: i ? contracts[i - 1] : "request.v1" } }, expectedOutputs: [{ name: outs[i], contract: contracts[i] }] });
  }
  writeJson(root, ".nodulus/workflows/example.json", { schemaVersion: 1, id: "example", nodes: ids, feedbackRouting: definition });
  return root;
}
function writeJson(root: string, relative: string, value: unknown): void { writeFileSync(path.join(root, relative), JSON.stringify(value), "utf8"); }

test("FB-010 accepts and returns a strict feedback definition without side effects", async () => {
  const root = project();
  const before = readFileSync(path.join(root, ".nodulus/workflows/example.json"), "utf8");
  const inspected = await inspectWorkflowDefinition(root, "example", new LocalIntakeStorage());
  expect((inspected.workflow as Record<string, unknown>).feedbackRouting).toEqual(definition);
  expect(readFileSync(path.join(root, ".nodulus/workflows/example.json"), "utf8")).toBe(before);
  expect((await import("node:fs")).readdirSync(path.join(root, ".nodulus/runs"))).toEqual([]);

  const storage = new LocalIntakeStorage();
  const intake = await createIntake({ projectRoot: root, cwd: root, workflow: "example", sources: [{ kind: "inline", text: "request" }] }, storage);
  const captured = JSON.parse(await storage.readRunFile(root, intake.runId, "context/definitions.json")) as { workflow: { feedbackRouting: unknown } };
  expect(captured.workflow.feedbackRouting).toEqual(definition);
});

test("FB-010 rejects malformed definitions before creating a run", async () => {
  const root = project();
  const workflowPath = path.join(root, ".nodulus/workflows/example.json");
  const original = JSON.parse(readFileSync(workflowPath, "utf8")) as Record<string, unknown>;
  const invalid: unknown[] = [
    {}, { ...definition, extra: true }, { ...definition, regionId: "" }, { ...definition, regionId: "bad/id" },
    { ...definition, routes: {} },
    { ...definition, reentrySafeNodes: ["prepare", "prepare", "review"] },
    { ...definition, reentrySafeNodes: ["prepare", "ghost", "review"] },
    { ...definition, routes: { FIX_DOCS: "ghost", APPROVE: "continue" } },
    { ...definition, routes: { FIX_DOCS: "build", APPROVE: "continue" }, reentrySafeNodes: ["prepare", "review"] },
    { ...definition, startNode: "review" }, { ...definition, continuationNode: "build" },
    { ...definition, decisionOutput: { name: "missing", contract: "workflow-decision.v1" } },
    { ...definition, decisionOutput: { name: "decision", contract: "other.v1" } },
    ...[0, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ ...definition, limits: { ...definition.limits, maxIterations: value } })),
  ];
  for (const candidate of invalid) {
    writeJson(root, ".nodulus/workflows/example.json", { ...original, feedbackRouting: candidate });
    await expect(inspectWorkflowDefinition(root, "example", new LocalIntakeStorage())).rejects.toThrow();
    await expect(createIntake({ projectRoot: root, cwd: root, workflow: "example", sources: [{ kind: "inline", text: "request" }] }, new LocalIntakeStorage())).rejects.toThrow();
    expect((await import("node:fs")).readdirSync(path.join(root, ".nodulus/runs"))).toEqual([]);
  }
});

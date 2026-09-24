import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { intakeRequest } from "../../src/application/intake.js";
import { createInitializedProject } from "../support/intake-project.js";

test.each([
  ["missing instructions", (project: string) => writeJson(project, ".nodulus/nodes/example.json", { schemaVersion: 1, id: "example", providerProfile: "fixture", instructions: [".nodulus/instructions/missing.md"], inputs: {}, expectedOutputs: [{ name: "example", contract: "example.v1" }] })],
  ["invalid workflow schema", (project: string) => writeJson(project, ".nodulus/workflows/example.json", { schemaVersion: 99, id: "example", nodes: ["example"] })],
  ["unknown provider profile", (project: string) => writeJson(project, ".nodulus/nodes/example.json", { ...readJson(project, ".nodulus/nodes/example.json"), providerProfile: "not-configured" })],
  ["invalid node input mapping", (project: string) => writeJson(project, ".nodulus/nodes/example.json", { ...readJson(project, ".nodulus/nodes/example.json"), inputs: { task: { from: "unknown-node.result" } } })],
])("REQ-004 rejects %s during preflight without creating a run", async (_caseName, alterProject) => {
  const project = createInitializedProject("req-004");
  const caller = mkdtempSync(path.join(tmpdir(), "nodulus-caller-"));
  alterProject(project);

  try {
    const failure = await intakeRequest({
      projectRoot: project,
      cwd: caller,
      workflow: "example",
      sources: [{ kind: "inline", text: "Review this." }],
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "CONFIGURATION_INVALID", message: expect.stringMatching(/\S/) });
    if (_caseName === "missing instructions") {
      expect((failure as Error).message).toContain(".nodulus/instructions/missing.md");
    }
    const runRoot = path.join(project, ".nodulus", "runs");
    expect(existsSync(runRoot) ? readdirSync(runRoot) : []).toEqual([]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

function readJson(project: string, relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(project, relative), "utf8")) as Record<string, unknown>;
}

function writeJson(project: string, relative: string, value: unknown): void {
  writeFileSync(path.join(project, relative), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

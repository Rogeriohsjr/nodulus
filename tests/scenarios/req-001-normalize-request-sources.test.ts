import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { intakeRequest, type RequestSource } from "../../src/application/intake.js";
import { createInitializedProject } from "../support/intake-project.js";

const request = "Review the café workflow.\nKeep every line; do not expand $HOME or `echo`.\n";

const sourceCases: Array<[string, (caller: string) => RequestSource[]]> = [
  ["inline", (caller: string) => [{ kind: "inline" as const, text: request }]],
  ["UTF-8 file", (caller: string) => {
    writeFileSync(path.join(caller, "brief with spaces.md"), request, "utf8");
    return [{ kind: "file" as const, path: "brief with spaces.md" }];
  }],
  ["stdin", (_caller: string) => [{ kind: "stdin" as const, text: request }]],
];

test.each(sourceCases)("REQ-001 preserves the exact %s request", async (_sourceName, makeSources) => {
  const project = createInitializedProject("req-001");
  const caller = mkdtempSync(path.join(tmpdir(), "nodulus-caller-"));
  try {
    const run = await intakeRequest({
      projectRoot: project,
      cwd: caller,
      workflow: "example",
      sources: makeSources(caller),
    });
    expect(run.runId).toMatch(/\S/);
    expect(readFileSync(path.join(run.runDirectory, "request.md"), "utf8")).toBe(request);
    const inputs = JSON.parse(readFileSync(path.join(run.runDirectory, "inputs.json"), "utf8"));
    expect(inputs).toMatchObject({ request });
    const checkpoint = JSON.parse(readFileSync(path.join(run.runDirectory, "run.json"), "utf8"));
    expect(checkpoint).toMatchObject({ runId: run.runId, phase: "intake", workflow: "example" });
    const events = readFileSync(path.join(run.runDirectory, "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(events).toEqual([{ event: "run.intake.completed", runId: run.runId, workflow: "example" }]);
    const context = JSON.parse(readFileSync(path.join(run.runDirectory, "context/definitions.json"), "utf8"));
    expect(context.workflow.id).toBe("example");
    expect(context.nodes[0].id).toBe("example");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

test("REQ-001 assigns a distinct internal run ID to each accepted source", async () => {
  const project = createInitializedProject("req-001-distinct");
  const caller = mkdtempSync(path.join(tmpdir(), "nodulus-caller-"));
  try {
    const common = { projectRoot: project, cwd: caller, workflow: "example" };
    const inline = await intakeRequest({ ...common, sources: [{ kind: "inline", text: request }] });
    const stdin = await intakeRequest({ ...common, sources: [{ kind: "stdin", text: request }] });
    writeFileSync(path.join(caller, "brief.md"), request, "utf8");
    const file = await intakeRequest({ ...common, sources: [{ kind: "file", path: "brief.md" }] });
    expect(new Set([inline.runId, stdin.runId, file.runId]).size).toBe(3);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

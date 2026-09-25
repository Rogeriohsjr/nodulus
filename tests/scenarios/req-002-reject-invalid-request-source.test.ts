import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { intakeRequest, type RequestSource } from "../../src/application/intake.js";
import { createInitializedProject } from "../support/intake-project.js";

const sourceCases: Array<[string, (caller: string) => RequestSource[]]> = [
  ["missing source", () => []],
  ["conflicting sources", () => [
    { kind: "inline", text: "one" },
    { kind: "stdin", text: "two" },
  ]],
  ["unreadable file", (caller) => [{ kind: "file", path: path.join(caller, "missing.md") }]],
];

test.each(sourceCases)("REQ-002 rejects %s before creating a run", async (_caseName, makeSources) => {
  const project = createInitializedProject("req-002");
  const caller = mkdtempSync(path.join(tmpdir(), "nodulus-caller-"));
  try {
    await expect(
      intakeRequest({
        projectRoot: project,
        cwd: caller,
        workflow: "example",
        sources: makeSources(caller),
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_SOURCE_INVALID",
      message: expect.stringMatching(/\S/),
    });
    const runRoot = path.join(project, ".nodulus", "runs");
    expect(existsSync(runRoot) ? readdirSync(runRoot) : []).toEqual([]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

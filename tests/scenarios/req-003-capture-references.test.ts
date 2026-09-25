import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { intakeRequest } from "../../src/application/intake.js";
import { createInitializedProject } from "../support/intake-project.js";

test("REQ-003 resolves manifest references from the project root and records hash and content policy", async () => {
  const project = createInitializedProject("req-003");
  const caller = mkdtempSync(path.join(tmpdir(), "nodulus-caller-"));
  const source = "project-root café/分析 notes.md";
  const content = "Keep this exact snapshot.\n";
  const referencePath = path.join(project, source);
  const referencesFile = "reference list.json";
  mkdirSync(path.dirname(referencePath), { recursive: true });
  writeFileSync(referencePath, content, "utf8");
  writeFileSync(
    path.join(caller, referencesFile),
    JSON.stringify({ references: [{ path: source, mode: "snapshot" }, { path: source, mode: "workspace" }] }),
    "utf8",
  );

  try {
    const run = await intakeRequest({
      projectRoot: project,
      cwd: caller,
      workflow: "example",
      sources: [{ kind: "inline", text: "Review the reference." }],
      referencesFile,
    });
    const references = JSON.parse(readFileSync(path.join(run.runDirectory, "references.json"), "utf8"));
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    expect(references).toEqual([
      { path: referencePath, mode: "snapshot", sha256: digest, content },
      { path: referencePath, mode: "workspace", sha256: digest },
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

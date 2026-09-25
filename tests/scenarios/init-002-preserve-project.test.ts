import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runProductionCli } from "../support/production-cli.js";

test("INIT-002 preserves edited project files and adds only missing defaults", () => {
  const project = mkdtempSync(path.join(tmpdir(), "nodulus-init-002-"));
  const nestedCwd = path.join(project, "nested", "caller");

  try {
    mkdirSync(nestedCwd, { recursive: true });
    const initial = runProductionCli(["init", "--project", project]);
    expect(initial.error).toBeUndefined();
    expect(initial.status, initial.stderr).toBe(0);

    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const instructionsPath = path.join(project, ".nodulus", "instructions", "example.md");
    const gitignorePath = path.join(project, ".gitignore");
    const missingDefault = path.join(project, ".nodulus", "contracts", "example.v1.schema.json");
    const editedSettings = `${JSON.stringify(
      {
        schemaVersion: 1,
        defaultWorkflow: "example",
        providerProfiles: {},
        userNote: "keep this setting",
      },
      null,
      2,
    )}\n`;
    const editedInstructions = "# My edited instructions\n\nKeep these exact words.\n";
    const existingIgnore = "# local rules\n*.private\n";
    writeFileSync(settingsPath, editedSettings, "utf8");
    writeFileSync(instructionsPath, editedInstructions, "utf8");
    writeFileSync(gitignorePath, existingIgnore, "utf8");
    unlinkSync(missingDefault);

    const relativeProject = path.relative(nestedCwd, project);
    const second = runProductionCli(["init", "--project", relativeProject], { cwd: nestedCwd });
    expect(second.error).toBeUndefined();
    expect(second.status, second.stderr).toBe(0);

    expect(readFileSync(settingsPath, "utf8")).toBe(editedSettings);
    expect(readFileSync(instructionsPath, "utf8")).toBe(editedInstructions);
    expect(readFileSync(gitignorePath, "utf8")).toBe(`${existingIgnore}.nodulus/runs/\n`);
    expect(readFileSync(gitignorePath, "utf8").match(/\.nodulus\/runs\//g)).toHaveLength(1);
    expect(readFileSync(missingDefault, "utf8")).toContain('"$schema"');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

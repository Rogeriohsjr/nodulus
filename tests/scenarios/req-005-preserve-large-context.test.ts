import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { intakeRequest } from "../../src/application/intake.js";
import { createInitializedProject } from "../support/intake-project.js";

test("REQ-005 preserves a large request and ordered instruction files literally", async () => {
  const project = createInitializedProject("req-005");
  const caller = mkdtempSync(path.join(tmpdir(), "nodulus-caller-"));
  const settingsPath = path.join(project, ".nodulus/settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles.fixture = {
    ...settings.providerProfiles.fixture,
    model: "local-fixture-model",
    timeoutMs: 4321,
    apiKey: "do-not-persist-this-credential",
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const first = "# First instruction\nDo not interpolate $HOME, `echo unsafe`, or ${VALUE}.\n";
  const second = `# Second instruction\n${"ordered context line\n".repeat(12_000)}END-OF-CONTEXT\n`;
  const secondPath = ".nodulus/instructions/second.md";
  writeFileSync(path.join(project, secondPath), second, "utf8");
  writeFileSync(path.join(project, ".nodulus/instructions/example.md"), first, "utf8");
  const nodePath = path.join(project, ".nodulus/nodes/example.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  node.instructions = [".nodulus/instructions/example.md", secondPath];
  writeFileSync(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");
  const request = `# Long request\n${"preserve every request line\n".repeat(20_000)}END-OF-REQUEST\n`;
  const requestPath = path.join(caller, "large brief.md");
  writeFileSync(requestPath, request, "utf8");

  try {
    const run = await intakeRequest({
      projectRoot: project,
      cwd: caller,
      workflow: "example",
      sources: [{ kind: "file", path: requestPath }],
    });
    expect(readFileSync(path.join(run.runDirectory, "request.md"), "utf8")).toBe(request);
    const inputs = JSON.parse(readFileSync(path.join(run.runDirectory, "inputs.json"), "utf8"));
    expect(inputs.instructions).toEqual([
      { path: path.join(project, ".nodulus/instructions/example.md"), content: first },
      { path: path.join(project, secondPath), content: second },
    ]);
    const context = JSON.parse(readFileSync(path.join(run.runDirectory, "context/definitions.json"), "utf8"));
    expect(context.providerProfiles).toEqual({
      fixture: {
        enabled: true,
        executable: process.execPath,
        model: "local-fixture-model",
        timeoutMs: 4321,
      },
    });
    expect(JSON.stringify(context.providerProfiles)).not.toContain("do-not-persist-this-credential");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});

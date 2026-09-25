import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import type { ProviderInvocation } from "../../src/application/run-workflow.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureSequenceProject, sequenceRunRequest, sequenceSuccess } from "../support/workflow-sequence.js";

test("FLOW-004 keeps captured profile options stable mid-run and reads edits for the next run", async () => {
  const project = createInitializedProject("flow-004");
  configureSequenceProject(project, ["analyze", "build"]);
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const changeProfile = (model: string, timeoutMs: number): void => {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.providerProfiles.fixture = { ...settings.providerProfiles.fixture, model, timeoutMs };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  };
  const responses: Record<string, string> = {
    analyze: sequenceSuccess("analysis result", "findings", "finding.v1"),
    build: sequenceSuccess("implementation result", "implementation", "implementation.v1"),
  };
  const runAndCapture = async (onFirst?: () => void): Promise<ProviderInvocation[]> => {
    const calls: ProviderInvocation[] = [];
    const result = await runWorkflow(sequenceRunRequest(project), {
      async invoke(invocation) {
        calls.push(invocation);
        if (calls.length === 1) onFirst?.();
        return responses[invocation.nodeId];
      },
    });
    expect(result.status).toBe("success");
    return calls;
  };

  try {
    const firstRun = await runAndCapture(() => changeProfile("changed-during-run", 9000));
    expect(firstRun.map((call) => call.providerProfile)).toEqual([
      { enabled: true, executable: process.execPath, model: "captured-model", timeoutMs: 5000 },
      { enabled: true, executable: process.execPath, model: "captured-model", timeoutMs: 5000 },
    ]);

    const secondRun = await runAndCapture();
    expect(secondRun.map((call) => call.providerProfile)).toEqual([
      { enabled: true, executable: process.execPath, model: "changed-during-run", timeoutMs: 9000 },
      { enabled: true, executable: process.execPath, model: "changed-during-run", timeoutMs: 9000 },
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

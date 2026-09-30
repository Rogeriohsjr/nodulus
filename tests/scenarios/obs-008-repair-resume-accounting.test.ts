import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { getRunStatus } from "../../src/application/resume-workflow.js";
import {
  cleanupProviderProject,
  createProviderScenario,
  readProviderCalls,
} from "../support/provider-adapter-scenarios.js";

// Supervisor-integrated after the local Qwen test packet exhausted its output and timeout budgets.
test("OBS-008 includes response repairs once and does not recount them on fresh-process resume", async () => {
  const { project, logPath } = await createProviderScenario("opencode", "repair-multiple");
  const config = path.join(project, ".nodulus");
  const runCli = (args: string[]) => spawnSync(
    process.execPath,
    [path.resolve("dist/bin.js"), ...args],
    { cwd: project, encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );

  try {
    writeFileSync(
      path.join(config, "fixtures", "opencode-fixture.mjs"),
      readFileSync(new URL("../fixtures/observability/repair-resume-provider.mjs", import.meta.url), "utf8"),
      "utf8",
    );
    const node = JSON.parse(readFileSync(path.join(config, "nodes", "example.json"), "utf8"));
    writeFileSync(path.join(config, "nodes", "second.json"), `${JSON.stringify({ ...node, id: "second" }, null, 2)}\n`, "utf8");
    writeFileSync(
      path.join(config, "workflows", "example.json"),
      `${JSON.stringify({ schemaVersion: 1, id: "example", nodes: ["example", "second"] }, null, 2)}\n`,
      "utf8",
    );

    const initialProcess = runCli(["run", "--project", project, "--request", "accounting", "--json"]);
    expect(initialProcess.error).toBeUndefined();
    expect(initialProcess.status, `${initialProcess.stdout}\n${initialProcess.stderr}`).toBe(2);
    const initial = JSON.parse(initialProcess.stdout);
    expect(initial.status).toBe("needs_input");
    const runId = initial.runId as string;
    const runDirectory = path.join(config, "runs", runId);
    const pending = JSON.parse(readFileSync(path.join(runDirectory, "pending", "request.json"), "utf8"));
    const answers = path.join(config, "answers.json");
    writeFileSync(answers, `${JSON.stringify({ confirmed: true })}\n`, "utf8");

    const resumeProcess = runCli([
      "resume",
      runId,
      "--project",
      project,
      "--request-id",
      pending.id,
      "--answers-file",
      answers,
      "--json",
    ]);
    expect(resumeProcess.error).toBeUndefined();
    expect(resumeProcess.status, resumeProcess.stderr).toBe(0);
    expect(JSON.parse(resumeProcess.stdout)).toMatchObject({ status: "success", runId });

    const status = await getRunStatus(project, runId);
    const calls = status.metrics!.calls;
    expect(calls).toHaveLength(5);
    expect(new Set(calls.map((call) => call.callId)).size).toBe(5);
    expect(calls.every((call) => typeof call.callId === "string" && call.callId.length > 0)).toBe(true);
    expect(calls.map((call) => call.operation)).toEqual([
      "invoke",
      "invoke",
      "repair_response",
      "repair_response",
      "invoke",
    ]);
    expect(calls.filter((call) => call.nodeId === "example")).toHaveLength(1);
    expect(calls.filter((call) => call.nodeId === "second")).toHaveLength(4);
    expect(status.metrics!.totals).toEqual({
      inputTokens: 60,
      outputTokens: 12,
      cacheReadTokens: 0,
      costUsd: 0,
    });
    expect(status.metrics!.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "example", provider: "opencode", reportedModel: null, callCount: 1 }),
      expect.objectContaining({ nodeId: "second", provider: "opencode", reportedModel: null, callCount: 4 }),
    ]));

    const fixtureCalls = readProviderCalls(logPath);
    expect(fixtureCalls).toHaveLength(5);
    expect(fixtureCalls[2].stdin).toContain('{"first-invalid":');
    expect(fixtureCalls[2].stdin).toContain("Validation errors:");
    expect(fixtureCalls[3].stdin).toContain('{"second-invalid":');
    expect(fixtureCalls[3].stdin).toContain("Validation errors:");

    const metricsBeforeReads = readFileSync(path.join(runDirectory, "metrics.json"), "utf8");
    const logBeforeReads = readFileSync(logPath, "utf8");
    for (let index = 0; index < 2; index += 1) {
      const statusProcess = runCli(["status", runId, "--project", project, "--json"]);
      expect(statusProcess.status, statusProcess.stderr).toBe(0);
      expect(JSON.parse(statusProcess.stdout)).toMatchObject({ result: { status: "success" } });
    }
    const terminalResume = runCli([
      "resume",
      runId,
      "--project",
      project,
      "--request-id",
      pending.id,
      "--answers-file",
      answers,
      "--json",
    ]);
    expect(terminalResume.status).not.toBe(0);
    expect(readFileSync(path.join(runDirectory, "metrics.json"), "utf8")).toBe(metricsBeforeReads);
    expect(readFileSync(logPath, "utf8")).toBe(logBeforeReads);
  } finally {
    cleanupProviderProject(project);
  }
}, 40_000);

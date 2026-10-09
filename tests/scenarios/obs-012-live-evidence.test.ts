import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { arch as osArch, platform as osPlatform, release as osRelease } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { getRunStatus } from "../../src/application/resume-workflow.js";
import { collectLiveEvidence } from "../support/live-provider-observability.js";
import { createUsageScenario, jsonLines, usageOutcome } from "../support/observability-usage.js";
import { cleanupProviderProject, readProviderCalls, runDefaultProviderCli } from "../support/provider-adapter-scenarios.js";

test("OBS-012 collector projects safe evidence and verifies the persisted run", async () => {
  const event = {
    type: "step_finish",
    part: {
      id: "baseline-step",
      sessionID: "baseline-session",
      messageID: "baseline-message",
      reason: "stop",
      tokens: { input: 100, output: 20, reasoning: 4, cache: { read: 30, write: 5 } },
      cost: 0.001,
    },
  };
  const scenario = await createUsageScenario("opencode", jsonLines([event, { type: "text", part: { messageID: "baseline-message", text: usageOutcome } }]));
  try {
    const requestSentinel = "OBS012 request private sentinel";
    const run = await runDefaultProviderCli(scenario.project, requestSentinel);
    expect(run.code).toBe(0);
    expect(readProviderCalls(scenario.logPath)).toHaveLength(1);
    const status = await getRunStatus(scenario.project, run.envelope.runId);
    const call = status.metrics!.calls[0]!;
    const runRoot = path.join(scenario.project, ".nodulus", "runs", run.envelope.runId);
    const beforeCollection = hashDirectory(runRoot);
    const evidence = collectLiveEvidence({
      projectRoot: scenario.project,
      runId: run.envelope.runId,
      status,
      metadata: { packageVersion: "1.0.0", archiveSha256: "fixture-archive-sha256", model: "ollama/qwen3.5:9b", endpointOrigin: "http://127.0.0.1:11434" },
    });
    const callRoot = path.join(runRoot, "calls", call.callId);
    const captured = readProviderCalls(scenario.logPath)[0];
    const refs = (evidence as unknown as Record<string, unknown>)["refs"] as Record<string, string>;
    expect(evidence).toMatchObject({
      provider: call.telemetry!.provider,
      reportedModel: call.telemetry!.reportedModel ?? null,
      os: { platform: osPlatform(), arch: osArch(), release: osRelease() },
      nodeVersion: process.version,
    });
    expect(refs).toEqual({
      request: `calls/${call.callId}/request.json`,
      stdin: `calls/${call.callId}/stdin.txt`,
      transport: `calls/${call.callId}/transport.json`,
      telemetry: `calls/${call.callId}/telemetry.json`,
      prompt: `nodes/${call.nodeId}/attempt-001/prompt.md`,
      response: `nodes/${call.nodeId}/attempt-001/response.raw.txt`,
      validation: `nodes/${call.nodeId}/attempt-001/validation.json`,
      result: `nodes/${call.nodeId}/attempt-001/result.json`,
    });
    for (const reference of Object.values(refs)) expect(existsSync(path.join(runRoot, reference))).toBe(true);
    expect(readFileSync(path.join(callRoot, "stdin.txt"), "utf8")).toBe(captured.stdin);
    expect(captured.stdin).toContain(requestSentinel);
    expect(JSON.parse(readFileSync(path.join(runRoot, refs["validation"]!), "utf8"))).toMatchObject({ valid: true });
    expect(JSON.parse(readFileSync(path.join(runRoot, refs["result"]!), "utf8"))).toMatchObject({ status: "success", artifacts: [{ data: { message: "usage fixture result" } }] });
    expect(JSON.parse(readFileSync(path.join(callRoot, "telemetry.json"), "utf8"))).toEqual(call.telemetry);
    expect(JSON.stringify(evidence)).not.toContain(requestSentinel);
    expect(JSON.stringify(evidence)).not.toContain("fixture-secret-must-not-be-captured");
    expect(JSON.stringify(evidence)).not.toContain(JSON.parse(readFileSync(path.join(callRoot, "transport.json"), "utf8")).stdout);
    expect(evidence).not.toHaveProperty("diagnostics");
    expect(hashDirectory(runRoot)).toBe(beforeCollection);
    expect(evidence).toEqual({
      schemaVersion: 1,
      packageVersion: "1.0.0",
      archiveSha256: "fixture-archive-sha256",
      runId: run.envelope.runId,
      callId: call.callId,
      provider: call.telemetry!.provider,
      model: "ollama/qwen3.5:9b",
      reportedModel: call.telemetry!.reportedModel ?? null,
      endpointOrigin: "http://127.0.0.1:11434",
      os: { platform: osPlatform(), arch: osArch(), release: osRelease() },
      nodeVersion: process.version,
      refs: {
        request: `calls/${call.callId}/request.json`,
        stdin: `calls/${call.callId}/stdin.txt`,
        transport: `calls/${call.callId}/transport.json`,
        telemetry: `calls/${call.callId}/telemetry.json`,
        prompt: `nodes/${call.nodeId}/attempt-001/prompt.md`,
        response: `nodes/${call.nodeId}/attempt-001/response.raw.txt`,
        validation: `nodes/${call.nodeId}/attempt-001/validation.json`,
        result: `nodes/${call.nodeId}/attempt-001/result.json`,
      },
      cliVersion: call.telemetry!.cliVersion,
      coverage: call.telemetry!.coverage,
      reported: call.telemetry!.reported,
      normalized: call.telemetry!.normalized,
    });
  } finally {
    cleanupProviderProject(scenario.project);
  }
});

test.each(["tampered-telemetry", "missing-validation", "invalid-validation", "missing-result", "invalid-result", "escaped-validation-ref", "absolute-result-ref"] as const)("OBS-012 rejects %s persisted evidence", async mode => {
  const event = { type: "step_finish", part: { id: "negative-step", sessionID: "negative-session", messageID: "negative-message", reason: "stop", tokens: { input: 100, output: 20, reasoning: 4, cache: { read: 30, write: 5 } }, cost: 0.001 } };
  const scenario = await createUsageScenario("opencode", jsonLines([event, { type: "text", part: { messageID: "negative-message", text: usageOutcome } }]));
  try {
    const run = await runDefaultProviderCli(scenario.project, "OBS012 negative request");
    expect(run.code).toBe(0);
    const status = await getRunStatus(scenario.project, run.envelope.runId);
    const call = status.metrics!.calls[0]!;
    const runRoot = path.join(scenario.project, ".nodulus", "runs", run.envelope.runId);
    const refs = {
      telemetry: path.join(runRoot, "calls", call.callId, "telemetry.json"),
      validation: path.join(runRoot, "nodes", call.nodeId, "attempt-001", "validation.json"),
      result: path.join(runRoot, "nodes", call.nodeId, "attempt-001", "result.json"),
      request: path.join(runRoot, "calls", call.callId, "request.json"),
    };
    if (mode === "tampered-telemetry") writeFileSync(refs.telemetry, JSON.stringify({ ...call.telemetry, reported: { ...call.telemetry!.reported, inputTokens: 999 } }));
    if (mode === "invalid-validation") writeFileSync(refs.validation, JSON.stringify({ valid: false }));
    if (mode === "invalid-result") writeFileSync(refs.result, JSON.stringify({ status: "error" }));
    if (mode === "missing-validation") unlinkSync(refs.validation);
    if (mode === "missing-result") unlinkSync(refs.result);
    if (mode === "escaped-validation-ref" || mode === "absolute-result-ref") {
      const requestRecord = JSON.parse(readFileSync(refs.request, "utf8")) as { refs: Record<string, string> };
      requestRecord.refs[mode === "escaped-validation-ref" ? "validation" : "result"] = mode === "escaped-validation-ref"
        ? "../../../../outside-validation.json"
        : path.resolve(scenario.project, "..", "outside-result.json");
      writeFileSync(refs.request, JSON.stringify(requestRecord));
    }
    expect(() => collectLiveEvidence({ projectRoot: scenario.project, runId: run.envelope.runId, status, metadata: { packageVersion: "1.0.0", archiveSha256: "fixture", model: "ollama/qwen3.5:9b" } })).toThrow();
  } finally {
    cleanupProviderProject(scenario.project);
  }
});

test("OBS-012 permits successful collection when optional usage is unavailable", async () => {
  const scenario = await createUsageScenario("cursor", JSON.stringify({ type: "result", subtype: "success", is_error: false, result: usageOutcome }));
  try {
    const run = await runDefaultProviderCli(scenario.project, "OBS012 no usage request");
    expect(run.code).toBe(0);
    const status = await getRunStatus(scenario.project, run.envelope.runId);
    const call = status.metrics!.calls[0]!;
    expect(call.telemetry!.coverage).toBe("unavailable");
    expect(call.telemetry!.reported).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: null });
    const runRoot = path.join(scenario.project, ".nodulus", "runs", run.envelope.runId);
    const beforeCollection = hashDirectory(runRoot);
    const evidence = collectLiveEvidence({ projectRoot: scenario.project, runId: run.envelope.runId, status, metadata: { packageVersion: "1.0.0", archiveSha256: "fixture", model: null } });
    expect(evidence.reported).toEqual(call.telemetry!.reported);
    expect(hashDirectory(runRoot)).toBe(beforeCollection);
  } finally {
    cleanupProviderProject(scenario.project);
  }
});

function hashDirectory(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const fullPath = path.join(directory, name);
      const relativePath = path.relative(root, fullPath).replaceAll(path.sep, "/");
      if (statSync(fullPath).isDirectory()) visit(fullPath);
      else hash.update(relativePath).update("\0").update(readFileSync(fullPath));
    }
  };
  visit(root);
  return hash.digest("hex");
}

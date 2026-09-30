import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { getRunStatus } from "../../src/application/resume-workflow.js";
import { runCli } from "../../src/cli.js";

type SavedRun = { project: string; runId: string; directory: string };

function saveRun(metrics: string | null, events = ""): SavedRun {
  const project = mkdtempSync(path.join(tmpdir(), "nodulus-obs009-"));
  const runId = randomUUID();
  const directory = path.join(project, ".nodulus", "runs", runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "run.json"), JSON.stringify({
    schemaVersion: 1,
    runId,
    status: "success",
    activeNode: null,
    completedNodes: [],
    attempt: 1,
  }), "utf8");
  writeFileSync(path.join(directory, "events.jsonl"), events, "utf8");
  if (metrics !== null) writeFileSync(path.join(directory, "metrics.json"), metrics, "utf8");
  return { project, runId, directory };
}

async function statusCli(run: SavedRun, json: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    ["node", "nodulus", "status", run.runId, "--project", run.project, ...(json ? ["--json"] : [])],
    { writeOut: (text) => { stdout += text; }, writeErr: (text) => { stderr += text; } },
    { cwd: run.project },
  );
  return { code, stdout, stderr };
}

// Supervisor-integrated after both bounded local-Qwen test drafts failed artifact validation.
test("OBS-009A exposes legacy field coverage without rewriting persisted history", async () => {
  const rows = [
    { nodeId: "a", attempt: 1, elapsedMs: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.01 } },
    { nodeId: "b", attempt: 1, elapsedMs: 1, usage: { inputTokens: null, outputTokens: 5, cacheReadTokens: 0, costUsd: null } },
  ];
  const run = saveRun(JSON.stringify(rows));
  const before = ["run.json", "events.jsonl", "metrics.json"].map((name) => readFileSync(path.join(run.directory, name), "utf8"));
  try {
    const status = JSON.parse(JSON.stringify(await getRunStatus(run.project, run.runId)));
    expect(status.status).toBe("success");
    expect(status.metrics.totals).toEqual({ inputTokens: null, outputTokens: 25, cacheReadTokens: 0, costUsd: null });
    expect(status.metrics.coverage.inputTokens).toEqual({ knownCalls: 1, totalCalls: 2, knownSubtotal: 100, total: null });
    expect(status.metrics.coverage.outputTokens).toEqual({ knownCalls: 2, totalCalls: 2, knownSubtotal: 25, total: 25 });
    expect(status.metrics.coverage.costUsd).toEqual({ knownCalls: 1, totalCalls: 2, knownSubtotal: 0.01, total: null });
    expect(status.metrics.origins).toEqual(["legacy_adapter", "legacy_adapter"]);
    expect(JSON.parse(JSON.stringify(await getRunStatus(run.project, run.runId))).metrics.coverage).toEqual(status.metrics.coverage);

    const jsonResult = await statusCli(run, true);
    expect(jsonResult.code, jsonResult.stderr).toBe(0);
    expect(JSON.parse(jsonResult.stdout).result.metrics.coverage).toEqual(status.metrics.coverage);
    const textResult = await statusCli(run, false);
    expect(textResult.code, textResult.stderr).toBe(0);
    expect(textResult.stdout).toContain("Input tokens: unknown (known 1/2; subtotal 100)");
    expect(["run.json", "events.jsonl", "metrics.json"].map((name) => readFileSync(path.join(run.directory, name), "utf8"))).toEqual(before);
  } finally {
    rmSync(run.project, { recursive: true, force: true });
  }
});

test("OBS-009C labels missing metrics unavailable without inventing zero totals", async () => {
  const run = saveRun(null);
  try {
    const status = JSON.parse(JSON.stringify(await getRunStatus(run.project, run.runId)));
    expect(status.metrics.calls).toEqual([]);
    expect(status.metrics.coverage.inputTokens).toEqual({ knownCalls: 0, totalCalls: 0, knownSubtotal: 0, total: null });
    expect(status.metrics.totals.inputTokens).toBeNull();
    expect(status.diagnostics.messages.join(" ")).toContain("metrics.json");
  } finally {
    rmSync(run.project, { recursive: true, force: true });
  }
});

test("OBS-009D deduplicates finalized call IDs and counts unmatched starts as unknown", async () => {
  const first = randomUUID();
  const pending = randomUUID();
  const metric = { callId: first, nodeId: "a", attempt: 1, elapsedMs: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.01 } };
  const events = [first, pending].map((callId) => JSON.stringify({ event: "provider.call.started", callId, nodeId: "a" })).join("\n") + "\n";
  const run = saveRun(JSON.stringify([metric, metric]), events);
  try {
    const status = JSON.parse(JSON.stringify(await getRunStatus(run.project, run.runId)));
    expect(status.metrics.calls).toHaveLength(1);
    expect(status.metrics.coverage.inputTokens).toEqual({ knownCalls: 1, totalCalls: 2, knownSubtotal: 100, total: null });
    expect(status.diagnostics.messages.join(" ")).toContain("duplicate callId");
    expect(status.callEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: pending, status: "incomplete" }),
    ]));
  } finally {
    rmSync(run.project, { recursive: true, force: true });
  }
});

test("OBS-009E isolates malformed rows and invalid fields", async () => {
  const run = saveRun(JSON.stringify([
    null,
    { nodeId: "a", attempt: 1, elapsedMs: 1, usage: { inputTokens: -1, outputTokens: 0.5, cacheReadTokens: "2", costUsd: -1 } },
  ]));
  try {
    const status = JSON.parse(JSON.stringify(await getRunStatus(run.project, run.runId)));
    expect(status.metrics.totals).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null });
    expect(status.metrics.coverage.inputTokens).toEqual({ knownCalls: 0, totalCalls: 1, knownSubtotal: 0, total: null });
    expect(status.diagnostics.messages.length).toBeGreaterThan(0);
  } finally {
    rmSync(run.project, { recursive: true, force: true });
  }
});

test("OBS-009F conflicting duplicate call IDs invalidate the call's aggregate", async () => {
  const callId = randomUUID();
  const base = { callId, nodeId: "a", attempt: 1, elapsedMs: 1 };
  const run = saveRun(JSON.stringify([
    { ...base, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.01 } },
    { ...base, usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.01 } },
  ]));
  try {
    const status = JSON.parse(JSON.stringify(await getRunStatus(run.project, run.runId)));
    expect(status.metrics.calls).toHaveLength(1);
    expect(status.metrics.coverage.inputTokens).toEqual({ knownCalls: 0, totalCalls: 1, knownSubtotal: 0, total: null });
    expect(status.diagnostics.messages.join(" ")).toContain("conflicting duplicate callId");
  } finally {
    rmSync(run.project, { recursive: true, force: true });
  }
});

test("OBS-009G unmatched starts make every finalized group for that node incomplete", async () => {
  const finalized = randomUUID();
  const pending = randomUUID();
  const metric = { callId: finalized, nodeId: "a", attempt: 1, elapsedMs: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.01 } };
  const events = [finalized, pending].map((callId) => JSON.stringify({ event: "provider.call.started", callId, nodeId: "a" })).join("\n") + "\n";
  const run = saveRun(JSON.stringify([metric]), events);
  try {
    const status = JSON.parse(JSON.stringify(await getRunStatus(run.project, run.runId)));
    expect(status.metrics.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: "a",
        coverage: expect.objectContaining({
          inputTokens: { knownCalls: 1, totalCalls: 2, knownSubtotal: 100, total: null },
        }),
      }),
    ]));
  } finally {
    rmSync(run.project, { recursive: true, force: true });
  }
});

test("OBS-009H malformed telemetry cannot claim provider-event provenance", async () => {
  const run = saveRun(JSON.stringify([
    {
      callId: randomUUID(),
      nodeId: "a",
      attempt: 1,
      elapsedMs: 1,
      telemetry: {
        schemaVersion: 1,
        provider: "codex",
        reportedModel: "fictional",
        reported: {},
        normalized: {},
        coverage: "complete",
        source: {},
        semantics: {},
        diagnostics: [],
      },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.01 },
    },
  ]));
  try {
    const status = JSON.parse(JSON.stringify(await getRunStatus(run.project, run.runId)));
    expect(status.metrics.origins).toEqual(["legacy_adapter"]);
    expect(status.metrics.groups).toEqual([
      expect.objectContaining({ nodeId: "a", provider: null, reportedModel: null }),
    ]);
    expect(status.diagnostics.messages.join(" ")).toContain("invalid telemetry");
  } finally {
    rmSync(run.project, { recursive: true, force: true });
  }
});

test("OBS-009B reports corrupt metrics and event rows while keeping status readable", async () => {
  const events = `${JSON.stringify({ event: "node.started", nodeId: "a" })}\nnot-json\n{partial`;
  const run = saveRun("{broken", events);
  const before = ["run.json", "events.jsonl", "metrics.json"].map((name) => readFileSync(path.join(run.directory, name), "utf8"));
  try {
    const status = JSON.parse(JSON.stringify(await getRunStatus(run.project, run.runId)));
    expect(status.status).toBe("success");
    expect(status.metrics.calls).toEqual([]);
    expect(status.metrics.totals).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null });
    expect(status.diagnostics.incompleteTrailingEvent).toBe(true);
    expect(status.diagnostics.messages.join(" ")).toContain("metrics.json");
    expect(status.diagnostics.messages.join(" ")).toContain("events.jsonl");
    expect(["run.json", "events.jsonl", "metrics.json"].map((name) => readFileSync(path.join(run.directory, name), "utf8"))).toEqual(before);
  } finally {
    rmSync(run.project, { recursive: true, force: true });
  }
});

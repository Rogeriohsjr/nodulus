import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { LocalProjectFiles } from "../../src/adapters/storage/local-project-files.js";
import { getRunStatus } from "../../src/application/resume-workflow.js";
import { initializeProject } from "../../src/core/initialize-project.js";

const driver = path.resolve("tests/fixtures/observability/pricing-provider-driver.mjs");
const nodulusBin = path.resolve("dist/bin.js");

async function pricingProject(
  rateOverrides: Record<string, unknown> = {},
  includePricing = true,
): Promise<{ project: string; ratePath: string; logPath: string }> {
  const project = mkdtempSync(path.join(tmpdir(), "nodulus-pricing-"));
  await initializeProject(new LocalProjectFiles(project));
  const fixtures = path.join(project, ".nodulus", "fixtures");
  mkdirSync(fixtures, { recursive: true });
  const logPath = path.join(fixtures, "pricing-calls.jsonl");
  writeFileSync(logPath, "", "utf8");
  const ratePath = path.join(fixtures, "rates.json");
  writeFileSync(ratePath, JSON.stringify({
    schemaVersion: 1,
    rates: [{
      id: "fictional-v1",
      provider: "codex",
      reportedModel: "fictional-verified",
      inputPerMillion: 2,
      cacheReadPerMillion: 1,
      outputPerMillion: 4,
      ...rateOverrides,
    }],
  }), "utf8");
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles.fixture = { enabled: true, executable: "fixture", kind: "codex" };
  if (includePricing) {
    settings.observability = { pricing: { mode: "api", rateCard: ".nodulus/fixtures/rates.json", hypotheticalApiEquivalent: false } };
  }
  writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
  const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  node.providerProfile = "fixture";
  writeFileSync(nodePath, JSON.stringify(node), "utf8");
  return { project, ratePath, logPath };
}

function runDriver(args: string[], project: string) {
  return spawnSync(process.execPath, [driver, ...args], { cwd: project, encoding: "utf8", windowsHide: true, timeout: 20_000 });
}

test("OBS-010 snapshots pricing before inference and reuses it after fresh-process resume", async () => {
  const { project, ratePath, logPath } = await pricingProject();
  try {
    const originalRates = readFileSync(ratePath, "utf8");
    const initial = runDriver(["run", project], project);
    expect(initial.status, initial.stderr).toBe(0);
    const initialResult = JSON.parse(initial.stdout);
    expect(initialResult.status).toBe("needs_input");
    const runId = initialResult.runId as string;
    const runDirectory = path.join(project, ".nodulus", "runs", runId);
    const pending = JSON.parse(readFileSync(path.join(runDirectory, "pending", "request.json"), "utf8"));
    const captured = JSON.parse(readFileSync(path.join(runDirectory, "pricing.json"), "utf8"));
    expect(captured.hash).toBe(createHash("sha256").update(originalRates, "utf8").digest("hex"));

    writeFileSync(ratePath, JSON.stringify({ schemaVersion: 1, rates: [{ ...captured.rates[0], inputPerMillion: 999 }] }), "utf8");
    const resumed = runDriver(["resume", project, pending.id], project);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).status).toBe("success");

    const status = JSON.parse(JSON.stringify(await getRunStatus(project, runId)));
    expect(status.metrics.calls).toHaveLength(2);
    expect(status.metrics.totals.costUsd).toBe(0);
    expect(status.metrics.estimates.map((estimate: { usd: number | null }) => estimate.usd)).toEqual([expect.closeTo(0.0022), expect.closeTo(0.0022)]);
    expect(status.metrics.estimates.every((estimate: { snapshotHash: string }) => estimate.snapshotHash === captured.hash)).toBe(true);
    expect(status.metrics.estimateCoverage).toEqual({ knownCalls: 2, totalCalls: 2, knownSubtotal: expect.closeTo(0.0044), total: expect.closeTo(0.0044) });
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(readFileSync(path.join(runDirectory, "pricing.json"), "utf8"))).toEqual(captured);

    const textStatus = spawnSync(process.execPath, [nodulusBin, "status", runId, "--project", project], { cwd: project, encoding: "utf8", windowsHide: true });
    expect(textStatus.status, textStatus.stderr).toBe(0);
    expect(textStatus.stdout).toContain("Reported cost USD: 0");
    expect(textStatus.stdout).toContain("Estimated cost USD: 0.0044");

    const tampered = { ...captured, rates: [{ ...captured.rates[0], inputPerMillion: 999 }] };
    writeFileSync(path.join(runDirectory, "pricing.json"), JSON.stringify(tampered), "utf8");
    const tamperedStatus = JSON.parse(JSON.stringify(await getRunStatus(project, runId)));
    expect(tamperedStatus.metrics.estimates).toBeUndefined();
    expect(tamperedStatus.diagnostics.messages).toEqual(expect.arrayContaining([expect.stringContaining("pricing.json is invalid")]));

    writeFileSync(path.join(runDirectory, "pricing.json"), "{}", "utf8");
    const corruptStatus = JSON.parse(JSON.stringify(await getRunStatus(project, runId)));
    expect(corruptStatus.metrics.totals.costUsd).toBe(0);
    expect(corruptStatus.metrics.estimates).toBeUndefined();
    expect(corruptStatus.diagnostics.messages).toEqual(expect.arrayContaining([expect.stringContaining("pricing.json is invalid")]));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 30_000);

test("OBS-010 preserves status behavior when no pricing policy was configured", async () => {
  const { project } = await pricingProject({}, false);
  try {
    const initial = runDriver(["run", project], project);
    expect(initial.status, initial.stderr).toBe(0);
    const runId = JSON.parse(initial.stdout).runId as string;
    const status = JSON.parse(JSON.stringify(await getRunStatus(project, runId)));
    expect(status.metrics.estimates).toBeUndefined();
    expect(status.metrics.estimateCoverage).toBeUndefined();
    expect(existsSync(path.join(project, ".nodulus", "runs", runId, "pricing.json"))).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("OBS-010 rejects invalid explicit rates before inference", async () => {
  const { project, logPath } = await pricingProject({ inputPerMillion: -1 });
  try {
    const result = runDriver(["run", project], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pricing");
    expect(readFileSync(logPath, "utf8")).toBe("");
    const runs = path.join(project, ".nodulus", "runs");
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("OBS-010 rejects an invalid explicit pricing policy before inference", async () => {
  const { project, logPath } = await pricingProject();
  try {
    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.observability.pricing.mode = "unknown";
    writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
    const result = runDriver(["run", project], project);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pricing");
    expect(readFileSync(logPath, "utf8")).toBe("");
    const runs = path.join(project, ".nodulus", "runs");
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

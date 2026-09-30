import { expect, test } from "vitest";
import { estimateProviderCost, type PricingSnapshot } from "../../src/core/cost-estimate.js";
import type { ProviderTelemetry } from "../../src/core/ports/provider-telemetry.js";
import { parseCodexUsage } from "../../src/adapters/providers/codex-usage.js";
import { makeTelemetry } from "../../src/adapters/providers/usage-common.js";

function telemetry(overrides: Partial<ProviderTelemetry> = {}): ProviderTelemetry {
  return {
    schemaVersion: 1,
    provider: "codex",
    cliVersion: "0.144.4",
    reportedModel: "fictional-verified",
    reported: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, reasoningTokens: 20, costUsd: 0 },
    normalized: { inputTokens: 1000, outputTokens: 100 },
    coverage: "complete",
    stepCount: 1,
    source: { eventType: "turn.completed", recordIds: ["turn-1"], transportRef: "calls/id/transport.json", parserVersion: 1 },
    semantics: { inputCache: "included", outputReasoning: "included", evidence: "verified" },
    diagnostics: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<PricingSnapshot> = {}): PricingSnapshot {
  return {
    schemaVersion: 1,
    hash: "abc",
    rawRateCard: JSON.stringify({ schemaVersion: 1, rates: [{ id: "fictional-v1", provider: "codex", reportedModel: "fictional-verified", inputPerMillion: 2, cacheReadPerMillion: 1, outputPerMillion: 4 }] }),
    mode: "api",
    hypotheticalApiEquivalent: false,
    rates: [{ id: "fictional-v1", provider: "codex", reportedModel: "fictional-verified", inputPerMillion: 2, cacheReadPerMillion: 1, outputPerMillion: 4 }],
    ...overrides,
  };
}

// Supervisor-integrated from a local-Qwen draft after its bounded correction lacked request context.
test("OBS-010 calculates an inclusive-cache estimate without double-counting reasoning", () => {
  expect(telemetry().reported.costUsd).toBe(0);
  expect(estimateProviderCost(telemetry(), snapshot())).toEqual({
    usd: expect.closeTo(0.0022),
    rateId: "fictional-v1",
    snapshotHash: "abc",
    hypothetical: false,
    diagnostics: [],
  });
});

test("OBS-010 keeps unsupported or incomplete estimates unknown", () => {
  const cases = [
    estimateProviderCost(null, snapshot()),
    estimateProviderCost(telemetry(), null),
    estimateProviderCost(telemetry({ reportedModel: null }), snapshot()),
    estimateProviderCost(telemetry({ semantics: { inputCache: "included", outputReasoning: "included", evidence: null } }), snapshot()),
    estimateProviderCost(telemetry({ semantics: { inputCache: "included", outputReasoning: "unknown", evidence: "verified" } }), snapshot()),
    estimateProviderCost(telemetry(), snapshot({ rates: [{ ...snapshot().rates[0]!, cacheReadPerMillion: null }] })),
    estimateProviderCost(telemetry({ normalized: { inputTokens: null, outputTokens: 100 } }), snapshot()),
    estimateProviderCost(telemetry(), snapshot({ mode: "local" })),
    estimateProviderCost(telemetry(), snapshot({ mode: "subscription" })),
    estimateProviderCost(telemetry({ reportedModel: "unmatched" }), snapshot()),
    estimateProviderCost(telemetry(), snapshot({ rates: [snapshot().rates[0]!, { ...snapshot().rates[0]!, id: "duplicate" }] })),
    estimateProviderCost(telemetry({ normalized: { inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE } }), snapshot({ rates: [{ ...snapshot().rates[0]!, inputPerMillion: Number.MAX_VALUE }] })),
  ];
  for (const result of cases) {
    expect(result.usd).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  }
});

test("OBS-010 labels an explicitly requested subscription equivalent hypothetical", () => {
  const result = estimateProviderCost(telemetry(), snapshot({ mode: "subscription", hypotheticalApiEquivalent: true }));
  expect(result.usd).toBeCloseTo(0.0022);
  expect(result.hypothetical).toBe(true);
});

test("OBS-010 accepts real exact-version adapter evidence and prices disjoint normalized buckets", () => {
  const codex = parseCodexUsage(JSON.stringify({
    type: "turn.completed",
    turn_id: "turn-1",
    model: "fictional-verified",
    usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 20 },
  }), "0.144.4");
  expect(codex.semantics.evidence).toMatch(/^https:/);
  expect(estimateProviderCost(codex, snapshot()).usd).toBeCloseTo(0.0022, 10);

  const opencode = makeTelemetry("opencode", "1.18.32", "step_finish", [{
    id: "step-1",
    counters: { inputTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 80, reasoningTokens: 20, costUsd: 0 },
  }], [], true, "fictional-verified");
  expect(opencode.normalized).toEqual({ inputTokens: 1000, outputTokens: 100 });
  const opencodeRates = snapshot({ rates: [{ ...snapshot().rates[0]!, provider: "opencode" }] });
  expect(estimateProviderCost(opencode, opencodeRates).usd).toBeCloseTo(0.0022, 10);
});

test("OBS-010 leaves excluded-cache telemetry unknown when cache writes have no rate", () => {
  const opencode = makeTelemetry("opencode", "1.18.32", "step_finish", [{
    id: "step-1",
    counters: { inputTokens: 750, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 80, reasoningTokens: 20, costUsd: 0 },
  }], [], true, "fictional-verified");
  const estimate = estimateProviderCost(opencode, snapshot({ rates: [{ ...snapshot().rates[0]!, provider: "opencode" }] }));
  expect(estimate.usd).toBeNull();
  expect(estimate.diagnostics.join(" ")).toContain("cache-write");
});

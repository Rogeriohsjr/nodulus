import type { ProviderTelemetry } from "./ports/provider-telemetry.js";

export type PricingRate = {
  id: string;
  provider: string;
  reportedModel: string;
  inputPerMillion: number;
  cacheReadPerMillion: number | null;
  outputPerMillion: number;
};
export type PricingSnapshot = {
  schemaVersion: 1;
  hash: string;
  rawRateCard: string;
  mode: "api" | "local" | "subscription";
  hypotheticalApiEquivalent: boolean;
  rates: PricingRate[];
};
export type CostEstimate = {
  usd: number | null;
  rateId: string | null;
  snapshotHash: string | null;
  hypothetical: boolean;
  diagnostics: string[];
};

export function estimateProviderCost(
  telemetry: ProviderTelemetry | null,
  snapshot: PricingSnapshot | null,
): CostEstimate {
  const unknown = (diagnostic: string): CostEstimate => ({
    usd: null,
    rateId: null,
    snapshotHash: null,
    hypothetical: false,
    diagnostics: [diagnostic],
  });
  if (telemetry === null) return unknown("Provider telemetry is missing.");
  if (snapshot === null) return unknown("The captured pricing snapshot is missing.");
  if (telemetry.coverage !== "complete") return unknown("Provider telemetry coverage is incomplete.");
  if (!telemetry.semantics.evidence?.trim()) return unknown("Provider telemetry semantics have no evidence.");
  if (telemetry.semantics.inputCache === "unknown") return unknown("Input cache semantics are unknown.");
  if (telemetry.semantics.outputReasoning === "unknown") return unknown("Output reasoning semantics are unknown.");
  if (!telemetry.reportedModel) return unknown("The provider did not report a model.");
  if (snapshot.mode !== "api" && !snapshot.hypotheticalApiEquivalent) {
    return unknown(`Pricing mode ${snapshot.mode} has no actual API estimate.`);
  }

  const rates = snapshot.rates.filter(
    (rate) => rate.provider === telemetry.provider && rate.reportedModel === telemetry.reportedModel,
  );
  if (rates.length !== 1) {
    return unknown(rates.length === 0 ? "No matching pricing rate was captured." : "Multiple matching pricing rates were captured.");
  }
  const rate = rates[0];
  if (rate === undefined) return unknown("No matching pricing rate was captured.");

  const inputTokens = telemetry.normalized.inputTokens;
  const outputTokens = telemetry.normalized.outputTokens;
  const cacheTokens = telemetry.reported.cacheReadTokens;
  const cacheWriteTokens = telemetry.reported.cacheWriteTokens;
  if (inputTokens === null || !Number.isFinite(inputTokens) || inputTokens < 0) return unknown("Normalized input tokens are unavailable or invalid.");
  if (outputTokens === null || !Number.isFinite(outputTokens) || outputTokens < 0) return unknown("Normalized output tokens are unavailable or invalid.");
  if (cacheTokens === null || !Number.isFinite(cacheTokens) || cacheTokens < 0) return unknown("Reported cache-read tokens are unavailable or invalid.");
  if (telemetry.semantics.inputCache === "excluded" && (cacheWriteTokens === null || !Number.isFinite(cacheWriteTokens) || cacheWriteTokens < 0)) {
    return unknown("Reported cache-write tokens are unavailable or invalid for excluded-cache semantics.");
  }
  if (telemetry.semantics.inputCache === "excluded" && cacheWriteTokens !== null && cacheWriteTokens > 0) {
    return unknown("Reported cache-write tokens have no configured cache-write rate.");
  }
  if (!Number.isFinite(rate.inputPerMillion) || rate.inputPerMillion < 0) return unknown("The input pricing rate is invalid.");
  if (!Number.isFinite(rate.outputPerMillion) || rate.outputPerMillion < 0) return unknown("The output pricing rate is invalid.");
  if (cacheTokens > 0 && (rate.cacheReadPerMillion === null || !Number.isFinite(rate.cacheReadPerMillion) || rate.cacheReadPerMillion < 0)) {
    return unknown("The cache-read pricing rate is unavailable or invalid.");
  }
  if (telemetry.semantics.inputCache === "included" && cacheTokens > inputTokens) {
    return unknown("Cache-read tokens exceed normalized input tokens.");
  }

  const excludedWriteTokens = telemetry.semantics.inputCache === "excluded" ? cacheWriteTokens ?? 0 : 0;
  if (cacheTokens + excludedWriteTokens > inputTokens) return unknown("Cache tokens exceed normalized input tokens.");
  const uncachedInput = inputTokens - cacheTokens - excludedWriteTokens;
  const cacheRate = rate.cacheReadPerMillion ?? 0;
  const usd = (
    uncachedInput * rate.inputPerMillion
    + cacheTokens * cacheRate
    + outputTokens * rate.outputPerMillion
  ) / 1_000_000;
  if (!Number.isFinite(usd) || usd < 0) return unknown("The calculated estimate is outside the supported numeric range.");
  return {
    usd,
    rateId: rate.id,
    snapshotHash: snapshot.hash,
    hypothetical: snapshot.mode !== "api",
    diagnostics: [],
  };
}

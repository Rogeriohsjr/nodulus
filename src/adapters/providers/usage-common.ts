import type { ProviderTelemetry, ReportedCounters } from "../../core/ports/provider-telemetry.js";
import { sumUsageField } from "./sum-usage-field.js";

export type UsageRecord = { id: string; counters: Record<string, unknown> };

export function makeTelemetry(provider: string, cliVersion: string | null, eventType: string, records: UsageRecord[], diagnostics: string[] = [], complete = true, reportedModel: string | null = null): ProviderTelemetry {
  const issues = [...diagnostics];
  const reported: ReportedCounters = {
    inputTokens: sumUsageField(records, "inputTokens", issues),
    outputTokens: sumUsageField(records, "outputTokens", issues),
    cacheReadTokens: sumUsageField(records, "cacheReadTokens", issues),
    cacheWriteTokens: sumUsageField(records, "cacheWriteTokens", issues),
    reasoningTokens: sumUsageField(records, "reasoningTokens", issues),
    costUsd: sumUsageField(records, "costUsd", issues),
  };
  const semantics: ProviderTelemetry["semantics"] = { inputCache: "unknown", outputReasoning: "unknown", evidence: null };
  if (provider === "codex" && cliVersion === "0.144.4") {
    Object.assign(semantics, { inputCache: "included", outputReasoning: "included", evidence: "https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/protocol/src/protocol.rs" });
  } else if (provider === "opencode" && cliVersion === "1.18.32") {
    Object.assign(semantics, { inputCache: "excluded", outputReasoning: "excluded", evidence: "https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/session.ts" });
  }
  const normalized: ProviderTelemetry["normalized"] = { inputTokens: null, outputTokens: null };
  const inclusive = (name: string, values: Array<number | null>): number | null => {
    if (values.some(value => value === null)) return null;
    const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    if (!Number.isSafeInteger(total)) { issues.push(`${name} normalization overflow`); return null; }
    return total;
  };
  if (records.length && complete && issues.length === 0) {
    if (semantics.inputCache === "included") normalized.inputTokens = reported.inputTokens;
    else if (semantics.inputCache === "excluded") normalized.inputTokens = inclusive("inputTokens", [reported.inputTokens, reported.cacheReadTokens, reported.cacheWriteTokens]);
    if (semantics.outputReasoning === "included") normalized.outputTokens = reported.outputTokens;
    else if (semantics.outputReasoning === "excluded") normalized.outputTokens = inclusive("outputTokens", [reported.outputTokens, reported.reasoningTokens]);
  }
  if (issues.length) { normalized.inputTokens = null; normalized.outputTokens = null; }
  return {
    schemaVersion: 1, provider, cliVersion, reportedModel, reported, normalized,
    coverage: records.length === 0 ? "unavailable" : complete && issues.length === 0 ? "complete" : "partial",
    stepCount: records.length,
    source: { eventType, recordIds: records.map(record => record.id), transportRef: "", parserVersion: 1 },
    semantics, diagnostics: issues,
  };
}

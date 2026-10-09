import type { ProviderTelemetry } from "../../core/ports/provider-telemetry.js";
import { makeTelemetry, type UsageRecord } from "./usage-common.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClaudeUsage(stdout: string, cliVersion: string | null): ProviderTelemetry {
  let event: unknown;
  try { event = JSON.parse(stdout) as unknown; }
  catch { return makeTelemetry("claude", cliVersion, "result", [], ["Malformed JSON"], false); }
  if (!isRecord(event) || event.type !== "result" || event.subtype !== "success" || event.is_error !== false || !isRecord(event.usage)) {
    return makeTelemetry("claude", cliVersion, "result", [], ["Missing successful result usage"], false);
  }

  const usage = event.usage;
  const counters = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    costUsd: event.total_cost_usd,
  };
  const complete = Object.values(counters).every(value => value !== undefined && value !== null);
  const records: UsageRecord[] = [{ id: "result", counters }];
  const model = typeof event.model === "string" ? event.model : null;
  const telemetry = makeTelemetry("claude", cliVersion, "result", records, [], complete, model);
  if (cliVersion === "2.1.294") {
    telemetry.semantics = {
      inputCache: "excluded",
      outputReasoning: "included",
      evidence: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    };
    const inputCounters = [counters.inputTokens, counters.cacheReadTokens, counters.cacheWriteTokens];
    if (inputCounters.every(isTokenCount)) {
      const inputTotal = inputCounters.reduce<number>((total, value) => total + value, 0);
      telemetry.normalized.inputTokens = Number.isSafeInteger(inputTotal) ? inputTotal : null;
      if (telemetry.normalized.inputTokens === null) telemetry.diagnostics.push("inputTokens normalization overflow");
    }
    if (isTokenCount(counters.outputTokens)) telemetry.normalized.outputTokens = counters.outputTokens;
  }
  return telemetry;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

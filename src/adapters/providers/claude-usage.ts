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
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
  const counters = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    reasoningTokens: outputDetails?.thinking_tokens,
    costUsd: event.total_cost_usd,
  };
  const complete = [counters.inputTokens, counters.outputTokens, counters.cacheReadTokens, counters.cacheWriteTokens, counters.costUsd]
    .every(value => value !== undefined && value !== null);
  const records: UsageRecord[] = [{ id: "result", counters }];
  const model = reportedModel(event);
  const telemetry = makeTelemetry("claude", cliVersion, "result", records, [], complete, model);
  if (cliVersion === "2.1.294" || cliVersion === "2.1.295") {
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

function reportedModel(event: Record<string, unknown>): string | null {
  if (typeof event.model === "string" && event.model.trim()) return event.model;
  if (!isRecord(event.modelUsage)) return null;
  const entries = Object.values(event.modelUsage);
  if (entries.length !== 1 || !isRecord(entries[0])) return null;
  const canonicalModel = entries[0].canonicalModel;
  return typeof canonicalModel === "string" && canonicalModel.trim() ? canonicalModel : null;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

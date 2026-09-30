import type { ProviderCallMetric, ProviderUsage } from "../core/ports/provider.js";

export type MetricField = keyof ProviderUsage;
export type MetricCoverage = {
  knownCalls: number;
  totalCalls: number;
  knownSubtotal: number;
  total: number | null;
};
export type MetricOrigin = "provider_event" | "legacy_adapter" | "unavailable";
export type RunMetrics = {
  calls: ProviderCallMetric[];
  totals: ProviderUsage;
  coverage: Record<MetricField, MetricCoverage>;
  origins: MetricOrigin[];
  groups: RunMetricGroup[];
};
export type RunMetricGroup = {
  nodeId: string;
  provider: string | null;
  reportedModel: string | null;
  callCount: number;
  totals: ProviderUsage;
  coverage: Record<MetricField, MetricCoverage>;
};
export type StartedProviderCall = { callId: string; nodeId: string };

const fields: MetricField[] = ["inputTokens", "outputTokens", "cacheReadTokens", "costUsd"];

export function summarizeRunMetrics(
  raw: string | null,
  startedCalls: StartedProviderCall[],
): { metrics: RunMetrics; diagnostics: string[] } {
  const diagnostics: string[] = [];
  let rows: unknown[] = [];
  if (raw === null) diagnostics.push("metrics.json is missing or unreadable");
  else {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) rows = parsed;
      else diagnostics.push("metrics.json must contain an array");
    } catch {
      diagnostics.push("metrics.json contains invalid JSON");
    }
  }

  const calls: ProviderCallMetric[] = [];
  const origins: MetricOrigin[] = [];
  const callIds = new Set<string>();
  const callIndexes = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const parsed = parseMetricRow(row, index, diagnostics);
    if (!parsed) continue;
    if (parsed.call.callId) {
      if (callIds.has(parsed.call.callId)) {
        const retainedIndex = callIndexes.get(parsed.call.callId)!;
        if (JSON.stringify(calls[retainedIndex]) !== JSON.stringify(parsed.call)) {
          const retained = calls[retainedIndex]!;
          delete retained.telemetry;
          retained.usage = null;
          origins[retainedIndex] = "unavailable";
          diagnostics.push(`metrics.json has conflicting duplicate callId '${parsed.call.callId}'`);
        } else diagnostics.push(`metrics.json has duplicate callId '${parsed.call.callId}'`);
        continue;
      }
      callIds.add(parsed.call.callId);
      callIndexes.set(parsed.call.callId, calls.length);
    }
    calls.push(parsed.call);
    origins.push(parsed.origin);
  }

  const unmatchedStarted = new Map<string, StartedProviderCall>();
  for (const started of startedCalls) {
    if (started.callId.length > 0 && started.nodeId.length > 0 && !callIds.has(started.callId)) {
      unmatchedStarted.set(started.callId, started);
    }
  }
  const totalCalls = calls.length + unmatchedStarted.size;
  const { coverage, totals } = aggregateCoverage(calls, origins, totalCalls, diagnostics, "metrics.json");
  const grouped = new Map<string, { calls: ProviderCallMetric[]; origins: MetricOrigin[] }>();
  for (const [index, call] of calls.entries()) {
    const provider = call.telemetry?.provider ?? null;
    const reportedModel = call.telemetry?.reportedModel ?? null;
    const key = JSON.stringify([call.nodeId, provider, reportedModel]);
    const group = grouped.get(key) ?? { calls: [], origins: [] };
    group.calls.push(call);
    group.origins.push(origins[index]!);
    grouped.set(key, group);
  }
  for (const started of unmatchedStarted.values()) {
    if (![...grouped.keys()].some((key) => (JSON.parse(key) as [string])[0] === started.nodeId)) {
      grouped.set(JSON.stringify([started.nodeId, null, null]), { calls: [], origins: [] });
    }
  }
  const groups = [...grouped.entries()].map(([key, group]) => {
    const [nodeId, provider, reportedModel] = JSON.parse(key) as [string, string | null, string | null];
    const unmatchedForNode = [...unmatchedStarted.values()].filter((started) => started.nodeId === nodeId).length;
    const aggregate = aggregateCoverage(group.calls, group.origins, group.calls.length + unmatchedForNode, diagnostics, `group ${key}`);
    return { nodeId, provider, reportedModel, callCount: group.calls.length, ...aggregate };
  });
  return { metrics: { calls, totals, coverage, origins, groups }, diagnostics };
}

function aggregateCoverage(
  calls: ProviderCallMetric[],
  origins: MetricOrigin[],
  totalCalls: number,
  diagnostics: string[],
  label: string,
): { coverage: Record<MetricField, MetricCoverage>; totals: ProviderUsage } {
  const coverage = {} as Record<MetricField, MetricCoverage>;
  const totals = {} as ProviderUsage;
  for (const field of fields) {
    const values: number[] = [];
    const valueOrigins = new Set<MetricOrigin>();
    for (const [index, call] of calls.entries()) {
      const value = call.usage?.[field];
      if (typeof value !== "number") continue;
      values.push(value);
      valueOrigins.add(origins[index]!);
    }
    const incompatible = valueOrigins.has("provider_event") && valueOrigins.has("legacy_adapter");
    if (incompatible) diagnostics.push(`${label} has incompatible origins for ${field}`);
    const knownCalls = incompatible ? 0 : values.length;
    const knownSubtotal = incompatible ? 0 : values.reduce((sum, value) => sum + value, 0);
    const total = totalCalls > 0 && knownCalls === totalCalls ? knownSubtotal : null;
    coverage[field] = { knownCalls, totalCalls, knownSubtotal, total };
    totals[field] = total;
  }
  return { coverage, totals };
}

function parseMetricRow(
  value: unknown,
  index: number,
  diagnostics: string[],
): { call: ProviderCallMetric; origin: MetricOrigin } | null {
  if (!isRecord(value)) {
    diagnostics.push(`metrics.json row ${index} is not an object`);
    return null;
  }
  if (typeof value.nodeId !== "string" || value.nodeId.length === 0
    || !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1
    || typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) {
    diagnostics.push(`metrics.json row ${index} has invalid identity or timing`);
    return null;
  }
  if (value.callId !== undefined && (typeof value.callId !== "string" || value.callId.length === 0)) {
    diagnostics.push(`metrics.json row ${index} has invalid callId`);
    return null;
  }

  const usage = parseUsage(value.usage, index, diagnostics);
  const telemetry = parseTelemetry(value.telemetry);
  if (value.telemetry !== undefined && telemetry === undefined) {
    diagnostics.push(`metrics.json row ${index} has invalid telemetry`);
  }
  const operation = value.operation === "invoke" || value.operation === "repair_response"
    ? value.operation
    : undefined;
  const launched = typeof value.launched === "boolean" || value.launched === null
    ? value.launched
    : undefined;
  const call: ProviderCallMetric = {
    nodeId: value.nodeId,
    attempt: value.attempt as number,
    elapsedMs: value.elapsedMs,
    usage,
    ...(typeof value.callId === "string" ? { callId: value.callId } : {}),
    ...(operation ? { operation } : {}),
    ...(launched !== undefined ? { launched } : {}),
    ...(telemetry ? { telemetry } : {}),
  };
  return {
    call,
    origin: telemetry ? "provider_event" : usage ? "legacy_adapter" : "unavailable",
  };
}

function parseTelemetry(value: unknown): ProviderCallMetric["telemetry"] | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.provider !== "string" || value.provider.length === 0
    || !(value.reportedModel === null || (typeof value.reportedModel === "string" && value.reportedModel.length > 0))
    || !isRecord(value.reported)
    || !isRecord(value.normalized)
    || !["complete", "partial", "unavailable"].includes(String(value.coverage))
    || !isRecord(value.source)
    || !isRecord(value.semantics)
    || !Array.isArray(value.diagnostics) || !value.diagnostics.every((item) => typeof item === "string")) return undefined;
  return value as ProviderCallMetric["telemetry"];
}

function parseUsage(value: unknown, index: number, diagnostics: string[]): ProviderUsage | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    diagnostics.push(`metrics.json row ${index} has invalid usage`);
    return null;
  }
  const usage = {} as ProviderUsage;
  for (const field of fields) {
    const fieldValue = value[field];
    const valid = fieldValue === null
      || (typeof fieldValue === "number" && Number.isFinite(fieldValue) && fieldValue >= 0
        && (field === "costUsd" || Number.isSafeInteger(fieldValue)));
    if (!valid) diagnostics.push(`metrics.json row ${index} has invalid ${field}`);
    usage[field] = valid && typeof fieldValue === "number" ? fieldValue : null;
  }
  return usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

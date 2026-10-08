// src/adapters/providers/cursor-usage.ts

import { makeTelemetry, type UsageRecord } from './usage-common.js';
import type { ProviderTelemetry } from '../../core/ports/provider-telemetry.js';

export function parseCursorUsage(stdout: string, cliVersion: string | null): ProviderTelemetry {
  let records: UsageRecord[] = [];
  const diagnostics: string[] = [];
  let complete = true;
  let reportedModel: string | null = null;

  const parsed = parseTransport(stdout, diagnostics);
  if (parsed === undefined) complete = false;
  else if (
    isRecord(parsed) &&
    parsed.type === 'result' &&
    parsed.subtype === 'success' &&
    parsed.is_error === false &&
    typeof parsed.result === 'string'
  ) {
    reportedModel = typeof parsed.model === 'string' ? parsed.model : null;
    if (isRecord(parsed.usage)) {
      records = [{
        id: 'result',
        counters: {
          inputTokens: parsed.usage.inputTokens ?? undefined,
          outputTokens: parsed.usage.outputTokens ?? undefined,
          cacheReadTokens: parsed.usage.cacheReadTokens ?? undefined,
          cacheWriteTokens: parsed.usage.cacheWriteTokens ?? undefined,
        },
      }];
    }
  } else {
    diagnostics.push('Invalid terminal data format');
    complete = false;
  }

  return makeTelemetry('cursor', cliVersion, 'result', records, diagnostics, complete, reportedModel);
}

function parseTransport(stdout: string, diagnostics: string[]): unknown {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isCursorResult(parsed)) return parsed;
  } catch {
    // stream-json is line-delimited; retain the legacy single-envelope path above.
  }

  const events: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try { events.push(JSON.parse(line) as unknown); }
    catch {
      diagnostics.push('Malformed NDJSON');
      return undefined;
    }
  }
  const terminal = events.at(-1);
  if (isCursorResult(terminal) && !events.slice(0, -1).some((event) => isCursorResult(event))) return terminal;
  diagnostics.push('Invalid terminal data format');
  return undefined;
}

function isCursorResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'result' && typeof value.result === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

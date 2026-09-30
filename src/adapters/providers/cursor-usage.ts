// src/adapters/providers/cursor-usage.ts

import { makeTelemetry, type UsageRecord } from './usage-common.js';
import type { ProviderTelemetry } from '../../core/ports/provider-telemetry.js';


export function parseCursorUsage(stdout: string, cliVersion: string | null): ProviderTelemetry {
  let records: UsageRecord[] = [];
  const diagnostics: string[] = [];
  let complete = true;
  let reportedModel: string | null = null;

  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      isRecord(parsed) &&
      parsed.type === 'result' &&
      parsed.subtype === 'success' &&
      parsed.is_error === false &&
      typeof parsed.result === 'string'
    ) {
      reportedModel = typeof parsed.model === 'string' ? parsed.model : null;
      const usage = parsed.usage;

      if (isRecord(usage)) {
        const inputTokens = usage.inputTokens ?? undefined;
        const outputTokens = usage.outputTokens ?? undefined;
        const cacheReadTokens = usage.cacheReadTokens ?? undefined;
        const cacheWriteTokens = usage.cacheWriteTokens ?? undefined;
        const model = typeof parsed.model === 'string' ? parsed.model : null;

        records = [
          {
            id: 'result',
            counters: {
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
            },
          },
        ];

        reportedModel = model;
      }
    } else {
      diagnostics.push('Invalid terminal data format');
      complete = false;
    }
  } catch {
    diagnostics.push('Malformed JSON');
    complete = false;
  }

  return makeTelemetry('cursor', cliVersion, 'result', records, diagnostics, complete, reportedModel);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

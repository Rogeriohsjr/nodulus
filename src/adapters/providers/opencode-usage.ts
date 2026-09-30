import { makeTelemetry, type UsageRecord } from './usage-common.js';
import type { ProviderTelemetry } from '../../core/ports/provider-telemetry.js';

function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
}

export function parseOpenCodeUsage(stdout: string, cliVersion: string | null): ProviderTelemetry {
  const records = new Map<string, UsageRecord>();
  const fingerprints = new Map<string, string>();
  const seenStarts = new Set<string>();
  const pending = new Map<string, number>();
  const stopped = new Map<string, boolean>();
  const diagnostics: string[] = [];

  const lines = stdout.split('\n').filter(line => line.trim() !== '');

  for (const line of lines) {
    try {
      const event: unknown = JSON.parse(line);

      if (!isRecord(event) || (event.type !== 'step_start' && event.type !== 'step_finish')) continue;
      if (!isRecord(event.part)) {
        diagnostics.push('Invalid step part');
        continue;
      }

      const part = event.part;
      const session = typeof part.sessionID === 'string' ? part.sessionID : event.sessionID;

      if (typeof session !== 'string' || !session || typeof part.id !== 'string' || !part.id || typeof part.messageID !== 'string' || !part.messageID) {
        diagnostics.push('Missing step identity');
        continue;
      }

      const key = JSON.stringify([session, part.id]);
      const messageKey = JSON.stringify([session, part.messageID]);

      if (event.type === 'step_start') {
        if (seenStarts.has(key)) {
          continue;
        }
        seenStarts.add(key);
        pending.set(messageKey, (pending.get(messageKey) ?? 0) + 1);
        stopped.set(session, false);
        continue;
      }

      const tokens = isRecord(part.tokens) ? part.tokens : {};
      const cache = isRecord(tokens.cache) ? tokens.cache : {};
      const counters = {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        reasoningTokens: tokens.reasoning,
        cacheReadTokens: cache.read,
        cacheWriteTokens: cache.write,
        costUsd: part.cost
      };

      const fingerprint = JSON.stringify({ counters, reason: part.reason, messageID: part.messageID });

      if (fingerprints.has(key)) {
        if (fingerprints.get(key) !== fingerprint) {
          diagnostics.push('conflict');
        }
        continue;
      }

      fingerprints.set(key, fingerprint);
      records.set(key, { id: key, counters });
      pending.set(messageKey, Math.max(0, (pending.get(messageKey) ?? 0) - 1));
      stopped.set(session, part.reason === 'stop');
    } catch {
      diagnostics.push('Malformed JSON line');
      continue;
    }
  }

  for (const [ key, value ] of pending) {
    if (value > 0) {
      diagnostics.push(`missing step completion: ${key}`);
    }
  }

  for (const [ session, isStopped ] of stopped) {
    if (!isStopped) {
      diagnostics.push(`missing final stop: ${session}`);
    }
  }

  return makeTelemetry('opencode', cliVersion, 'step_finish', [...records.values()], diagnostics, diagnostics.length === 0, null);
}
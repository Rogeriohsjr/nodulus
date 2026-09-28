import { makeTelemetry, type UsageRecord } from './usage-common.js';
import type { ProviderTelemetry } from '../../core/ports/provider-telemetry.js';


function isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function parseCodexUsage(stdout: string, cliVersion: string | null): ProviderTelemetry {
    const records = new Map<string, UsageRecord>();
    const diagnostics: string[] = [];
    let ordinal = 0;
    let pending = false;
    const models = new Set<string>();

    for (const line of stdout.split('\n')) {
        if (line.trim() === '') continue;

        let event: unknown;
        try {
            event = JSON.parse(line);
        } catch {
            diagnostics.push("Malformed JSON line");
            continue;
        }

        if (!isRecord(event)) continue;

        if (event.type === 'turn.started') {
            if (pending) diagnostics.push("incomplete previous turn");
            ordinal++;
            pending = true;
            continue;
        }

        if (event.type !== 'turn.completed') continue;

        if (ordinal === 0) ordinal = 1;

        const id = typeof event.turn_id === 'string' ? event.turn_id : `turn:${ordinal}`;

        const usage = isRecord(event.usage) ? event.usage : {};

        if (!usage || Object.keys(usage).length === 0) {
            diagnostics.push(`Invalid or missing usage for turn ${id}`);
        }

        const counters: Record<string, unknown> = {
            inputTokens: usage.input_tokens,
            cacheReadTokens: usage.cached_input_tokens,
            outputTokens: usage.output_tokens,
            reasoningTokens: usage.reasoning_output_tokens,
        };

        const existing = records.get(id);

        if (existing) {
            if (JSON.stringify(existing.counters) !== JSON.stringify(counters)) {
                diagnostics.push(`conflict in usage for turn ${id}`);
            }
        } else {
            records.set(id, { id, counters });
        }

        if (typeof event.model === 'string') {
            models.add(event.model);
        }

        pending = false;
    }

    if (pending) {
        diagnostics.push('Pending turn without completion');
    }

    if (models.size > 1) {
        diagnostics.push('Multiple models used');
    }

    return makeTelemetry('codex', cliVersion, 'turn.completed', Array.from(records.values()), diagnostics, !pending, models.size === 1 ? Array.from(models)[0] : null);
}
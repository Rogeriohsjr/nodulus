import type { IntakeStorage } from '../core/ports/intake-storage.js';
import type { ProviderCallMetric } from '../core/ports/provider.js';

export type CallEvidence = {
  callId: string;
  nodeId: string;
  launched: boolean | null;
  status: 'completed' | 'incomplete' | 'not_launched' | 'unavailable';
  requestAvailable: boolean;
  transportAvailable: boolean;
  diagnostics: string[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function validateCallId(value: unknown): value is string {
  return isString(value) && UUID_RE.test(value);
}

function extractNodeId(event: Record<string, unknown>): string | null {
  const nodeId = event['nodeId'];
  if (isString(nodeId) && nodeId.length > 0) {
    return nodeId;
  }
  return null;
}

export async function readCallEvidence(
  _projectRoot: string,
  _runId: string,
  storage: IntakeStorage,
  events: unknown[],
  metrics: ProviderCallMetric[],
): Promise<CallEvidence[]> {
  const startedRecords: Array<{ callId: string; nodeId: string }> = [];
  const seenCallIds = new Set<string>();
  const completedCallIds = new Set<string>();

  for (const rawEvent of events) {
    if (!isRecord(rawEvent)) continue;
    if (rawEvent['event'] === 'provider.call.started') {
      if (validateCallId(rawEvent['callId'])) {
        const callId = rawEvent['callId'];
        if (!seenCallIds.has(callId)) {
          seenCallIds.add(callId);
          const nodeId = extractNodeId(rawEvent);
          if (nodeId !== null) {
            startedRecords.push({ callId, nodeId });
          }
        }
      }
    } else if (rawEvent['event'] === 'provider.call.completed') {
      if (validateCallId(rawEvent['callId'])) {
        completedCallIds.add(rawEvent['callId']);
      }
    }
  }

  const metricByCallId = new Map<string, ProviderCallMetric>();
  for (const metric of metrics) {
    if (validateCallId(metric.callId)) {
      metricByCallId.set(metric.callId, metric);
    }
  }

  const evidence: CallEvidence[] = [];

  for (const { callId, nodeId } of startedRecords) {
    const diagnostics: string[] = [];
    let requestAvailable = false;
    let transportAvailable = false;

    try {
      const requestRaw = await storage.readRunFile(_projectRoot, _runId, `calls/${callId}/request.json`);
      const requestParsed = JSON.parse(requestRaw) as unknown;
      if (isRecord(requestParsed)) {
        if (validateCallId(requestParsed['callId']) && requestParsed['callId'] === callId) {
          requestAvailable = true;
        } else {
          diagnostics.push('request.json callId mismatch');
        }
      } else {
        diagnostics.push('request.json is not a valid object');
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e?.code === 'ENOENT') {
        // File missing implies unavailable
      } else {
        diagnostics.push(`failed to read request: ${e?.message ?? 'unknown read error'}`);
      }
    }

    try {
      const transportRaw = await storage.readRunFile(_projectRoot, _runId, `calls/${callId}/transport.json`);
      const transportParsed = JSON.parse(transportRaw) as unknown;
      if (isRecord(transportParsed)) {
        if (validateCallId(transportParsed['callId']) && transportParsed['callId'] === callId) {
          transportAvailable = true;
        } else {
          diagnostics.push('transport.json callId mismatch');
        }
      } else {
        diagnostics.push('transport.json is not a valid object');
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e?.code === 'ENOENT') {
        // File missing implies unavailable
      } else {
        diagnostics.push(`failed to read transport: ${e?.message ?? 'unknown read error'}`);
      }
    }

    const metric = metricByCallId.get(callId);
    let launched: boolean | null;
    if (transportAvailable) {
      launched = true;
    } else if (metric && typeof metric.launched === 'boolean') {
      launched = metric.launched;
    } else {
      launched = null;
    }

    let status: CallEvidence['status'];
    if (launched === false) {
      status = 'not_launched';
    } else if (transportAvailable) {
      status = 'completed';
    } else if (requestAvailable || !completedCallIds.has(callId)) {
      status = 'incomplete';
    } else {
      status = 'unavailable';
    }

    evidence.push({
      callId,
      nodeId,
      launched,
      status,
      requestAvailable,
      transportAvailable,
      diagnostics,
    });
  }

  return evidence;
}

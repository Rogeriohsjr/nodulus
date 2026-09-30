import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createUsageScenario, jsonLines } from '../support/observability-usage.js';
import { runDefaultProviderCli, cleanupProviderProject, readProviderCalls } from '../support/provider-adapter-scenarios.js';
import { getRunStatus } from '../../src/application/resume-workflow.js';

test('OBS-006C - OpenCode transport emits truncated JSON and reports provider transport error', async () => {
  const event = {
    type: 'step_finish',
    part: {
      id: 'A',
      sessionID: 's',
      messageID: 'm',
      reason: 'tool-calls',
      tokens: {
        input: 100,
        output: 20,
        reasoning: 4,
        cache: {
          read: 30,
          write: 5
        }
      },
      cost: 0.001
    }
  };

  const truncatedLine = '{"type":"step_finish"';
  const { project, logPath } = await createUsageScenario('opencode', jsonLines([event]) + truncatedLine);

  try {
    const result = await runDefaultProviderCli(project, 'truncated transport');

    expect(result.code).toBe(1);
    expect(result.envelope.status).toBe('error');
    expect(result.envelope.result.error.code).toBe('PROVIDER_TRANSPORT_INVALID');

    const status = await getRunStatus(project, result.envelope.runId);
    expect(status.metrics!.calls.length).toBe(1);
    expect(readProviderCalls(logPath)).toHaveLength(1);

    const telemetry = status.metrics!.calls[0]!.telemetry!;

    expect(telemetry.coverage).toBe('partial');
    expect(status.metrics!.calls[0]!.usage).toBeNull();
    expect(telemetry.reported.costUsd).toBe(0.001);
    expect(telemetry.reported.inputTokens).toBe(100);
    expect(telemetry.reported.outputTokens).toBe(20);
    expect(telemetry.normalized.inputTokens).toBe(null);
    expect(telemetry.normalized.outputTokens).toBe(null);
    expect(telemetry.source.transportRef).not.toBeUndefined();
    expect(telemetry.diagnostics).toContain('Malformed JSON line');

    const jsonPath = path.join(project, '.nodulus/runs', result.envelope.runId, telemetry.source.transportRef!);
    const exitData = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    
    expect(exitData.timedOut).toBe(false);
    expect(exitData.outputLimitExceeded).toBe(false);
    expect(exitData.stdout.endsWith(truncatedLine)).toBe(true);
  } finally {
    cleanupProviderProject(project);
  }
}, 20000);

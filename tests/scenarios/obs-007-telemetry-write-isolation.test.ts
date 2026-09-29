import { test, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createUsageScenario, jsonLines } from '../support/observability-usage.js';
import { runDefaultProviderCli, readProviderCalls, cleanupProviderProject } from '../support/provider-adapter-scenarios.js';
import { getRunStatus } from '../../src/application/resume-workflow.js';

test('OBS-007A - Failed optional telemetry write must not reject a valid provider artifact or repeat inference', async () => {
  const stdout = jsonLines([{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }]);
  const { project, logPath } = await createUsageScenario('codex', stdout);

  try {
    const usageControlPath = path.resolve(project, '.nodulus', 'fixtures', 'usage-control.json');
    const usageControl: Record<string, unknown> = JSON.parse(readFileSync(usageControlPath, 'utf-8'));
    const updatedUsageControl = { ...usageControl, blockTelemetryWrite: true };
    writeFileSync(usageControlPath, JSON.stringify(updatedUsageControl, null, 2));

    const { code, envelope } = await runDefaultProviderCli(project, 'telemetry failure');

    expect(code).toBe(0);
    expect(envelope.result.artifacts[0].data.message).toBe('usage fixture result');

    const providerCalls = readProviderCalls(logPath);
    expect(providerCalls.length).toBe(1);

    const { metrics } = await getRunStatus(project, envelope.runId);
    expect(metrics!.calls[0]!.telemetry!.reported.inputTokens).toBe(10);
    expect(metrics.calls[0]!.telemetry!.diagnostics!.join(' ')).toContain('Telemetry persistence failed');
  } finally {
    cleanupProviderProject(project);
  }
}, 20000);
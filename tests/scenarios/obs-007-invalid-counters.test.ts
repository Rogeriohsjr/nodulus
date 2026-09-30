import { test, expect } from 'vitest';
import { createUsageScenario, jsonLines } from '../support/observability-usage.js';
import { runDefaultProviderCli, readProviderCalls, cleanupProviderProject } from '../support/provider-adapter-scenarios.js';
import { getRunStatus } from '../../src/application/resume-workflow.js';

const invalidValues: unknown[] = [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '12', {}, true];

test.each(invalidValues)('OBS-007 - Invalid input counter %p must not reject valid artifact or retry', async (bad: unknown) => {
  const stdout = jsonLines([{ type: 'turn.completed', usage: { input_tokens: bad, output_tokens: 2 } }]);
  const { project, logPath } = await createUsageScenario('codex', stdout);

  try {
    const { code, envelope } = await runDefaultProviderCli(project, 'invalid counters');

    expect(code).toBe(0);
    expect(envelope.result.artifacts[0].data.message).toBe('usage fixture result');

    const providerCalls = readProviderCalls(logPath);
    expect(providerCalls.length).toBe(1);

    const { metrics } = await getRunStatus(project, envelope.runId);
    expect(metrics!.calls[0]!.telemetry!.reported.inputTokens).toBeNull();
    expect(metrics!.calls[0]!.telemetry!.reported.outputTokens).toBe(2);
    expect(metrics!.calls[0]!.telemetry!.diagnostics!.join(' ')).toContain('inputTokens');
  } finally {
    cleanupProviderProject(project);
  }
}, 20000);

import { test, expect } from 'vitest';
import { getRunStatus } from '../../src/application/resume-workflow.js';
import { createUsageScenario, usageOutcome } from '../support/observability-usage.js';
import { runDefaultProviderCli, readProviderCalls, cleanupProviderProject } from '../support/provider-adapter-scenarios.js';

test.each(['present', 'absent', 'malformed'] as const)('OBS-004 %s', async mode => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: usageOutcome,
    ...(mode === 'absent' ? {} : { usage: mode === 'present' ? { inputTokens: 6766, outputTokens: 65, cacheReadTokens: 3840, cacheWriteTokens: 0 } : { inputTokens: 6766, outputTokens: '65' } })
  });

  const { project, logPath } = await createUsageScenario('cursor', stdout);

  try {
    const { code, envelope } = await runDefaultProviderCli(project, 'usage');
    expect(code).toBe(0);
    expect(readProviderCalls(logPath)).toHaveLength(1);

    const status = await getRunStatus(project, envelope.runId);
    const telemetry = (status.metrics!.calls[0] as any).telemetry;
    expect(telemetry).toBeDefined();

    if (mode === 'present') {
      expect(telemetry.reported).toEqual({
        inputTokens: 6766,
        outputTokens: 65,
        cacheReadTokens: 3840,
        cacheWriteTokens: 0,
        reasoningTokens: null,
        costUsd: null
      });
    } else if (mode === 'absent') {
      expect(telemetry.coverage).toBe('unavailable');
      expect(telemetry.reported).toEqual({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: null
      });
    } else if (mode === 'malformed') {
      expect(telemetry.reported.inputTokens).toBe(6766);
      expect(telemetry.reported.outputTokens).toBe(null);
      expect(JSON.stringify(telemetry.diagnostics)).toContain('outputTokens');
    }

    expect(telemetry.normalized).toEqual({inputTokens:null,outputTokens:null});
    expect(telemetry.semantics.evidence).toBeNull();
    expect(telemetry.reportedModel).toBeNull();
    expect(envelope.result.artifacts[0].data.message).toEqual('usage fixture result');
  } finally {
    cleanupProviderProject(project);
  }
}, 20000);
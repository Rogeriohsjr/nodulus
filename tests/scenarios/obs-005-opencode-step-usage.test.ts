import { test, expect } from 'vitest';
import { createUsageScenario, jsonLines, usageOutcome } from '../support/observability-usage.js';
import { runDefaultProviderCli, readProviderCalls, cleanupProviderProject } from '../support/provider-adapter-scenarios.js';
import { getRunStatus } from '../../src/application/resume-workflow.js';

test('opencode step usage', async () => {
  const A = {
    type: 'step_finish',
    part: {
      id: 'A',
      sessionID: 'session',
      messageID: 'm1',
      reason: 'tool-calls',
      tokens: {
        input: 100,
        output: 20,
        reasoning: 4,
        cache: { read: 30, write: 5 }
      },
      cost: 0.001
    }
  };

  const B = {
    type: 'step_finish',
    part: {
      id: 'B',
      sessionID: 'session',
      messageID: 'm2',
      reason: 'stop',
      tokens: {
        input: 200,
        output: 40,
        reasoning: 6,
        cache: { read: 50, write: 7 }
      },
      cost: 0.002
    }
  };

  const events = [
    { type: 'step_start', part: { id: 'startA', sessionID: 'session', messageID: 'm1' } },
    A,
    A,
    { type: 'assistant', tokens: { input: 999999 } },
    { type: 'step_start', part: { id: 'startB', sessionID: 'session', messageID: 'm2' } },
    { type: 'text', part: { messageID: 'm2', text: usageOutcome } },
    B
  ];

  const { project, logPath } = await createUsageScenario('opencode', jsonLines(events));
  try {
    const result = await runDefaultProviderCli(project, 'usage');
    expect(result.code).toBe(0);
    expect(readProviderCalls(logPath)).toHaveLength(1);
    const status = await getRunStatus(project, result.envelope.runId);
    const telemetry = (status.metrics!.calls[0] as any).telemetry;
    expect(telemetry).toBeDefined();
    expect(telemetry.reported.inputTokens).toBe(300);
    expect(telemetry.reported.outputTokens).toBe(60);
    expect(telemetry.reported.cacheReadTokens).toBe(80);
    expect(telemetry.reported.cacheWriteTokens).toBe(12);
    expect(telemetry.reported.reasoningTokens).toBe(10);
    expect(telemetry.reported.costUsd).toBeCloseTo(0.003);
    expect(telemetry.normalized.inputTokens).toBe(392);
    expect(telemetry.normalized.outputTokens).toBe(70);
    expect(telemetry.stepCount).toBe(2);
    expect(result.envelope.result.artifacts[0].data.message).toBe('usage fixture result');
  } finally {
    cleanupProviderProject(project);
  }
}, 20000);


test.each(['unknown-version', 'conflicting-duplicate', 'missing-completion', 'missing-counter', 'fractional-token', 'scoped-ids'] as const)('OBS-005 %s', async mode => {
  const first = { type: 'step_finish', part: { id: 'A', sessionID: 's', messageID: 'm1', reason: 'tool-calls', tokens: { input: 100, output: 20, reasoning: 4, cache: { read: 30, write: 5 } }, cost: 0.001 } };
  const last = { type: 'step_finish', part: { id: 'B', sessionID: 's', messageID: 'm2', reason: 'stop', tokens: { input: 200, output: 40, reasoning: 6, cache: { read: 50, write: 7 } }, cost: 0.002 } };
  const events: unknown[] = [first, { type: 'text', part: { messageID: 'm2', text: usageOutcome } }, last];
  if (mode === 'conflicting-duplicate') events.splice(1, 0, { ...first, part: { ...first.part, cost: 9 } });
  if (mode === 'missing-completion') events.unshift({ type: 'step_start', part: { id: 'start', sessionID: 's', messageID: 'unfinished' } });
  if (mode === 'missing-counter') delete (last.part.tokens as Partial<typeof last.part.tokens>).reasoning;
  if (mode === 'fractional-token') last.part.tokens.input = 0.5;
  if (mode === 'scoped-ids') {
    first.part.reason = 'stop';
    last.part.id = 'A';
    last.part.sessionID = 'other-session';
    // Same part id in two sessions counts twice; different JSON key ordering in a replay does not.
    events.push({ type: 'step_finish', part: { cost: 0.002, tokens: { cache: { write: 7, read: 50 }, reasoning: 6, output: 40, input: 200 }, reason: 'stop', messageID: 'm2', sessionID: 'other-session', id: 'A' } });
  }
  const { project, logPath } = await createUsageScenario('opencode', jsonLines(events), mode === 'unknown-version' ? '1.18.33' : '1.18.32');
  try {
    const result = await runDefaultProviderCli(project, 'usage');
    expect(result.code).toBe(0);
    expect(readProviderCalls(logPath)).toHaveLength(1);
    const telemetry = (await getRunStatus(project, result.envelope.runId)).metrics!.calls[0]!.telemetry!;
    expect(telemetry.stepCount).toBe(2);
    if (mode === 'scoped-ids') {
      expect(telemetry.coverage).toBe('complete');
      expect(telemetry.normalized).toEqual({ inputTokens: 392, outputTokens: 70 });
    } else if (mode === 'unknown-version') {
      expect(telemetry.reported.inputTokens).toBe(300);
      expect(telemetry.semantics.evidence).toBeNull();
      expect(telemetry.normalized).toEqual({ inputTokens: null, outputTokens: null });
    } else if (mode === 'missing-counter') {
      expect(telemetry.reported.reasoningTokens).toBeNull();
      expect(telemetry.normalized).toEqual({ inputTokens: 392, outputTokens: null });
    } else {
      expect(telemetry.coverage).toBe('partial');
      expect(telemetry.normalized).toEqual({ inputTokens: null, outputTokens: null });
      expect(telemetry.diagnostics.length).toBeGreaterThan(0);
      if (mode === 'conflicting-duplicate') expect(telemetry.diagnostics.join(' ')).toContain('conflict');
      if (mode === 'fractional-token') expect(telemetry.reported.inputTokens).toBeNull();
    }
  } finally { cleanupProviderProject(project); }
}, 20000);

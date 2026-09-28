import { expect, test } from 'vitest';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createUsageScenario, jsonLines } from '../support/observability-usage.js';
import { runDefaultProviderCli, readProviderCalls, cleanupProviderProject } from '../support/provider-adapter-scenarios.js';
import { getRunStatus } from '../../src/application/resume-workflow.js';


const stdout = jsonLines([
  { type: 'item.completed', item: { usage: { input_tokens: 999999 } } },
  { type: 'turn.started' },
  { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 20 } }
]);

test('OBS-003: Codex usage scenario', async () => {
  const scenario = await createUsageScenario('codex', stdout);
  const { project, logPath } = scenario;

  try {
    const { code, envelope } = await runDefaultProviderCli(project, 'usage');
    expect(code).toBe(0);
    expect(envelope.result.artifacts[0].data.message).toBe('usage fixture result');

    const providerCalls = readProviderCalls(logPath);
    expect(providerCalls.length).toBe(1);

    const status = await getRunStatus(project, envelope.runId);
    const call = status.metrics!.calls[0] as any;
    expect(call.telemetry).toBeDefined();
    expect(call.telemetry.reported).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: null,
      reasoningTokens: 20,
      costUsd: null,
    });
    expect(call.telemetry.normalized).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(call.telemetry.source.eventType).toBe('turn.completed');
    expect(call.telemetry.source.recordIds.length).toBe(1);
    expect(call.telemetry.reportedModel).toBeNull();

    const runRoot = path.join(project, '.nodulus/runs', envelope.runId);
    const telemetryJson = readFileSync(path.join(runRoot, 'calls', call.callId, 'telemetry.json'), 'utf8');
    expect(JSON.parse(telemetryJson)).toEqual(call.telemetry);
    expect(existsSync(path.join(runRoot, call.telemetry.source.transportRef))).toBe(true);
  } finally {
    cleanupProviderProject(project);
  }
}, 20000);


test.each(['unknown-version', 'two-turns', 'optional-missing', 'conflicting-terminal', 'overflow'] as const)('OBS-003 %s preserves honest coverage', async mode => {
  const usage = mode === 'optional-missing' ? { input_tokens: 8, output_tokens: 2 } : { input_tokens: mode === 'overflow' ? Number.MAX_SAFE_INTEGER : 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 20 };
  const terminal = { type: 'turn.completed', usage };
  const events: unknown[] = [{ type: 'turn.started' }, terminal];
  if (mode === 'two-turns' || mode === 'overflow') events.push(terminal, { type: 'turn.started' }, { type: 'turn.completed', usage });
  if (mode === 'conflicting-terminal') events.push({ type: 'turn.completed', usage: { ...usage, input_tokens: 99 } });
  const { project, logPath } = await createUsageScenario('codex', jsonLines(events), mode === 'unknown-version' ? '0.145.0' : '0.144.4');
  try {
    const result = await runDefaultProviderCli(project, 'usage');
    expect(result.code).toBe(0);
    expect(readProviderCalls(logPath)).toHaveLength(1);
    const telemetry = (await getRunStatus(project, result.envelope.runId)).metrics!.calls[0]!.telemetry!;
    if (mode === 'unknown-version') {
      expect(telemetry.reported.inputTokens).toBe(1000);
      expect(telemetry.normalized).toEqual({ inputTokens: null, outputTokens: null });
      expect(telemetry.semantics.evidence).toBeNull();
    } else if (mode === 'two-turns') {
      expect(telemetry.stepCount).toBe(2);
      expect(telemetry.reported).toMatchObject({ inputTokens: 2000, outputTokens: 200 });
      expect(telemetry.coverage).toBe('complete');
    } else if (mode === 'optional-missing') {
      expect(telemetry.reported).toMatchObject({ inputTokens: 8, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, costUsd: null });
      expect(telemetry.normalized).toEqual({ inputTokens: 8, outputTokens: 2 });
    } else {
      expect(telemetry.coverage).toBe('partial');
      expect(telemetry.normalized).toEqual({ inputTokens: null, outputTokens: null });
      expect(telemetry.diagnostics.join(' ')).toMatch(mode === 'overflow' ? /overflow/ : /conflict/i);
      if (mode === 'overflow') expect(telemetry.reported.inputTokens).toBeNull();
    }
  } finally { cleanupProviderProject(project); }
}, 20000);


test('OBS-003 readiness failure cannot inherit the previous call telemetry', async () => {
  const { project, logPath } = await createUsageScenario('codex', stdout);
  const config = path.join(project, '.nodulus');
  const controlPath = path.join(config, 'fixtures/usage-control.json');
  const control = JSON.parse(readFileSync(controlPath, 'utf8'));
  writeFileSync(controlPath, JSON.stringify({ ...control, failAuthAfterInference: true }));
  const node = JSON.parse(readFileSync(path.join(config, 'nodes/example.json'), 'utf8'));
  writeFileSync(path.join(config, 'nodes/second.json'), JSON.stringify({ ...node, id: 'second' }));
  const workflowPath = path.join(config, 'workflows/example.json');
  const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
  writeFileSync(workflowPath, JSON.stringify({ ...workflow, nodes: ['example', 'second'] }));
  try {
    const result = await runDefaultProviderCli(project, 'usage');
    expect(result.code).toBe(1);
    expect(result.envelope.result.error.code).toBe('PROVIDER_FAILURE');
    expect(result.envelope.result.error.message).toMatch(/authentication check failed/);
    expect(readProviderCalls(logPath)).toHaveLength(1);
    const calls = (await getRunStatus(project, result.envelope.runId)).metrics!.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.telemetry!.reported.inputTokens).toBe(1000);
    expect(calls[1]!.callId).not.toBe(calls[0]!.callId);
    expect(calls[1]!.telemetry).toBeUndefined();
    expect(calls[1]!.usage).toBeNull();
  } finally { cleanupProviderProject(project); }
}, 20000);

import { test, expect } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createUsageScenario, jsonLines } from '../support/observability-usage.js';
import { runDefaultProviderCli, readProviderCalls, cleanupProviderProject } from '../support/provider-adapter-scenarios.js';
import { getRunStatus } from '../../src/application/resume-workflow.js';

test('OBS-006 - output limit', async () => {
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

  const { project, logPath } = await createUsageScenario('opencode', jsonLines([event]));

  try {
    appendFileSync(path.join(project, '.nodulus/fixtures/opencode-fixture.mjs'), "\nawait new Promise(resolve => process.stdout.write('x'.repeat(3 * 1024 * 1024), resolve));\n");

    const result = await runDefaultProviderCli(project, 'output limit exceeded');

    expect(result.code).toBe(1);
    expect(result.envelope.status).toBe('error');
    expect(result.envelope.result.error.code).toBe('PROVIDER_OUTPUT_LIMIT');

    const telemetry = result.envelope.runId ? await getRunStatus(project, result.envelope.runId) : null;
    expect(telemetry.metrics!.calls.length).toBe(1);

    const call = telemetry.metrics!.calls[0]!;
    expect(call.telemetry!.coverage).toBe('partial');
    expect(call.telemetry!.reported.inputTokens).toBe(100);
    expect(call.telemetry!.reported.outputTokens).toBe(20);
    expect(call.telemetry!.normalized.inputTokens).toBe(null);
    expect(call.telemetry!.normalized.outputTokens).toBe(null);

    const jsonPath = path.join(project, '.nodulus/runs', result.envelope.runId, call.telemetry!.source.transportRef!);
    const exitData = JSON.parse(readFileSync(jsonPath, 'utf-8'));

    expect(exitData.outputLimitExceeded).toBe(true);
    expect(exitData.timedOut).toBe(false);
    expect(Buffer.byteLength(exitData.stdout)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(exitData.stdout).toContain(JSON.stringify(event));

    const providerCalls = readProviderCalls(logPath);
    expect(providerCalls.length).toBe(1);
  } finally {
    cleanupProviderProject(project);
  }
}, 20000);

import { test, expect } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createUsageScenario, jsonLines } from '../support/observability-usage.js';
import { runDefaultProviderCli, readProviderCalls, cleanupProviderProject } from '../support/provider-adapter-scenarios.js';
import { getRunStatus } from '../../src/application/resume-workflow.js';

test('OBS-006B retains captured usage when the real provider times out', async () => {
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
    const settingsFile=path.join(project,'.nodulus/settings.json');
    const settings=JSON.parse(readFileSync(settingsFile,'utf8'));
    settings.providerProfiles.fixture.timeoutMs=1000;
    writeFileSync(settingsFile,JSON.stringify(settings));
    appendFileSync(path.join(project, '.nodulus/fixtures/opencode-fixture.mjs'), 'setInterval(() => {}, 1000);\n');

    const result = await runDefaultProviderCli(project, 'timeout');

    expect(result.envelope.status).toBe('error');
    expect(result.envelope.result.error.code).toBe('PROVIDER_TIMEOUT');
    expect(result.envelope.runId).not.toBeUndefined();

    let status = await getRunStatus(project, result.envelope.runId);
    expect(status.metrics!.calls.length).toBe(1);

    status = await getRunStatus(project, result.envelope.runId);

    const telemetry = status.metrics!.calls[0]!.telemetry!;

    expect(telemetry.coverage).toBe('partial');
    expect(status.metrics!.calls[0]!.usage).toBeNull();
    expect(telemetry.reported.costUsd).toBe(0.001);
    expect(telemetry.reported.inputTokens).toBe(100);
    expect(telemetry.reported.outputTokens).toBe(20);
    expect(telemetry.reported.cacheReadTokens).toBe(30);
    expect(telemetry.reported.cacheWriteTokens).toBe(5);
    expect(telemetry.reported.reasoningTokens).toBe(4);
    expect(telemetry.normalized.inputTokens).toBe(null);
    expect(telemetry.normalized.outputTokens).toBe(null);
    expect(telemetry.source.transportRef).not.toBeUndefined();
    expect(telemetry.diagnostics).toContain('Provider transport did not complete successfully');

    const jsonPath = path.join(project, '.nodulus/runs', result.envelope.runId, telemetry.source.transportRef!);
    const exitData = JSON.parse(readFileSync(jsonPath, 'utf-8'));

    expect(result.code).toBe(1);
    expect(exitData.timedOut).toBe(true);
    expect(exitData.outputLimitExceeded).toBe(false);
    expect(exitData.stdout).toContain(JSON.stringify(event));

    const providerCalls = readProviderCalls(logPath);
    expect(providerCalls.length).toBe(1);
  } finally {
    cleanupProviderProject(project);
  }
}, 10000);
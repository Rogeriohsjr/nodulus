import { test, expect } from 'vitest';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  let result: Awaited<ReturnType<typeof runDefaultProviderCli>> | undefined;
  let failed = false;
  let failure: unknown;

  try {
    const settingsFile=path.join(project,'.nodulus/settings.json');
    const settings=JSON.parse(readFileSync(settingsFile,'utf8'));
    settings.providerProfiles.fixture.timeoutMs=1000;
    writeFileSync(settingsFile,JSON.stringify(settings));
    appendFileSync(path.join(project, '.nodulus/fixtures/opencode-fixture.mjs'), 'setInterval(() => {}, 1000);\n');

    result = await runDefaultProviderCli(project, 'timeout');

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
  } catch (error) {
    failed = true;
    failure = error;
    try {
      const envelope = result?.envelope as { runId?: unknown; result?: { error?: { code?: unknown; message?: unknown } } } | undefined;
      const runId = typeof envelope?.runId === 'string' ? envelope.runId : undefined;
      const diagnostic: Record<string, unknown> = {
        retainedProject: project,
        publicError: {
          code: typeof envelope?.result?.error?.code === 'string' ? envelope.result.error.code.slice(0, 120) : null,
          message: typeof envelope?.result?.error?.message === 'string' ? envelope.result.error.message.slice(0, 500) : null,
        },
        runId: runId ?? null,
        stdoutTail: result?.stdout.slice(-500) ?? null,
        stderrTail: result?.stderr.slice(-500) ?? null,
      };
      if (runId) {
        try {
          const status = await getRunStatus(project, runId);
          const calls = status.metrics?.calls ?? [];
          const call = calls[0];
          const callId = typeof call?.callId === 'string' ? call.callId : undefined;
          const metricTransportRef = call?.telemetry?.source?.transportRef;
          const transportRef = typeof metricTransportRef === 'string'
            ? metricTransportRef
            : callId ? `calls/${callId}/transport.json` : undefined;
          diagnostic.savedCall = {
            callCount: calls.length,
            callId: callId ?? null,
            transportRef: typeof transportRef === 'string' ? transportRef.slice(0, 512) : null,
            transportRefSource: typeof metricTransportRef === 'string' ? 'metrics' : callId ? 'callId-fallback' : 'unavailable',
          };
          if (typeof transportRef === 'string' && !path.isAbsolute(transportRef)) {
            const runDirectory = path.resolve(project, '.nodulus/runs', runId);
            const transportPath = path.resolve(runDirectory, transportRef);
            if (transportPath.startsWith(`${runDirectory}${path.sep}`)) {
              try {
                const transport = JSON.parse(readFileSync(transportPath, 'utf8')) as Record<string, unknown>;
                diagnostic.savedCall = {
                  ...(diagnostic.savedCall as Record<string, unknown>),
                  started: typeof transport.started === 'boolean' ? transport.started : null,
                  exitCode: typeof transport.exitCode === 'number' || transport.exitCode === null ? transport.exitCode : null,
                  timedOut: typeof transport.timedOut === 'boolean' ? transport.timedOut : null,
                  cancelled: typeof transport.cancelled === 'boolean' ? transport.cancelled : null,
                  outputLimitExceeded: typeof transport.outputLimitExceeded === 'boolean' ? transport.outputLimitExceeded : null,
                  terminationCause: typeof transport.terminationCause === 'string' ? transport.terminationCause.slice(0, 120) : null,
                  cleanupUnverified: transport.cleanupUnverified && typeof transport.cleanupUnverified === 'object'
                    ? {
                      present: true,
                      code: typeof (transport.cleanupUnverified as Record<string, unknown>).code === 'string'
                        ? ((transport.cleanupUnverified as Record<string, unknown>).code as string).slice(0, 120)
                        : null,
                      operationCause: typeof (transport.cleanupUnverified as Record<string, unknown>).operationCause === 'string'
                        ? ((transport.cleanupUnverified as Record<string, unknown>).operationCause as string).slice(0, 120)
                        : null,
                    }
                    : { present: transport.cleanupUnverified !== undefined, code: null, operationCause: null },
                  stdoutTail: typeof transport.stdout === 'string' ? transport.stdout.slice(-500) : null,
                  stderrTail: typeof transport.stderr === 'string' ? transport.stderr.slice(-500) : null,
                };
              } catch { diagnostic.transportRead = 'unavailable'; }
            } else {
              diagnostic.transportRead = 'reference outside saved run directory';
            }
          }
        } catch { diagnostic.savedCall = 'unavailable'; }
      } else {
        diagnostic.savedCall = 'run id unavailable';
      }
      try {
        const markerExists = existsSync(logPath);
        const markerCount = markerExists ? readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).length : 0;
        diagnostic.providerInvocationMarker = {
          exists: markerExists,
          count: markerCount,
          truncated: markerCount > 64,
        };
      } catch { diagnostic.providerInvocationMarker = 'unavailable'; }
      process.stderr.write(`OBS-006B retained project after assertion/run failure: ${project}; diagnostic=${JSON.stringify(diagnostic).slice(0, 6000)}\n`);
    } catch {
      try { process.stderr.write(`OBS-006B retained project after assertion/run failure: ${project}; diagnostic unavailable.\n`); } catch { /* Preserve the original failure if stderr is unavailable. */ }
    }
  } finally {
    if (!failed) cleanupProviderProject(project);
  }
  if (failed) throw failure;
}, 10000);

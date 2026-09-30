import { describe, expect, it } from 'vitest';
import {
  createUsageScenario,
  jsonLines,
  usageOutcome,
} from '../support/observability-usage.js';
import {
  runDefaultProviderCli,
  readProviderCalls,
  cleanupProviderProject,
} from '../support/provider-adapter-scenarios.js';
import { getRunStatus } from '../../src/application/resume-workflow.js';

const costCases = [
  { cost: 0, valid: true },
  { cost: 0.001, valid: true },
  { cost: -1, valid: false },
  { cost: '0.01', valid: false },
  { cost: {}, valid: false },
];

describe('obs-007-cost-validation', () => {
  for (const { cost, valid } of costCases) {
    it(`reports cost ${JSON.stringify(cost)} as ${valid ? 'valid' : 'invalid'}`, async () => {
      const events = [
        { type: 'text', part: { messageID: 'm', text: usageOutcome } },
        {
          type: 'step_finish',
          part: {
            id: 'A',
            sessionID: 's',
            messageID: 'm',
            reason: 'stop',
            tokens: {
              input: 10,
              output: 2,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            cost,
          },
        },
      ];

      const { project, logPath } = await createUsageScenario(
        'opencode',
        jsonLines(events),
      );

      try {
        const result = await runDefaultProviderCli(project, 'cost validation');
        expect(result.code).toBe(0);
        expect(result.envelope.result.artifacts[0].data.message).toBe(
          'usage fixture result',
        );

        const providerCalls = readProviderCalls(logPath);
        expect(providerCalls).toHaveLength(1);

        const status = await getRunStatus(project, result.envelope.runId);
        const telemetry = status.metrics!.calls[0]!.telemetry!;

        if (valid) {
          expect(telemetry.normalized).toEqual({ inputTokens: 10, outputTokens: 2 });
          expect(telemetry.reported.costUsd).toBe(cost);
          expect(telemetry.reported.inputTokens).toBe(10);
          expect(telemetry.reported.outputTokens).toBe(2);
        } else {
          expect(telemetry.reported.costUsd).toBeNull();
          const diagnostics = telemetry.diagnostics.join(' ');
          expect(diagnostics).toContain('costUsd');
          expect(telemetry.reported.inputTokens).toBe(10);
          expect(telemetry.reported.outputTokens).toBe(2);
        }
      } finally {
        cleanupProviderProject(project);
      }
    }, 20000);
  }
});
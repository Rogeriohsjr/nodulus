import { test, expect } from 'vitest';
import { runCli } from '../../src/cli.js';
import { createProviderScenario, runDefaultProviderCli, readProviderCalls, cleanupProviderProject } from '../support/provider-adapter-scenarios.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const testCases = [
  { accepted: false },
  { accepted: true }
];

test.each(testCases)('obs-002-correlated-timeline', async ({ accepted }) => {
  const { project, logPath } = await createProviderScenario('codex');
  try {
    const exampleJsonPath = path.join(project, '.nodulus', 'nodes', 'example.json');
    const exampleJson = JSON.parse(fs.readFileSync(exampleJsonPath, 'utf8'));
    const secondJsonPath = path.join(project, '.nodulus', 'nodes', 'second.json');
    const secondJson = { ...exampleJson, id: 'second' };
    fs.writeFileSync(secondJsonPath, JSON.stringify(secondJson, null, 2));

    const workflowJsonPath = path.join(project, '.nodulus', 'workflows', 'example.json');
    const workflowJson = {
      schemaVersion: 1,
      id: 'example',
      nodes: ['example', 'second']
    };
    fs.writeFileSync(workflowJsonPath, JSON.stringify(workflowJson, null, 2));

    const validatorScriptPath = path.join(project, '.nodulus', 'validators', 'obs.mjs');
    fs.mkdirSync(path.dirname(validatorScriptPath), { recursive: true });
    const validatorScript = `for await (const chunk of process.stdin) { void chunk; }
process.stdout.write(JSON.stringify({ valid: ${accepted}, errors: ${accepted} ? [] : ['blocked by fixture'] }));`;
    fs.writeFileSync(validatorScriptPath, validatorScript);

    exampleJson.expectedOutputs[0].validator = '.nodulus/validators/obs.mjs';
    fs.writeFileSync(exampleJsonPath, JSON.stringify(exampleJson, null, 2));

    const result = await runDefaultProviderCli(project, 'timeline request');
    expect(result.code).toBe(accepted ? 0 : 1);
    const calls = readProviderCalls(logPath);
    expect(calls).toHaveLength(accepted ? 2 : 1);
    const runRoot = path.join(project, '.nodulus', 'runs', result.envelope.runId);
    const eventText = fs.readFileSync(path.join(runRoot, 'events.jsonl'), 'utf8');
    const events = eventText.trim().split('\n').map(line => JSON.parse(line));
    let previousSequence = 0;
    for (const event of events) {
      expect(event.timestamp).toBeTypeOf('string');
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
      expect(Number.isInteger(event.sequence)).toBe(true);
      expect(event.sequence).toBeGreaterThan(previousSequence);
      previousSequence = event.sequence;
    }

    const exampleStarted = events.find(event => event.event === 'provider.call.started' && event.nodeId === 'example');
    const exampleCompleted = events.find(event => event.event === 'provider.call.completed' && event.nodeId === 'example' && event.callId === exampleStarted.callId);
    const validationCompleted = events.find(event => event.event === 'node.validation.completed' && event.nodeId === 'example' && event.callId === exampleStarted.callId);

    expect(exampleStarted.timestamp).toBeTypeOf('string');
    expect(new Date(exampleStarted.timestamp).toISOString()).toBe(exampleStarted.timestamp);
    expect(exampleStarted.sequence).toBeTypeOf('number');
    expect(exampleCompleted.sequence).toBeTypeOf('number');
    expect(validationCompleted.sequence).toBeTypeOf('number');
    expect(exampleStarted.sequence < exampleCompleted.sequence && exampleCompleted.sequence < validationCompleted.sequence).toBe(true);
    expect(exampleCompleted.elapsedMs).toBeTypeOf('number');
    expect(exampleCompleted.elapsedMs >= 0).toBe(true);

    const requestJson = JSON.parse(fs.readFileSync(path.join(runRoot, 'calls', exampleStarted.callId, 'request.json'), 'utf-8'));
    const validationJson = JSON.parse(fs.readFileSync(path.join(runRoot, validationCompleted.validationRef), 'utf-8'));

    expect(requestJson.callId).toBe(exampleStarted.callId);
    expect(Number.isFinite(exampleCompleted.elapsedMs)).toBe(true);
    expect(validationJson.valid).toBe(accepted);

    if (accepted) {
      const secondStarted = events.find(event => event.event === 'node.started' && event.nodeId === 'second');
      expect(secondStarted.sequence).toBeTypeOf('number');
      expect(secondStarted.sequence > validationCompleted.sequence).toBe(true);
    } else {
      expect(events.find(event => event.event === 'node.started' && event.nodeId === 'second')).toBeUndefined();
    }

    expect(eventText).not.toContain('fixture-secret-must-not-be-captured');
    expect(events.every(event => !event.credentials)).toBe(true);
  } finally {
    cleanupProviderProject(project);
  }
}, 20000);


test.each(['invoke', 'repair_response'] as const)('OBS-002 marks a non-string %s boundary response as a failed call', async (operation) => {
  const { project } = await createProviderScenario('codex', 'repair-multiple');
  try {
    let stdout = '';
    const code = await runCli(['node', 'nodulus', 'run', '--project', project, '--request', 'invalid boundary', '--json'],
      { writeOut: text => { stdout += text; }, writeErr: () => {} },
      { cwd: project, provider: {
        invoke: async () => operation === 'invoke' ? 42 as unknown as string : 'malformed outcome',
        repairResponse: async () => 42 as unknown as string,
      } });
    expect(code).toBe(1);
    const result = JSON.parse(stdout);
    const events = fs.readFileSync(path.join(project, '.nodulus/runs', result.runId, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const completed = events.find(event => event.event === 'provider.call.completed' && event.operation === operation);
    expect(completed).toMatchObject({ failed: true });
    expect(events.find(event => event.event === 'node.validation.completed' && event.callId === completed.callId)).toMatchObject({ valid: false });
  } finally { cleanupProviderProject(project); }
});

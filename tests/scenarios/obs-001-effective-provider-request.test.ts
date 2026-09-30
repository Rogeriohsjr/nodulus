import { test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createProviderScenario, runDefaultProviderCli, readProviderCalls, cleanupProviderProject } from '../support/provider-adapter-scenarios.js';

const loadPrelude = () => {
  const preludePath = new URL('../fixtures/observability/prelaunch.mjs', import.meta.url);
  return readFileSync(preludePath, 'utf8');
};

const updateFixtureWithPrelude = (project: string, kind: string, prelude: string) => {
  const fixturePath = path.join(project, '.nodulus', 'fixtures', `${kind}-fixture.mjs`);
  const existingContent = readFileSync(fixturePath, 'utf8');
  writeFileSync(fixturePath, `${prelude}
${existingContent}`);
};

test.each(["codex", "cursor", "opencode"] as const)(
  'OBS-001 Effective provider request for %s',
  async (kind) => {
    const prelude = loadPrelude();
    const { project, logPath } = await createProviderScenario(kind);

    try {
      writeFileSync(path.join(project, '.nodulus', 'instructions', 'example.md'), 'Observe instructions\nSecond line Ω', 'utf8');
      updateFixtureWithPrelude(project, kind, prelude);

      const result = await runDefaultProviderCli(project, 'Multiline request\nUnicode Ω');
      expect(result.code).toBe(0);

      const runRoot = path.join(project, '.nodulus', 'runs', result.envelope.runId);
      const callsDir = path.join(runRoot, 'calls');
      expect(existsSync(callsDir)).toBe(true);

      const calls = readdirSync(callsDir);
      expect(calls.length).toBe(1);

      const call = calls[0];
      const stdinPath = path.join(callsDir, call, 'stdin.txt');
      const stdinContent = readFileSync(stdinPath, 'utf8');

      const providerCalls = readProviderCalls(logPath);
      expect(providerCalls.length).toBe(1);
      expect(stdinContent).toBe(providerCalls[0].stdin);
      expect(stdinContent).toContain('Unicode Ω');

      const observedPath = path.join(project, '.nodulus', 'fixtures', 'observed.json');
      const observed = JSON.parse(readFileSync(observedPath, 'utf-8'));
      expect(observed).toHaveLength(1);
      const request = observed[0].request;

      const savedText = readFileSync(stdinPath, 'utf-8');
      expect(observed[0].stdin).toBe(savedText);
      expect(providerCalls[0].stdin).toBe(savedText);

      expect(request.schemaVersion).toBe(1);
      expect(request.runId).toBe(result.envelope.runId);
      expect(request.nodeId).toBe('example');
      expect(request.attempt).toBe(1);
      expect(request.callId).toBe(call);
      expect(request.operation).toBe('invoke');
      expect(request.provider).toBe(kind);
      expect(request.requestedModel).toBe(kind === 'opencode' ? 'ollama/qwen3.5:9b' : 'fixture-model');
      expect(request.cwd).toBe(project);
      expect(JSON.stringify(request.argv)).toBe(JSON.stringify(providerCalls[0].argv));

      expect(request.refs.prompt).not.toBeUndefined();
      expect(request.refs.stdin).not.toBeUndefined();
      expect(request.refs.transport).not.toBeUndefined();
      expect(request.refs.response).not.toBeUndefined();
      expect(request.refs.validation).not.toBeUndefined();
      expect(request.refs.result).toBeDefined();
      expect(request.refs.invocation).toBeDefined();

      [request.refs.prompt, request.refs.stdin, request.refs.transport, request.refs.response, request.refs.validation, request.refs.result, request.refs.invocation].forEach(ref => {
        expect(path.isAbsolute(ref)).toBe(false);
        expect(existsSync(path.join(runRoot, ref))).toBe(true);
      });

      expect(request.refs.response).not.toBe(request.refs.transport);
      expect(request.refs.result).not.toBe(request.refs.response);
      expect(JSON.parse(readFileSync(path.join(runRoot, request.refs.result), "utf8")).status).toBe("success");
      const promptContent = readFileSync(path.join(runRoot, request.refs.prompt), 'utf-8');
      expect(promptContent).toContain('Observe instructions');

      if (kind === 'codex') {
        expect(stdinContent).toContain('Codex transport envelope');
      } else if (kind === 'opencode') {
        expect(stdinContent).toContain('OpenCode transport instruction');
      }

      expect(JSON.stringify(request)).not.toContain('fixture-secret-must-not-be-captured');
    } finally {
      cleanupProviderProject(project);
    }
  },
  20000
);


test('OBS-001 captures a validated mapped predecessor artifact in the effective stdin', async () => {
  const { project, logPath } = await createProviderScenario('codex');
  try {
    const first = JSON.parse(readFileSync(path.join(project, '.nodulus/nodes/example.json'), 'utf8'));
    const consumer = { ...first, id: 'consumer', inputs: { previous: { from: 'example.example', contract: 'example.v1' } } };
    writeFileSync(path.join(project, '.nodulus/nodes/consumer.json'), JSON.stringify(consumer));
    writeFileSync(path.join(project, '.nodulus/workflows/example.json'), JSON.stringify({ schemaVersion: 1, id: 'example', nodes: ['example', 'consumer'] }));
    const result = await runDefaultProviderCli(project, 'Caller-only request');
    expect(result.code).toBe(0);
    const providerCalls = readProviderCalls(logPath);
    expect(providerCalls).toHaveLength(2);
    const runRoot = path.join(project, '.nodulus/runs', result.envelope.runId);
    const records = readdirSync(path.join(runRoot, 'calls')).map(id => JSON.parse(readFileSync(path.join(runRoot, 'calls', id, 'request.json'), 'utf8')));
    const consumerCall = records.find(record => record.nodeId === 'consumer');
    const stdin = readFileSync(path.join(runRoot, consumerCall.refs.stdin), 'utf8');
    expect(stdin).toBe(providerCalls[1].stdin);
    const artifact = JSON.parse(readFileSync(path.join(runRoot, 'nodes/example/artifacts/example.json'), 'utf8'));
    expect(artifact.data).toEqual({ message: 'fixture result' });
    expect(stdin).toContain(artifact.data.message);
    expect(stdin).toContain('previous');
    expect(stdin).not.toContain('Caller-only request');
    expect(JSON.parse(readFileSync(path.join(runRoot, 'nodes/example/attempt-001/validation.json'), 'utf8')).valid).toBe(true);
  } finally { cleanupProviderProject(project); }
}, 20000);


test('OBS-001 stops before inference when effective request persistence fails', async () => {
  const { project, logPath } = await createProviderScenario('codex');
  try {
    const fixture = path.join(project, '.nodulus/fixtures/codex-fixture.mjs');
    const prelude = `import * as obsFs from 'node:fs';
import obsPath from 'node:path';
if (process.argv[2] === '--version') {
  const runs = obsPath.join(process.cwd(), '.nodulus/runs');
  for (const run of obsFs.readdirSync(runs)) {
    if (obsFs.statSync(obsPath.join(runs, run)).isDirectory()) obsFs.writeFileSync(obsPath.join(runs, run, 'calls'), 'fixture blocks directory creation');
  }
}
`;
    writeFileSync(fixture, prelude + readFileSync(fixture, 'utf8'));
    const result = await runDefaultProviderCli(project, 'Do not launch without request evidence');
    expect(result.code).toBe(1);
    expect(result.envelope.result.error.code).toBe('PROVIDER_FAILURE');
    expect(readProviderCalls(logPath)).toHaveLength(0);
    const runRoot = path.join(project, '.nodulus/runs', result.envelope.runId);
    expect(readFileSync(path.join(runRoot, 'calls'), 'utf8')).toBe('fixture blocks directory creation');
    const events = readFileSync(path.join(runRoot, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.find(event => event.event === 'provider.call.completed')).toMatchObject({ failed: true });
  } finally { cleanupProviderProject(project); }
}, 20000);

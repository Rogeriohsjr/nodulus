import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runWorkflow } from '../../src/application/run-workflow.js';
import { fileHash } from '../../scripts/task-workflow/io.mjs';

test.each(['valid', 'stale-test', 'stale-source', 'artifact-tamper', 'check-tamper', 'legacy', 'bound', 'review-only', 'docs-only', 'recheck-fails', 'recheck-mutates', 'bad-order', 'aliased-entry'])(
  'IMP-11 %s recovery preserves accepted work', async mode => {
    const project = mkdtempSync(path.join(tmpdir(), 'Nodulus recovery ü '));
    const read = (file: string) => JSON.parse(readFileSync(path.join(project, file), 'utf8'));
    const save = (file: string, data: unknown) => writeFileSync(path.join(project, file), JSON.stringify(data));
    try {
      cpSync('examples/task-planning/.nodulus', path.join(project, '.nodulus'), { recursive: true });
      cpSync('scripts/task-workflow', path.join(project, '.nodulus/task-tools'), { recursive: true });
      mkdirSync(path.join(project, 'docs'));
      writeFileSync(path.join(project, 'source.ts'), 'old');
      writeFileSync(path.join(project, 'test.ts'), 'frozen');
      const docsOnly = mode === 'docs-only';
      writeFileSync(path.join(project, 'check.cjs'), `const fs=require('node:fs');process.exit(fs.readFileSync('source.ts','utf8') === '${docsOnly ? 'old' : 'new'}' ? 0 : 1);`);
      const task = { id: 'T1', kind: docsOnly ? 'documentation' : 'runtime', testing: { mode: docsOnly ? 'non-tdd' : 'tdd', testFile: docsOnly ? null : 'test.ts', checkIds: ['focused'] }, files: [{ path: docsOnly ? 'docs/change.md' : 'source.ts' }], documentation: ['docs/change.md'] };
      const files = ['source.ts', 'test.ts', 'docs/change.md'].map(file => ({ path: file, sha256: fileHash(path.join(project, file)), exists: existsSync(path.join(project, file)), content: existsSync(path.join(project, file)) ? readFileSync(path.join(project, file), 'utf8') : null }));
      const repo = { id: 'repo', root: project, files, checks: [{ id: 'focused', executable: process.execPath, args: ['check.cjs'] }] };
      save('.nodulus/task-execution.json', { executionId: 'fixture', contextHash: 'fixture-hash', task, repo, hashes: Object.fromEntries(files.map(file => [file.path, file.sha256])), completed: [] });
      const calls: string[] = [];
      const outcome = (name: string, contract: string, data: unknown) => JSON.stringify({ status: 'success', artifacts: [{ name, contract, data }] });
      const changes = (file: string, content: string) => outcome('changes', 'task-change.v1', { files: [{ path: file, content }], summary: 'Fixture change' });
      const initial = await runWorkflow({ projectRoot: project, cwd: project, workflow: docsOnly ? 'task-document' : 'task-implement', callerInputs: { packet: { task, repository: repo, contextHash: 'fixture-hash' } }, sources: [{ kind: 'inline', text: 'Change source' }] }, { async invoke(invocation) {
        calls.push(invocation.nodeId);
        if (invocation.nodeId === 'packet-code') return changes('source.ts', 'new');
        if ((docsOnly || mode === 'review-only') && ['packet-docs', 'packet-document'].includes(invocation.nodeId)) return changes('docs/change.md', '# Actual change');
        return '{}';
      } });
      expect(initial.status).toBe('error');
      const state = read('.nodulus/task-execution.json');
      if (mode === 'valid') expect(state.accepted?.code?.artifact?.files[0].content).toBe('new');
      if (mode === 'stale-test') writeFileSync(path.join(project, 'test.ts'), 'changed');
      if (mode === 'stale-source') writeFileSync(path.join(project, 'source.ts'), 'changed');
      if (mode === 'artifact-tamper') { state.accepted ??= {}; state.accepted.code ??= {}; state.accepted.code.artifact = { files: [{ path: 'source.ts', content: 'tampered' }] }; save('.nodulus/task-execution.json', state); }
      if (mode === 'check-tamper') writeFileSync(path.join(project, '.nodulus/task-receipts/fixture/code-focused.json'), '{}');
      if (mode === 'legacy') { delete state.accepted; save('.nodulus/task-execution.json', state); }
      if (mode === 'recheck-fails') writeFileSync(path.join(project, 'check.cjs'), 'process.exit(7);');
      if (mode === 'recheck-mutates') writeFileSync(path.join(project, 'check.cjs'), "require('node:fs').writeFileSync('test.ts','changed by check');");
      if (mode === 'bad-order') { state.completed = ['docs', 'code']; save('.nodulus/task-execution.json', state); }
      const entryRoot = mode === 'aliased-entry' ? path.join(project, 'entry-alias') : project;
      if (mode === 'aliased-entry') symlinkSync(project, entryRoot, 'junction');
      const prepare = () => spawnSync(process.execPath, [path.join(entryRoot, '.nodulus/task-tools/runtime.mjs'), 'recover', project], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      const prepared = prepare();
      const rejected = ['stale-test', 'stale-source', 'artifact-tamper', 'check-tamper', 'legacy', 'recheck-fails', 'recheck-mutates', 'bad-order'].includes(mode);
      expect(prepared.status, prepared.stderr).toBe(rejected ? 1 : 0);
      expect(existsSync(path.join(project, '.nodulus/task-recover-inputs.json'))).toBe(!rejected);
      if (rejected) return;
      if (mode === 'bound') { expect(prepare().status).toBe(1); return; }
      const recoveryInputs = read('.nodulus/task-recover-inputs.json');
      const beforeRecoveryCalls = calls.length;
      const recovered = await runWorkflow({ projectRoot: project, cwd: project, workflow: 'task-recover', callerInputs: recoveryInputs, sources: [{ kind: 'inline', text: 'Correct the remaining phase only' }] }, { async invoke(invocation) {
        calls.push(invocation.nodeId);
        if (invocation.nodeId === 'recovery-docs') return changes('docs/change.md', '# Actual change');
        if (invocation.nodeId === 'recovery-review') return outcome('review', 'task-review.v1', { decision: 'accept', summary: 'Fixture reviewed' });
        throw Error(`Unexpected recovery inference: ${invocation.nodeId}`);
      } });
      expect(recovered.status).toBe('success');
      expect(calls.slice(beforeRecoveryCalls)).toEqual(['valid', 'aliased-entry'].includes(mode) ? ['recovery-docs', 'recovery-review'] : ['recovery-review']);
      expect(calls.filter(id => id === 'packet-code')).toHaveLength(docsOnly ? 0 : 1);
      expect(readFileSync(path.join(project, 'source.ts'), 'utf8')).toBe(docsOnly ? 'old' : 'new');
      expect(readFileSync(path.join(project, 'test.ts'), 'utf8')).toBe('frozen');
      const receipts = readdirSync(path.join(project, '.nodulus/task-receipts/fixture')).filter(file => file.endsWith('.json')).map(file => read(`.nodulus/task-receipts/fixture/${file}`));
      expect(receipts.filter(receipt => receipt.path === 'source.ts' && receipt.applied)).toHaveLength(docsOnly ? 0 : 1);
      expect(existsSync(path.join(project, '.nodulus/task-completed/fixture-hash/T1.json'))).toBe(true);
      expect(prepare().status).toBe(1);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 30000,
);

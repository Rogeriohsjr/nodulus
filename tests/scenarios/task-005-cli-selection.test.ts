import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { fileHash } from '../../scripts/task-workflow/io.mjs';
import { runWorkflow } from '../../src/application/run-workflow.js';

test.each(['missing-hash', 'wrong-hash', 'approved', 'unfinished', 'stale', 'red-test-mutation', 'red-source-mutation', 'documentation'])(
  'TASK-005 CLI selection %s uses actual context, RED command and workflow', async mode => {
    const root = mkdtempSync(path.join(tmpdir(), 'Nodulus selection Ã¼ '));
    const cli = (...args: string[]) => spawnSync(process.execPath, [path.resolve('scripts/task-workflow/cli.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
    const save = (file: string, value: unknown) => writeFileSync(path.join(root, file), JSON.stringify(value));
    try {
      expect(cli('setup', root).status).toBe(0);
      writeFileSync(path.join(root, 'source.ts'), 'export const example = 1;');
      const mutation = mode === 'red-test-mutation' ? "require('node:fs').writeFileSync('test.cjs','mutated');" : mode === 'red-source-mutation' ? "require('node:fs').writeFileSync('source.ts','mutated');" : '';
      writeFileSync(path.join(root, 'test.cjs'), mutation + "require('node:fs').writeFileSync('check-ran','yes');console.error('behavioral RED');process.exit(1);");
      const docs = mode === 'documentation';
      save('manifest.json', { repositories: [{ id: 'repo', root, files: ['source.ts', 'test.cjs', 'change.md'], checks: [{ id: 'focused', executable: process.execPath, args: docs ? ['--version'] : ['test.cjs'], redContains: 'behavioral RED' }] }] });
      expect(cli('prepare', path.join(root, 'manifest.json'), root).status).toBe(0);
      const context = JSON.parse(readFileSync(path.join(root, '.nodulus/task-context.json'), 'utf8'));
      const task = { id: 'T1', repoId: 'repo', title: 'One change', kind: docs ? 'documentation' : 'runtime', dependsOn: [], goal: 'One result', files: [{ path: docs ? 'change.md' : 'source.ts', symbol: 'example', change: docs ? 'NEW: explain example' : 'Return two' }], references: [{ path: 'source.ts', symbol: 'example' }], acceptance: ['Correct result'], testing: { mode: docs ? 'non-tdd' : 'tdd', testFile: docs ? null : 'test.cjs', expectedFailure: docs ? null : 'behavioral RED', exception: docs ? 'Markdown only; verify actual rendering/content separately and run configured check' : null, checkIds: ['focused'] }, documentation: ['change.md'] };
      const plan = { contextHash: context.contextHash, decision: 'ready', summary: 'Small', questions: [], tasks: [task] };
      save('plan.json', { status: 'success', result: { artifacts: [{ name: 'plan', contract: 'task-plan.v1', data: plan }] } });
      if (mode === 'unfinished') save('.nodulus/task-execution.json', { completed: [] });
      if (mode === 'stale') writeFileSync(path.join(root, 'source.ts'), 'coworker');
      const approvedHash = mode === 'missing-hash' ? [] : [mode === 'wrong-hash' ? 'wrong' : fileHash(path.join(root, 'test.cjs'))!];
      const selected = cli('select', path.join(root, 'plan.json'), 'T1', root, ...approvedHash);
      expect(selected.status, selected.stderr).toBe(mode === 'approved' || docs ? 0 : 1);
      expect(existsSync(path.join(root, 'check-ran'))).toBe(['approved', 'red-test-mutation', 'red-source-mutation'].includes(mode));
      if (docs) {
        const calls: string[] = [];
        const result = await runWorkflow({ projectRoot: root, cwd: root, workflow: 'task-document', callerInputs: { packet: { task, repository: context.repositories[0], contextHash: context.contextHash } }, sources: [{ kind: 'inline', text: 'Explain example' }] }, { async invoke(invocation) {
          calls.push(invocation.nodeId);
          const review = invocation.nodeId === 'packet-document-review';
          return JSON.stringify({ status: 'success', artifacts: [{ name: review ? 'review' : 'changes', contract: review ? 'task-review.v1' : 'task-change.v1', data: review ? { decision: 'accept', summary: 'Reviewed text' } : { files: [{ path: 'change.md', content: '# Example\nReturns one.\n' }], summary: 'Explain example' } }] });
        } });
        expect(result.status).toBe('success');
        expect(calls).toEqual(['packet-document', 'packet-document-review']);
        expect(readFileSync(path.join(root, 'source.ts'), 'utf8')).toBe('export const example = 1;');
        expect(existsSync(path.join(root, `.nodulus/task-completed/${context.contextHash}/T1.json`))).toBe(true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000,
);

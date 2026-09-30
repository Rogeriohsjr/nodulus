import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileHash } from '../../scripts/task-workflow/io.mjs';
import { runTaskLoop } from '../../scripts/task-workflow/rework.mjs';

type Invocation = { phase: string; iteration: number; feedback: { summary: string } | null; state: { executionId: string; hashes: Record<string, string | null> } };
type InvocationResult = { artifact: Record<string, unknown>; runId: string };

describe('rework', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'Nodulus rework ü '));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('REWORK-001 accepts second revision', async () => {
    const dir = join(project, 'context', 'T1');
    mkdirSync(dir, { recursive: true });
    const sourcePath = join(project, 'source.mjs');
    const testPath = join(project, 'test.mjs');
    const docsPath = join(project, 'docs.md');

    writeFileSync(sourcePath, 'export const value = 0;\n');
    writeFileSync(testPath, "import assert from 'node:assert';\nimport { value } from './source.mjs';\nassert.ok(value > 0);\n");
    writeFileSync(docsPath, 'old\n');

    const hashes = {
      'source.mjs': fileHash(sourcePath),
      'test.mjs': fileHash(testPath),
      'docs.md': fileHash(docsPath)
    };
    const testHash = hashes['test.mjs'];

    const executionId = `exec-test-${Date.now()}`;
    const state = {
      executionId,
      contextHash: 'context',
      task: { id: 'T1', kind: 'runtime', files: [{ path: 'source.mjs' }], documentation: ['docs.md'], testing: { mode: 'tdd', testFile: 'test.mjs', checkIds: ['focused'] } },
      repo: { id: 'repo', root: project, files: [{ path: 'source.mjs' }, { path: 'test.mjs' }, { path: 'docs.md' }], checks: [{ id: 'focused', executable: process.execPath, args: ['test.mjs'] }] },
      hashes,
      completed: []
    };
    const statePath = join(project, '.nodulus', 'task-execution.json');
    mkdirSync(join(project, '.nodulus'), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const phases: string[] = [];
    let counter = 0;

    const invoke = async (request: Invocation): Promise<InvocationResult> => {
      counter++;
      phases.push(request.phase);

      if (request.phase === 'code') {
        let v = 1;
        if (request.feedback) {
          expect(request.feedback.summary).toBe('Use value 2');
          const actualHashes = {
            'source.mjs': fileHash(sourcePath),
            'test.mjs': fileHash(testPath),
            'docs.md': fileHash(docsPath)
          };
          expect(request.state.hashes).toEqual(actualHashes);
          v = 2;
        }
        return {
          artifact: { summary: 'Fixture change', files: [{ path: 'source.mjs', content: `export const value = ${v};\n` }] },
          runId: `provider-${counter}`
        };
      }
      if (request.phase === 'docs') {
        return {
          artifact: { summary: 'Fixture change', files: [{ path: 'docs.md', content: `iteration${request.iteration}\n` }] },
          runId: `provider-${counter}`
        };
      }
      if (request.phase === 'review' && request.iteration === 0) {
        return { artifact: { decision: 'changes_required', summary: 'Use value 2' }, runId: `provider-${counter}` };
      }
      return { artifact: { decision: 'accept', summary: 'ok' }, runId: `provider-${counter}` };
    };

    const result = await runTaskLoop(project, { maxCorrections: 1, invoke });

    expect(result.status).toBe('accepted');
    expect(result.iterations).toBe(2);
    expect(phases).toEqual(['code', 'docs', 'review', 'code', 'docs', 'review']);
    expect(readFileSync(sourcePath, 'utf8')).toBe('export const value = 2;\n');
    expect(readFileSync(docsPath, 'utf8')).toBe('iteration1\n');
    expect(fileHash(testPath)).toBe(testHash);

    const receiptPath = join(project, '.nodulus', 'task-completed', 'context', 'T1.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.hashes['source.mjs']).toBe(fileHash(sourcePath));
    expect(receipt.hashes['test.mjs']).toBe(testHash);
    expect(receipt.hashes['docs.md']).toBe(fileHash(docsPath));

    const receiptOriginal = join(project, '.nodulus', 'task-receipts', executionId);
    expect(existsSync(receiptOriginal)).toBe(true);
    const receiptIdOther = receipt.executionId;
    expect(receiptIdOther).not.toBe(executionId);
    const receiptRevision = join(project, '.nodulus', 'task-receipts', receiptIdOther);
    expect(existsSync(receiptRevision)).toBe(true);
  });

  it('REWORK-002 exhausts correction budget', async () => {
    const dir = join(project, 'context', 'T1');
    mkdirSync(dir, { recursive: true });
    const sourcePath = join(project, 'source.mjs');
    const testPath = join(project, 'test.mjs');
    const docsPath = join(project, 'docs.md');

    writeFileSync(sourcePath, 'export const value = 0;\n');
    writeFileSync(testPath, "import assert from 'node:assert';\nimport { value } from './source.mjs';\nassert.ok(value > 0);\n");
    writeFileSync(docsPath, 'old\n');

    const hashes = {
      'source.mjs': fileHash(sourcePath),
      'test.mjs': fileHash(testPath),
      'docs.md': fileHash(docsPath)
    };
    const testHash = hashes['test.mjs'];

    const executionId = `exec-test-${Date.now()}`;
    const state = {
      executionId,
      contextHash: 'context',
      task: { id: 'T1', kind: 'runtime', files: [{ path: 'source.mjs' }], documentation: ['docs.md'], testing: { mode: 'tdd', testFile: 'test.mjs', checkIds: ['focused'] } },
      repo: { id: 'repo', root: project, files: [{ path: 'source.mjs' }, { path: 'test.mjs' }, { path: 'docs.md' }], checks: [{ id: 'focused', executable: process.execPath, args: ['test.mjs'] }] },
      hashes,
      completed: []
    };
    const statePath = join(project, '.nodulus', 'task-execution.json');
    mkdirSync(join(project, '.nodulus'), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const phases: string[] = [];
    let counter = 0;

    const invoke = async (request: Invocation): Promise<InvocationResult> => {
      counter++;
      phases.push(request.phase);
      if (request.phase === 'code') {
        return { artifact: { summary: 'Fixture change', files: [{ path: 'source.mjs', content: `export const value = ${request.iteration + 1};\n` }] }, runId: `provider-${counter}` };
      }
      if (request.phase === 'docs') {
        return { artifact: { summary: 'Fixture change', files: [{ path: 'docs.md', content: `iteration${request.iteration}\n` }] }, runId: `provider-${counter}` };
      }
      return { artifact: { decision: 'changes_required', summary: 'fix' }, runId: `provider-${counter}` };
    };

    const result = await runTaskLoop(project, { maxCorrections: 1, invoke });

    expect(result.status).toBe('exhausted');
    expect(result.iterations).toBe(2);
    expect(phases.filter((p: string) => p === 'code')).toHaveLength(2);
    expect(phases.filter((p: string) => p === 'docs')).toHaveLength(2);
    expect(phases.filter((p: string) => p === 'review')).toHaveLength(2);
    expect(existsSync(join(project, '.nodulus', 'task-completed', 'context', 'T1.json'))).toBe(false);
    expect(fileHash(testPath)).toBe(testHash);
  });
});

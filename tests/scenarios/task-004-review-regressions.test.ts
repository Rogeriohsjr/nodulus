import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { assertReadyDependencies } from '../../scripts/task-workflow/runtime.mjs';
import { executePlanFixture } from '../support/task-planning.js';

test('PLAN-004 rejects two implementation targets even within the size limit', async () => {
  const result = await executePlanFixture(plan => {
    plan.tasks[0].files.push({ path: 'tests/example.test.ts', symbol: 'test', change: 'NEW: second target' });
  });
  expect(result.status).toBe('error');
});

test('PLAN-004 rejects a documentation target reused as a TDD test', async () => {
  const result = await executePlanFixture(plan => { plan.tasks[0].testing.testFile = 'docs/change.md'; });
  expect(result.status).toBe('error');
});

test('TASK-004 rejects a receipt from a different task definition', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'Nodulus dependency '));
  try {
    const directory = path.join(project, '.nodulus/task-completed/context');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'D1.json'), JSON.stringify({ contextHash: 'context', taskId: 'D1', repoId: 'repo', status: 'accepted', taskHash: 'old' }));
    expect(() => assertReadyDependencies(project, { contextHash: 'context', tasks: [{ id: 'D1', repoId: 'repo', goal: 'changed' }] }, { dependsOn: ['D1'] })).toThrow('Invalid dependency receipt');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

import { expect, test } from 'vitest';
import { executePlanFixture } from '../support/task-planning.js';

test('PLAN-002 accepts ordered cross-repository packets and rejects cycles', async () => {
  for (const cyclic of [false, true]) {
    const result = await executePlanFixture(plan => {
      plan.decision = 'split';
      plan.tasks.push({ ...structuredClone(plan.tasks[0]), id: 'T2', repoId: 'second', dependsOn: ['T1'] });
      if (cyclic) plan.tasks[0].dependsOn = ['T2'];
    }, context => { context.repositories.push({ ...context.repositories[0], id: 'second' }); });
    expect(result.status).toBe(cyclic ? 'error' : 'success');
  }
});

test('PLAN-002 returns a blocked artifact without inventing tasks', async () => {
  const result = await executePlanFixture(plan => { plan.decision = 'blocked'; plan.tasks = []; plan.questions = ['Which repository owns the API?']; });
  expect(result.status).toBe('success');
});

test.each(['documentation', 'pipeline', 'metadata', 'upgrade'])('PLAN-003 non-TDD exception for %s', async kind => {
  const result = await executePlanFixture(plan => {
    const task = plan.tasks[0]; task.kind = kind;
    task.testing = { mode: 'non-tdd', testFile: null, expectedFailure: null, exception: 'Only descriptive configuration; inspect contents and verify the configured check. Hosted behavior remains unverified.', checkIds: ['focused'] };
    if (kind === 'documentation') task.files = [{ path: 'docs/change.md', symbol: 'Heading', change: 'NEW: explanation' }];
  });
  expect(result.status).toBe(kind === 'upgrade' ? 'error' : 'success');
});

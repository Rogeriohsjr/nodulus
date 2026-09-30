import { describe, test, expect } from 'vitest';
import { executePlanFixture } from "../support/task-planning.js";

describe('Task Planning Scenarios', () => {

  test('Valid Plan Execution', async () => {
    const { status, calls } = await executePlanFixture();
    expect(status).toBe('success');
    expect(calls).toBe(1);
  });

  test.each([
    { mode: 'dependency', dependsOn: ['missing'] },
    { mode: 'repository', repoId: 'other' },
    { mode: 'symbol', symbol: 'invented' },
    { mode: 'context', contextHash: 'wrong' },
    { mode: 'large', files: [{ path: 'src/example2.ts', symbol: 'example', change: 'Return a string' }, { path: 'src/example3.ts', symbol: 'example', change: 'Return a string' }, { path: 'src/example4.ts', symbol: 'example', change: 'Return a string' }, { path: 'src/example5.ts', symbol: 'example', change: 'Return a string' }] },
    { mode: 'exception', exception: 'no test' }
  ])('Invalid Plan Execution with mode: $mode', async ({ dependsOn, repoId, symbol, contextHash, files, exception }) => {
    const plan = await executePlanFixture(mutate => {
      if (dependsOn) mutate.tasks[0].dependsOn = dependsOn;
      if (repoId) mutate.tasks[0].repoId = repoId;
      if (symbol) mutate.tasks[0].references[0].symbol = symbol;
      if (contextHash) mutate.contextHash = contextHash;
      if (files) mutate.tasks[0].files = files;
      if (exception) mutate.tasks[0].testing = { mode: 'non-tdd', testFile: null, expectedFailure: null, exception, checkIds: ['focused'] };
    });

    const { status, calls } = plan;
    expect(status).toBe('error');
    expect(calls).toBe(1);
  }, 20000);

});

import path from 'node:path';
import { test } from 'vitest';
import { exerciseTaskLoop } from '../support/task-loop-scenario.js';
test('REWORK-CLI validates six inference runs and applies a reviewed revision', () => exerciseTaskLoop(path.resolve('scripts/task-workflow/cli.mjs')), 40000);

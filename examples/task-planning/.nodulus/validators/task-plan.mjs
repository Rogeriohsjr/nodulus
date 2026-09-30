import { readFileSync } from 'node:fs';
const errors = [];
const requireThat = (condition, message) => { if (!condition) errors.push(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const relative = value => nonempty(value) && !/[\\:\0]/.test(value) && !value.split('/').some(part => ['', '.', '..'].includes(part));
try {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const plan = JSON.parse(input);
  const context = JSON.parse(readFileSync('.nodulus/task-context.json', 'utf8'));
  requireThat(plan.contextHash === context.contextHash, 'Planning context changed or does not match');
  requireThat(Number.isSafeInteger(context.limits.maxFiles) && context.limits.maxFiles > 0 && Number.isSafeInteger(context.limits.maxCases) && context.limits.maxCases > 0, 'Invalid planning limits');
  requireThat(new Set(context.repositories.map(repo => repo.id)).size === context.repositories.length, 'Duplicate repository IDs');
  requireThat(plan.decision === 'ready' ? plan.tasks.length === 1 : plan.decision === 'split' ? plan.tasks.length >= 2 : plan.tasks.length === 0 && plan.questions.length > 0, 'Decision does not match task count/questions');
  if (plan.decision !== 'blocked') requireThat(plan.questions.length === 0, 'Unresolved questions require blocked decision');
  const seen = new Set();
  for (const task of plan.tasks) {
    requireThat(/^[A-Za-z0-9_-]+$/.test(task.id) && !seen.has(task.id), `Duplicate task ${task.id}`);
    requireThat(new Set(task.dependsOn).size === task.dependsOn.length && task.dependsOn.every(id => id !== task.id && seen.has(id)), `Dependencies must precede ${task.id}`);
    seen.add(task.id);
    const repo = context.repositories.find(repo => repo.id === task.repoId);
    if (!repo) { errors.push(`Unknown repository ${task.repoId}`); continue; }
    const files = new Map(repo.files.map(file => [file.path, file]));
    const allowed = file => relative(file) && files.has(file);
    requireThat(new Set([...task.files.map(file => file.path), ...task.documentation, ...(task.testing.testFile ? [task.testing.testFile] : [])]).size <= context.limits.maxFiles && task.acceptance.length <= context.limits.maxCases, `Task ${task.id} exceeds size limits`);
    requireThat(new Set(task.files.map(file => file.path)).size === task.files.length, `Duplicate file in ${task.id}`);
    for (const file of task.files) {
      requireThat(allowed(file.path), `File not allowed: ${file.path}`);
      const source = files.get(file.path);
      requireThat(file.change.startsWith('NEW:') || (source?.exists && source.content.includes(file.symbol)), `Unknown symbol ${file.symbol}; new symbols require NEW:`);
    }
    for (const ref of task.references) {
      const source = files.get(ref.path);
      requireThat(allowed(ref.path) && source?.exists && source.content.includes(ref.symbol), `Unknown source reference ${ref.path}:${ref.symbol}`);
    }
    requireThat(task.documentation.every(file => allowed(file) && file.endsWith('.md')), 'Documentation must use allowed Markdown paths');
    const testing = task.testing;
    requireThat(task.files.length === 1 && task.documentation.length === 1, 'Packets require exactly one primary file and one documentation file');
    if (task.kind === 'documentation') requireThat(testing.mode === 'non-tdd' && task.files[0].path === task.documentation[0], 'Documentation-only tasks use one shared Markdown target');
    else requireThat(task.files[0].path !== task.documentation[0], 'Primary and documentation targets must differ');
    if (testing.testFile) requireThat(testing.testFile !== task.files[0].path && testing.testFile !== task.documentation[0], 'Test and change targets must differ');
    const checkIds = new Set(repo.checks.map(check => check.id));
    requireThat(new Set(testing.checkIds).size === testing.checkIds.length && testing.checkIds.every(id => checkIds.has(id)), 'Unknown or duplicate check ID');
    if (testing.mode === 'tdd') {
      requireThat(allowed(testing.testFile) && nonempty(testing.expectedFailure) && testing.exception === null, 'TDD requires allowed test file and expected failure, no exception');
    } else {
      requireThat(['documentation', 'pipeline', 'metadata'].includes(task.kind) && testing.testFile === null && testing.expectedFailure === null && nonempty(testing.exception), 'Invalid non-TDD exception');
    }
  }
} catch (error) { errors.push(String(error.message)); }
process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors }));

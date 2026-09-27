import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// This configuration is selected by the coordinator, never a model artifact.
try {
  const root = process.cwd();
  const task = JSON.parse(readFileSync(path.join(root, '.nodulus/development-task.json'), 'utf8'));
  if (task.mode === 'non-tdd') {
    if (typeof task.reason !== 'string' || task.reason.trim() === '') throw new Error('An explicit non-TDD reason is required');
  } else {
    if (task.mode !== 'vitest-red' || typeof task.testFile !== 'string' || !/^tests\/scenarios\/[a-z0-9-]+\.test\.(ts|mjs)$/.test(task.testFile)) {
      throw new Error('Select mode vitest-red and one tests/scenarios/<name>.test.ts or .mjs file');
    }
    const relative = path.relative(realpathSync(root), realpathSync(path.resolve(root, task.testFile)));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Test must resolve inside the project');
    const windows = process.platform === 'win32';
    const options = { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 45000 };
    const build = spawnSync(windows ? 'cmd.exe' : 'npm', windows ? ['/d', '/s', '/c', 'npm.cmd run build'] : ['run', 'build'], options);
    if (build.error || build.status !== 0) throw new Error(`Build/setup failed, not RED: ${build.error?.message ?? build.stderr ?? build.status}`);
    const reports = path.join(root, '.nodulus/checkpoints/red');
    mkdirSync(reports, { recursive: true });
    const reportPath = path.join(reports, `${randomUUID()}.json`);
    const run = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', task.testFile, '--reporter=json', `--outputFile=${reportPath}`], options);
    if (run.error || run.status !== 1) throw new Error(`Expected an assertion-failing test, not success/setup failure (exit ${run.status}): ${run.error?.message ?? ''}`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const assertions = (report.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
    const failures = assertions.filter((assertion) => assertion.status === 'failed');
    if (!(report.numFailedTests > 0) || report.numRuntimeErrorTestSuites > 0 || failures.length === 0 || failures.some((assertion) => !(assertion.failureMessages ?? []).some((message) => message.includes('AssertionError')))) {
      throw new Error(`No clean assertion RED evidence; inspect ${reportPath}`);
    }
    process.stderr.write(`Observed ${failures.length} assertion failure(s); reviewer must still verify relevance. Report: ${reportPath}\n`);
  }
  process.stdout.write(JSON.stringify({ valid: true, errors: [] }));
} catch (error) {
  process.stderr.write(`RED checkpoint rejected: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

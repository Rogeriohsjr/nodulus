import { spawnSync } from 'node:child_process';

// The command is fixed repository policy; no model-produced command is executed.
const windows = process.platform === 'win32';
const check = spawnSync(windows ? 'cmd.exe' : 'npm', windows ? ['/d', '/s', '/c', 'npm.cmd run check'] : ['run', 'check'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 1024 * 1024,
});
process.stderr.write(`${check.stdout ?? ''}${check.stderr ?? ''}`);
if (check.error || check.status !== 0) {
  process.stderr.write(`\nnpm run check failed: ${check.error?.message ?? `exit ${check.status}`}\n`);
  process.exit(check.status && check.status > 0 ? check.status : 1);
}
process.stdout.write(JSON.stringify({ valid: true, errors: [] }));

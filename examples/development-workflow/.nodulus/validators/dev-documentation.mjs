import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const artifact = JSON.parse(input);
const files = artifact.changedFiles;
const root = realpathSync(process.cwd());
const errors = [];
if (!Array.isArray(files) || files.length === 0) errors.push('Documentation requires at least one changed Markdown file');
for (const file of files ?? []) {
  try {
    if (typeof file !== 'string' || file.includes('\\') || file.split('/').some(part => part === '..' || part === '.' || !part) || !(file.startsWith('docs/') || ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].includes(file)) || !file.endsWith('.md')) throw Error('Expected a repository documentation path');
    const absolute = realpathSync(path.resolve(root, file));
    const relative = path.relative(root, absolute);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw Error('Documentation escapes the repository');
    if (!readFileSync(absolute, 'utf8').trim()) throw Error('Documentation is empty');
  } catch (error) { errors.push(`${String(file)}: ${error.message}`); }
}
process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors }));

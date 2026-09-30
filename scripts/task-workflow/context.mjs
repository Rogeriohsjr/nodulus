import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { confinedPath, digest, fileHash } from './io.mjs';
export function prepareContext(manifest) {
  if (!Array.isArray(manifest.repositories) || !manifest.repositories.length) throw Error('Repositories are required');
  const limits = manifest.limits ?? { maxFiles: 3, maxCases: 3 };
  for (const value of [limits.maxFiles, limits.maxCases]) if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid limits');
  const ids = new Set();
  let characters = 0;
  const repositories = manifest.repositories.map(repo => {
    if (typeof repo.id !== 'string' || !repo.id || ids.has(repo.id)) throw Error('Repository IDs must be unique');
    ids.add(repo.id);
    const root = realpathSync(repo.root);
    const seen = new Set();
    const files = repo.files.map(relative => {
      if (seen.has(relative)) throw Error('Duplicate context path');
      seen.add(relative);
      const target = confinedPath(root, relative);
      const content = existsSync(target) ? readFileSync(target, 'utf8') : null;
      characters += content?.length ?? 0;
      if (characters > 24000) throw Error('Context exceeds 24000 source characters; select fewer files, never silently truncate');
      return { path: relative, exists: content !== null, content, sha256: fileHash(target) };
    });
    if (!Array.isArray(repo.checks) || !repo.checks.length || new Set(repo.checks.map(check => check.id)).size !== repo.checks.length) throw Error('Unique trusted checks are required');
    for (const check of repo.checks) if (!/^[A-Za-z0-9_-]+$/.test(check.id) || typeof check.executable !== 'string' || !Array.isArray(check.args) || !check.args.every(arg => typeof arg === 'string')) throw Error('Invalid check definition');
    return { id: repo.id, root, files, checks: repo.checks };
  });
  return { contextHash: digest(JSON.stringify({ repositories, limits })), repositories, limits };
}

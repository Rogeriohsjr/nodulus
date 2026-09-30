import { readFileSync } from 'node:fs';
import { digest, confinedPath, fileHash, runCheck } from './io.mjs';

function verifyFiles(state) {
  for (const [relative, hash] of Object.entries(state.hashes)) {
    if (fileHash(confinedPath(state.repo.root, relative)) !== hash) throw Error(`Frozen file changed: ${relative}`);
  }
}

// State/check definitions are operator-owned, not model artifacts or signed attestations.
export function verifyRecovery(project, state) {
  if (state.recoveryCount !== undefined && state.recoveryCount !== 0) throw Error('Recovery already prepared or invalid count');
  const prefixes = state.task.kind === 'documentation' ? [['docs']] : [['code'], ['code', 'docs']];
  if (!prefixes.some(prefix => JSON.stringify(prefix) === JSON.stringify(state.completed))) throw Error('Unsupported completed phases');
  verifyFiles(state);
  for (const phase of state.completed) {
    const record = state.accepted?.[phase];
    if (!record?.artifact || digest(JSON.stringify(record.artifact)) !== record.artifactHash) throw Error(`Missing or changed accepted artifact: ${phase}`);
    if (!Array.isArray(record.artifact.files) || record.artifact.files.length !== 1) throw Error('Expected one accepted file');
    const file = record.artifact.files[0];
    if (!Object.hasOwn(state.hashes, file.path) || typeof file.content !== 'string' || digest(file.content) !== state.hashes[file.path]) throw Error('Accepted artifact does not match frozen content');
    if (!Array.isArray(record.checks) || record.checks.length !== state.task.testing.checkIds.length) throw Error('Accepted check set changed');
    for (const id of state.task.testing.checkIds) {
      const relative = `.nodulus/task-receipts/${state.executionId}/${phase}-${id}.json`;
      const matches = record.checks.filter(check => check.path === relative);
      const absolute = confinedPath(project, relative);
      if (matches.length !== 1 || typeof matches[0].sha256 !== 'string' || fileHash(absolute) !== matches[0].sha256) throw Error(`Accepted check receipt changed: ${id}`);
      const receipt = JSON.parse(readFileSync(absolute, 'utf8'));
      if (receipt.id !== id || receipt.passed !== true) throw Error(`Accepted check did not pass: ${id}`);
    }
  }
  for (const id of state.task.testing.checkIds) {
    const result = runCheck(state.repo.root, state.repo.checks.find(check => check.id === id));
    if (!result.passed) throw Error(`Recovery check failed: ${id}`);
  }
  verifyFiles(state);
}

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRecovery } from './recovery.mjs';
import { applyFile, digest, confinedPath, fileHash, runCheck } from './io.mjs';

export { prepareRecovery };

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv[2] !== 'recover' || !process.argv[3] || process.argv.length !== 4) throw Error('Usage: node runtime.mjs recover <project>');
    console.log(JSON.stringify(prepareRecovery(path.resolve(process.argv[3]))));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}

export function runPhase(project, phase, artifact) {
  const statePath = path.join(project, '.nodulus/task-execution.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const directory = path.join(project, '.nodulus/task-receipts', state.executionId);
  mkdirSync(directory, { recursive: true });
  const errors = [];
  if (phase === 'code' && state.task.kind === 'documentation') throw Error('Use task-document for documentation-only tasks');
  if (state.completed.includes(phase)) throw Error('Completed phase cannot be replayed');
  if (phase === 'docs' && state.task.kind !== 'documentation' && !state.completed.includes('code')) throw Error('Implementation is not accepted');
  if (phase === 'review' && !state.completed.includes('docs')) throw Error('Documentation is not accepted');
  // Detect changes by other processes; the model has no tools in this workflow.
  for (const [relative, hash] of Object.entries(state.hashes)) if (fileHash(confinedPath(state.repo.root, relative)) !== hash) throw Error(`File changed outside this execution: ${relative}`);
  if (phase === 'review') {
    if (artifact.decision !== 'accept') throw Error('Review requested changes');
  } else {
    if (!Array.isArray(artifact.files) || artifact.files.length !== 1) throw Error('This executor accepts exactly one full file per phase');
    const allowed = phase === 'docs' ? state.task.documentation : state.task.files.map(file => file.path).filter(file => file !== state.task.testing.testFile && (state.task.testing.mode === 'non-tdd' || !state.task.documentation.includes(file)));
    const file = artifact.files[0];
    const applied = applyFile({ root: state.repo.root, allowedPaths: allowed, expectedHash: state.hashes[file.path], change: file, receiptDirectory: directory });
    if (!applied.applied) throw Error(applied.error);
    state.hashes[file.path] = applied.afterHash;
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    for (const id of state.task.testing.checkIds) {
      const check = state.repo.checks.find(check => check.id === id);
      const result = runCheck(state.repo.root, check);
      writeFileSync(path.join(directory, `${phase}-${id}.json`), JSON.stringify(result, null, 2));
      if (!result.passed) errors.push(`${id} failed: ${result.stderr || result.stdout || result.error}`);
    }
  }
  for (const [relative, hash] of Object.entries(state.hashes)) if (fileHash(confinedPath(state.repo.root, relative)) !== hash) errors.push(`Check changed a frozen file: ${relative}`);
  if (!errors.length) {
    state.accepted ??= {};
    state.accepted[phase] = {
      artifact,
      artifactHash: digest(JSON.stringify(artifact)),
      checks: phase === 'review' ? [] : state.task.testing.checkIds.map(id => {
        const relative = path.posix.join('.nodulus/task-receipts', state.executionId, `${phase}-${id}.json`);
        return { path: relative, sha256: fileHash(path.join(project, relative)) };
      }),
    };
    state.completed.push(phase);
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    if (phase === 'review') {
      const completed = path.join(project, '.nodulus/task-completed', state.contextHash);
      mkdirSync(completed, { recursive: true });
      writeFileSync(path.join(completed, `${state.task.id}.json`), JSON.stringify({ taskId: state.task.id, taskHash: digest(JSON.stringify(state.task)), contextHash: state.contextHash, executionId: state.executionId, repoId: state.repo.id, hashes: state.hashes, status: 'accepted', review: artifact, acceptedAt: new Date().toISOString() }, null, 2));
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertReadyDependencies(project, plan, task) {
  for (const id of task.dependsOn) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error('Invalid dependency ID');
    const file = path.join(project, '.nodulus/task-completed', plan.contextHash, `${id}.json`);
    if (!existsSync(file)) throw Error(`Dependency ${id} has no accepted receipt`);
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    const dependency = plan.tasks.find(candidate => candidate.id === id);
    if (!dependency || receipt.repoId !== dependency.repoId || receipt.taskHash !== digest(JSON.stringify(dependency))) throw Error(`Invalid dependency receipt ${id}: task changed`);
    if (receipt.contextHash !== plan.contextHash || receipt.taskId !== id || receipt.status !== 'accepted') throw Error(`Invalid dependency receipt ${id}`);
  }
}

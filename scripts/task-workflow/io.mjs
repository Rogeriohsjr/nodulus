import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const fileHash = file => existsSync(file) ? digest(readFileSync(file)) : null;
export function confinedPath(root, relative) {
  if (typeof relative !== 'string' || /[\\:\0]/.test(relative) || relative.split('/').some(part => ['', '.', '..'].includes(part))) throw Error('Expected a confined relative POSIX path');
  const base = realpathSync(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw Error('Symlink paths are not allowed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

// One-file atomic replacement; no multi-file transaction is claimed.
export function applyFile({ root, allowedPaths, expectedHash, change, receiptDirectory }) {
  mkdirSync(receiptDirectory, { recursive: true });
  const receiptPath = path.join(receiptDirectory, `${randomUUID()}.json`);
  const receipt = { schemaVersion: 1, startedAt: new Date().toISOString(), path: change.path, applied: false, expectedHash, beforeHash: null, afterHash: null, error: null };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  let temporary;
  try {
    if (!allowedPaths.includes(change.path)) throw Error('Path is not allowed');
    if (typeof change.content !== 'string' || /^\s*```/.test(change.content)) throw Error('Expected plain full file content without source fences');
    const target = confinedPath(root, change.path);
    receipt.beforeHash = fileHash(target);
    if (receipt.beforeHash !== expectedHash) throw Error('Stale file base');
    const mode = existsSync(target) ? statSync(target).mode : 0o666;
    mkdirSync(path.dirname(target), { recursive: true });
    temporary = `${target}.nodulus-${randomUUID()}.tmp`;
    writeFileSync(temporary, change.content, { encoding: 'utf8', flag: 'wx', mode });
    // Recheck immediately before replacement; concurrent writers still require a dedicated worktree.
    if (fileHash(target) !== expectedHash) throw Error('Stale file base');
    renameSync(temporary, target);
    temporary = undefined;
    receipt.afterHash = fileHash(target);
    receipt.applied = true;
  } catch (error) { receipt.error = error.message; }
  finally { if (temporary) rmSync(temporary, { force: true }); }
  receipt.endedAt = new Date().toISOString();
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  return { ...receipt, receiptPath };
}

export function runCheck(root, check) {
  if (!check || typeof check.executable !== 'string' || !Array.isArray(check.args) || !check.args.every(arg => typeof arg === 'string')) throw Error('Invalid trusted check');
  const startedAt = new Date().toISOString();
  const result = spawnSync(check.executable, check.args, { cwd: root, shell: false, windowsHide: true, encoding: 'utf8', timeout: Math.min(120000, Math.max(1, check.timeoutMs ?? 120000)), maxBuffer: 2 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  return { id: check.id, startedAt, endedAt: new Date().toISOString(), exitCode: result.status, passed: result.status === 0 && !result.error, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
}

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileHash, confinedPath } from './io.mjs';

export function loadState(project) {
  return JSON.parse(fs.readFileSync(confinedPath(project, '.nodulus/task-execution.json'), 'utf8'));
}

export function saveState(project, state) {
  const dir = confinedPath(project, '.nodulus');
  const target = confinedPath(dir, 'task-execution.json');
  const tmp = path.join(dir, `.tmp-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function verifyState(state) {
  for (const [rel, expected] of Object.entries(state.hashes)) {
    const actual = fileHash(confinedPath(state.repo.root, rel));
    if (actual !== expected) throw new Error(`Hash mismatch at ${rel}`);
  }
}

export function refreshState(state) {
  verifyState(state);
  const clone = structuredClone(state);
  for (const entry of clone.repo.files) {
    const abs = confinedPath(clone.repo.root, entry.path);
    const sha256 = fileHash(abs);
    entry.content = sha256 === null ? null : fs.readFileSync(abs, 'utf8');
    entry.sha256 = sha256;
    entry.exists = sha256 !== null;
  }
  return clone;
}

function journalDirectory(project, origin) {
  if (!/^[A-Za-z0-9_-]+$/.test(origin)) throw new Error('Invalid origin format');
  return confinedPath(project, `.nodulus/task-loops/${origin}`);
}

export function inspectLoop(project) {
  const state = loadState(project);
  const origin = state.reworkOrigin ?? state.executionId;
  const directory = journalDirectory(project, origin);
  const file = path.join(directory, 'state.json');
  return { origin, directory, lockPresent: fs.existsSync(path.join(directory, '.lock')), journal: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null, guidance: 'A lock may belong to a live or interrupted process. Inspect processes, files, checks and receipts before manual recovery. No automatic replay or lock removal.' };
}

export function openJournal(project, origin) {
  const directory = journalDirectory(project, origin);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, '.lock');
  try {
    fs.mkdirSync(lock);
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error('Journal locked by a live or interrupted process; run nodulus-task loop-status <project> and inspect evidence. Do not replay or remove a live lock.');
    throw err;
  }
  let ownsLock = true;
  const read = () => {
    const p = path.join(directory, 'state.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  const write = (value) => {
    const target = path.join(directory, 'state.json');
    const tmp = path.join(directory, `state-${randomUUID()}.json`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  };
  const record = (name, value) => {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid record name');
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value, null, 2), { flag: 'wx' });
  };
  const close = () => {
    if (!ownsLock) return;
    ownsLock = false;
    fs.rmdirSync(lock);
  };
  return { directory, read, write, record, close };
}

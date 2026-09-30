#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareContext } from './context.mjs';
import { confinedPath, fileHash, runCheck } from './io.mjs';
import { assertReadyDependencies } from './runtime.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const runtimeHelpers = ['io.mjs', 'runtime.mjs', 'recovery.mjs', 'recovery-state.mjs'];
const [command, first, second, third, approvedTestHash] = process.argv.slice(2);
try {
  if (command === 'setup') {
    const project = path.resolve(first ?? '.');
    const source = fileURLToPath(new URL('../../examples/task-planning/.nodulus/', import.meta.url));
    const target = path.join(project, '.nodulus');
    mkdirSync(target, { recursive: true });
    // Preflight every collision before copying. Existing identical definitions are reusable.
    const entries = readdirSync(source, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.relative(source, path.join(entry.parentPath, entry.name)));
    for (const relative of entries.filter(relative => relative !== 'settings.json')) {
      const destination = path.join(target, relative);
      if (existsSync(destination) && readFileSync(destination, 'utf8') !== readFileSync(path.join(source, relative), 'utf8')) throw Error(`Existing definition differs: ${relative}`);
    }
    for (const name of runtimeHelpers) {
      const original = fileURLToPath(new URL(name, import.meta.url));
      const destination = path.join(target, 'task-tools', name);
      if (existsSync(destination) && readFileSync(destination, 'utf8') !== readFileSync(original, 'utf8')) throw Error(`Existing task helper differs: ${name}`);
    }
    const settingsFile = path.join(target, 'settings.json');
    const defaults = read(path.join(source, 'settings.json'));
    const settings = existsSync(settingsFile) ? read(settingsFile) : defaults;
    settings.providerProfiles ??= {};
    settings.providerProfiles['qwen-artifact'] ??= defaults.providerProfiles['qwen-artifact'];
    for (const relative of entries.filter(relative => relative !== 'settings.json')) {
      const destination = path.join(target, relative); mkdirSync(path.dirname(destination), { recursive: true });
      if (!existsSync(destination)) cpSync(path.join(source, relative), destination);
    }
    const tools = path.join(target, 'task-tools'); mkdirSync(tools, { recursive: true });
    for (const name of runtimeHelpers) {
      const original = fileURLToPath(new URL(name, import.meta.url));
      const destination = path.join(tools, name);
      if (existsSync(destination) && readFileSync(destination, 'utf8') !== readFileSync(original, 'utf8')) throw Error(`Existing task helper differs: ${name}`);
      if (!existsSync(destination)) cpSync(original, destination);
    }
    const openCodeConfig = path.join(project, 'opencode.json');
    const existingOpenCodeConfig = existsSync(openCodeConfig);
    if (!existingOpenCodeConfig) cpSync(fileURLToPath(new URL('../../examples/task-planning/opencode.example.json', import.meta.url)), openCodeConfig);
    save(settingsFile, settings);
    console.log(JSON.stringify({ status: 'success', project, existingOpenCodeConfig, workflows: ['task-plan', 'task-implement', 'task-document'] }));
  } else if (command === 'prepare') {
    const project = path.resolve(second ?? '.');
    const context = prepareContext(read(path.resolve(first)));
    save(path.join(project, '.nodulus/task-context.json'), context);
    save(path.join(project, '.nodulus/task-plan-inputs.json'), { context });
    console.log(JSON.stringify({ status: 'success', contextHash: context.contextHash, inputsFile: path.join(project, '.nodulus/task-plan-inputs.json') }));
  } else if (command === 'select') {
    const project = path.resolve(third ?? '.');
    const statePath = path.join(project, '.nodulus/task-execution.json');
    if (existsSync(statePath) && !read(statePath).completed.includes('review')) throw Error('An execution is unfinished; preserve/review it before selecting another');
    const envelope = read(path.resolve(first));
    if (envelope.status !== 'success') throw Error('Planning workflow did not succeed');
    const plan = envelope.result?.artifacts?.find(artifact => artifact.name === 'plan' && artifact.contract === 'task-plan.v1')?.data;
    const context = read(path.join(project, '.nodulus/task-context.json'));
    if (!plan || !['ready', 'split'].includes(plan.decision) || plan.contextHash !== context.contextHash) throw Error('Plan is blocked or context does not match');
    const schema = read(fileURLToPath(new URL('../../examples/task-planning/.nodulus/contracts/task-plan.v1.schema.json', import.meta.url)));
    const validate = new Ajv().compile(schema);
    if (!validate(plan)) throw Error('Plan contract is invalid');
    const verification = spawnSync(process.execPath, [path.join(project, '.nodulus/validators/task-plan.mjs')], { cwd: project, input: JSON.stringify(plan), encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (verification.status !== 0 || !JSON.parse(verification.stdout).valid) throw Error('Plan validation failed before selection');
    const task = plan.tasks.find(task => task.id === second);
    if (!task || !/^[A-Za-z0-9_-]+$/.test(task.id)) throw Error('Unknown task');
    assertReadyDependencies(project, plan, task);
    const repo = context.repositories.find(repo => repo.id === task.repoId);
    if (!repo) throw Error('Unknown repository');
    const hashes = {};
    const files = repo.files.map(file => {
      const target = confinedPath(repo.root, file.path);
      const currentHash = fileHash(target);
      let expectedHash = file.sha256;
      for (const id of task.dependsOn) {
        const receipt = read(path.join(project, '.nodulus/task-completed', plan.contextHash, `${id}.json`));
        if (receipt.repoId === task.repoId && Object.hasOwn(receipt.hashes ?? {}, file.path)) expectedHash = receipt.hashes[file.path];
      }
      if (file.path !== task.testing.testFile && currentHash !== expectedHash) throw Error(`Context file changed: ${file.path}; prepare/replan or inspect dependencies`);
      hashes[file.path] = currentHash;
      return { ...file, sha256: currentHash, exists: currentHash !== null, content: currentHash === null ? null : readFileSync(target, 'utf8') };
    });
    const executionId = randomUUID();
    const receipts = path.join(project, '.nodulus/task-receipts', executionId); mkdirSync(receipts, { recursive: true });
    if (task.testing.mode === 'tdd') {
      if (!approvedTestHash || approvedTestHash !== hashes[task.testing.testFile]) throw Error('Reviewed test hash is required and must match');
      if (!hashes[task.testing.testFile]) throw Error('Prepare and review the scenario test before selecting TDD implementation');
      const check = repo.checks.find(check => task.testing.checkIds.includes(check.id) && typeof check.redContains === 'string' && check.redContains.length > 0);
      if (!check) throw Error('TDD requires a caller-owned check with redContains for the behavioral assertion');
      const result = runCheck(repo.root, check);
      save(path.join(receipts, 'red.json'), result);
      if (result.exitCode !== 1 || result.error || !`${result.stdout}\n${result.stderr}`.includes(check.redContains)) throw Error('Meaningful RED was not observed; inspect the check receipt');
    }
    for (const [relative, hash] of Object.entries(hashes)) if (fileHash(confinedPath(repo.root, relative)) !== hash) throw Error(`RED check changed a frozen file: ${relative}`);
    const state = { executionId, contextHash: context.contextHash, task, repo: { ...repo, files }, hashes, completed: [] };
    save(statePath, state);
    save(path.join(project, '.nodulus/task-implement-inputs.json'), { packet: { task, repository: state.repo, contextHash: context.contextHash } });
    console.log(JSON.stringify({ status: 'success', executionId, taskId: task.id, workflow: task.kind === 'documentation' ? 'task-document' : 'task-implement', inputsFile: path.join(project, '.nodulus/task-implement-inputs.json') }));
  } else {
    throw Error('Usage: nodulus-task setup [project] | prepare <manifest.json> [project] | select <plan-result.json> <task-id> <project> [reviewed-test-sha256]');
  }
} catch (error) { console.error(JSON.stringify({ status: 'error', error: error.message })); process.exitCode = 1; }

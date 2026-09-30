import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { confinedPath } from './io.mjs';
import { runPhase } from './runtime.mjs';
import { loadState, saveState, verifyState, refreshState, openJournal } from './loop-state.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === expected;
const text = value => typeof value === 'string' && value.trim().length > 0;

function validateResponse(response, phase) {
  if (!keys(response, 'artifact,runId') || !text(response.runId)) throw Error('Invalid provider result identity');
  const artifact = response.artifact;
  if (phase === 'review') {
    if (!keys(artifact, 'decision,summary') || !['accept', 'changes_required'].includes(artifact.decision) || !text(artifact.summary)) throw Error('Invalid review artifact');
  } else if (!keys(artifact, 'files,summary') || !text(artifact.summary) || !Array.isArray(artifact.files) || artifact.files.length !== 1 || !keys(artifact.files[0], 'content,path') || !text(artifact.files[0].path) || !text(artifact.files[0].content)) {
    throw Error('Invalid change artifact');
  }
}

/** Bounded review revisions. Interrupted effects require inspection, never automatic replay. */
export async function runTaskLoop(project, { maxCorrections, invoke }) {
  if (typeof project !== 'string' || !Number.isInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > 2 || typeof invoke !== 'function') throw Error('Invalid loop options');
  let state = loadState(project);
  const origin = state.reworkOrigin ?? state.executionId;
  const journal = openJournal(project, origin);
  let iterations = 0;
  let started = false;
  const finish = (status, error) => {
    const result = { status, iterations, ...(error === undefined ? {} : { error }) };
    journal.write({ status, result });
    return result;
  };
  try {
    const previous = journal.read();
    if (previous) {
      if (previous.status === 'running') return { status: 'error', iterations: previous.iterations, error: 'Interrupted loop; inspect saved evidence before recovery' };
      if (!['accepted', 'exhausted', 'error'].includes(previous.status) || previous.result?.status !== previous.status) throw Error('Invalid loop journal');
      verifyState(state);
      return previous.result;
    }
    if (state.task.kind !== 'runtime' || state.task.testing.mode !== 'tdd' || !Array.isArray(state.completed) || state.completed.length !== 0 || !text(state.hashes[state.task.testing.testFile])) throw Error('Loop requires a fresh runtime task and frozen test');
    if (existsSync(confinedPath(project, `.nodulus/task-completed/${state.contextHash}/${state.task.id}.json`))) throw Error('Task completion already exists; inspect it before starting another execution');
    let feedback = null;
    for (let iteration = 0; iteration <= maxCorrections; iteration++) {
      iterations = iteration + 1;
      for (const phase of ['code', 'docs', 'review']) {
        verifyState(state);
        const request = { phase, iteration, feedback, state: refreshState(state) };
        journal.write({ status: 'running', iterations, phase, executionId: state.executionId });
        started = true;
        journal.record(`iteration-${iteration}-${phase}-request`, request);
        const response = await invoke(request);
        journal.record(`iteration-${iteration}-${phase}-response`, response);
        verifyState(state);
        validateResponse(response, phase);
        if (phase === 'review' && response.artifact.decision === 'changes_required') {
          journal.record(`iteration-${iteration}-state`, state);
          if (iteration === maxCorrections) return finish('exhausted');
          feedback = { phase: 'review', summary: response.artifact.summary };
          state = { ...state, executionId: randomUUID(), reworkOrigin: origin, completed: [], accepted: {} };
          delete state.recoveryCount;
          saveState(project, state);
          break;
        }
        const checked = runPhase(project, phase, response.artifact);
        if (!checked.valid) throw Error(checked.errors.join('\n'));
        state = loadState(project);
        if (phase === 'review') return finish('accepted');
      }
    }
    throw Error('Loop ended without a terminal review');
  } catch (error) {
    if (!started) throw error;
    return finish('error', error instanceof Error ? error.message : String(error));
  } finally {
    journal.close();
  }
}

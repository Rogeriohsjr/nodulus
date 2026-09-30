import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { runTaskLoop } from './rework.mjs';

export async function runConfiguredLoop(project, maxCorrections) {
  return runTaskLoop(project, {
    maxCorrections,
    async invoke({ phase, iteration, feedback, state }) {
      const uniqueId = `task-loop-${randomUUID()}`;
      const packetPath = resolve(project, '.nodulus', 'nodes', `packet-${phase}.json`);
      const nodeContent = JSON.parse(await readFile(packetPath, 'utf8'));

      nodeContent.id = uniqueId;
      nodeContent.inputs = { request: { from: 'request', contract: 'request.v1' } };
      nodeContent.expectedOutputs = nodeContent.expectedOutputs.map(output => {
        delete output.validator;
        delete output.validatorTimeoutMs;
        return output;
      });

      const nodeFilePath = resolve(project, '.nodulus', 'nodes', `${uniqueId}.json`);
      await writeFile(nodeFilePath, JSON.stringify(nodeContent, null, 2), { flag: 'wx' });

      const workflowFilePath = resolve(project, '.nodulus', 'workflows', `${uniqueId}.json`);
      await writeFile(workflowFilePath, JSON.stringify({ schemaVersion: 1, id: uniqueId, nodes: [uniqueId] }, null, 2), { flag: 'wx' });

      const requestFile = resolve(project, '.nodulus', 'task-loops', 'requests', `${uniqueId}.txt`);
      const requestDir = resolve(project, '.nodulus', 'task-loops', 'requests');
      await mkdir(requestDir, { recursive: true });
      await writeFile(requestFile, `Loop phase: ${phase}\n${JSON.stringify({ iteration, feedback, task: state.task, repository: state.repo, accepted: state.accepted ?? {} }, null, 2)}`);

      const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
      const result = spawnSync(process.execPath, [bin, 'run', '--workflow', uniqueId, '--request-file', requestFile, '--json'], {
        cwd: project,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 630000,
        maxBuffer: 8 * 1024 * 1024
      });

      let envelope;
      try { envelope = JSON.parse(result.stdout); } catch { throw new Error(`CLI returned no valid result: ${result.error?.message ?? result.stderr}`); }
      if (result.status !== 0 || result.error || envelope.status !== 'success') {
        throw new Error(`CLI run ${envelope.runId ?? 'unknown'} failed: ${JSON.stringify(envelope.error ?? envelope)} ${result.error?.message ?? result.stderr}`);
      }

      const expectedName = phase === 'review' ? 'review' : 'changes';
      const expectedContract = phase === 'review' ? 'task-review.v1' : 'task-change.v1';
      const artifactEntry = envelope.result?.artifacts?.find(a => a.name === expectedName && a.contract === expectedContract);

      if (!artifactEntry || typeof envelope.runId !== 'string' || envelope.runId.length === 0) {
        throw new Error(`CLI response does not contain the expected artifact or runId. runId: ${envelope.runId}, stderr: ${result.stderr}`);
      }

      return {
        artifact: artifactEntry.data,
        runId: envelope.runId
      };
    }
  });
}

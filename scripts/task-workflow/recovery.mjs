import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileHash, confinedPath } from './io.mjs';
import { verifyRecovery } from './recovery-state.mjs';

export function prepareRecovery(project) {
  const statePath = path.join(project, '.nodulus/task-execution.json');
  if (!existsSync(statePath)) {
    throw new Error('Task execution state not found');
  }
  const state = JSON.parse(readFileSync(statePath, 'utf-8'));
  verifyRecovery(project, state);

  const repoFiles = state.repo.files.map(file => {
    const filePath = confinedPath(state.repo.root, file.path);
    const content = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
    const sha256 = fileHash(filePath);
    return { ...file, content, sha256, exists: content !== null };
  });

  const inputs = {
    packet: {
      task: state.task,
      repository: { ...state.repo, files: repoFiles },
      contextHash: state.contextHash
    }
  };

  const docsOnly = state.task.kind === 'documentation';
  const docsDone = state.completed.includes('docs');
  if (!docsOnly) inputs.implementation = state.accepted.code.artifact;
  mkdirSync(path.join(project, '.nodulus/nodes'), { recursive: true });

  if (docsDone) {
    inputs.documentation = state.accepted.docs.artifact;
  } else {
    const packetDocsPath = path.join(project, '.nodulus/nodes/packet-docs.json');
    const packetDocs = JSON.parse(readFileSync(packetDocsPath, 'utf-8'));
    const clonedDocsPath = path.join(project, '.nodulus/nodes/recovery-docs.json');
    packetDocs.id = 'recovery-docs';
    packetDocs.inputs.implementation.from = 'caller.implementation';
    writeFileSync(clonedDocsPath, JSON.stringify(packetDocs, null, 2));

  }

  const reviewPath = docsOnly ? path.join(project, '.nodulus/nodes/packet-document-review.json') : path.join(project, '.nodulus/nodes/packet-review.json');
  const review = JSON.parse(readFileSync(reviewPath, 'utf-8'));
  const clonedReviewPath = path.join(project, '.nodulus/nodes/recovery-review.json');
  review.id = 'recovery-review';
  if (!docsOnly) review.inputs.implementation.from = 'caller.implementation';
  if (docsDone) {
    review.inputs.documentation.from = 'caller.documentation';
  } else {
    review.inputs.documentation.from = 'recovery-docs.changes';
  }
  writeFileSync(clonedReviewPath, JSON.stringify(review, null, 2));

  const workflowsPath = path.join(project, '.nodulus/workflows/task-recover.json');
  mkdirSync(path.dirname(workflowsPath), { recursive: true });
  const contracts = { packet: { contract: 'task-packet.v1' } };
  if (!docsOnly) {
    contracts.implementation = { contract: 'task-change.v1' };
  }
  if (docsDone) {
    contracts.documentation = { contract: 'task-change.v1' };
  }
  const workflow = {
    schemaVersion: 1,
    id: 'task-recover',
    inputs: contracts,
    nodes: docsDone ? ['recovery-review'] : ['recovery-docs', 'recovery-review']
  };
  writeFileSync(workflowsPath, JSON.stringify(workflow, null, 2));

  const inputsFilePath = path.join(project, '.nodulus/task-recover-inputs.json');
  writeFileSync(inputsFilePath, JSON.stringify(inputs, null, 2));

  state.recoveryCount = 1;
  writeFileSync(statePath, JSON.stringify(state, null, 2));

  return {
    workflow: 'task-recover',
    inputsFile: inputsFilePath
  };
}

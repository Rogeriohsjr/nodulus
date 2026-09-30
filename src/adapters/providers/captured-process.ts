import type { ProviderInvocation } from '../../core/ports/provider.js';
import { runProcess } from './process-runner.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function runCapturedProcess(executable: string, args: string[], options: { cwd: string; stdin: string; timeoutMs: number }, invocation: ProviderInvocation, operation: 'invoke' | 'repair_response' = 'invoke') {
  const callId = invocation.call?.callId ?? randomUUID();
  const attempt = invocation.call?.attempt ?? invocation.attempt;
  const runRoot = path.join(options.cwd, '.nodulus', 'runs', invocation.runId);
  const callRelative = path.posix.join('calls', callId);
  const nodeRelative = path.posix.join('nodes', invocation.nodeId, `attempt-${attempt.toString().padStart(3, '0')}`);
  const callDirectory = path.join(runRoot, callRelative);

  await mkdir(callDirectory, { recursive: true });

  const request = {
    schemaVersion: 1,
    runId: invocation.runId,
    nodeId: invocation.nodeId,
    attempt,
    callId,
    operation: invocation.call?.operation ?? operation,
    parentCallId: invocation.call?.parentCallId ?? null,
    providerProfileId: invocation.providerProfileId ?? null,
    provider: invocation.providerProfile.kind,
    requestedModel: typeof invocation.providerProfile.model === "string" ? invocation.providerProfile.model : null,
    cwd: options.cwd,
    executable,
    argv: args,
    startedAt: new Date().toISOString(),
    refs: {
      prompt: `${nodeRelative}/prompt.md`,
      stdin: `${callRelative}/stdin.txt`,
      transport: `${callRelative}/transport.json`,
      response: `${nodeRelative}/response.raw.txt`,
      validation: `${nodeRelative}/validation.json`,
      result: `${nodeRelative}/result.json`,
      invocation: `${nodeRelative}/invocation.json`,
    },
  };

  await writeFile(path.join(callDirectory, 'stdin.txt'), options.stdin, 'utf8');
  await writeFile(path.join(callDirectory, 'request.json'), JSON.stringify(request, null, 2), 'utf8');

  const startTime = performance.now();
  const runProcessResult = await runProcess(executable, args, options);
  const endTime = performance.now();

  const transport = {
    schemaVersion: 1,
    callId,
    provider: invocation.providerProfile.kind,
    stdout: runProcessResult.stdout,
    stderr: runProcessResult.stderr,
    exitCode: runProcessResult.exitCode,
    timedOut: runProcessResult.timedOut,
    outputLimitExceeded: runProcessResult.outputLimitExceeded,
    startedAt: request.startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Math.max(0, endTime - startTime),
  };

  await writeFile(path.join(callDirectory, 'transport.json'), JSON.stringify(transport, null, 2), 'utf8');

  return runProcessResult;
}

export { runCapturedProcess };

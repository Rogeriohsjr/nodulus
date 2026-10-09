import { parseProviderTelemetry } from "./provider-telemetry.js";
import type { ProviderInvocation } from '../../core/ports/provider.js';
import { runProcess } from './process-runner.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function runCapturedProcess(executable: string, args: string[], options: { cwd: string; stdin: string; timeoutMs: number; signal?: AbortSignal }, invocation: ProviderInvocation, operation: 'invoke' | 'repair_response' = 'invoke', cliVersion: string | null = null) {
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
    cancelled: runProcessResult.cancelled,
    outputLimitExceeded: runProcessResult.outputLimitExceeded,
    startedAt: request.startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Math.max(0, endTime - startTime),
  };

  await writeFile(path.join(callDirectory, 'transport.json'), JSON.stringify(transport, null, 2), 'utf8');

  const telemetry = parseProviderTelemetry(String(invocation.providerProfile.kind), runProcessResult.stdout, cliVersion);
  telemetry.callId = callId;
  telemetry.source.transportRef = `${callRelative}/transport.json`;
  if (runProcessResult.timedOut || runProcessResult.outputLimitExceeded || runProcessResult.exitCode !== 0) {
    telemetry.coverage = telemetry.stepCount ? "partial" : "unavailable";
    telemetry.normalized = { inputTokens: null, outputTokens: null };
    telemetry.diagnostics.push("Provider transport did not complete successfully");
  }

  try {
    await writeFile(path.join(callDirectory, 'telemetry.json'), JSON.stringify(telemetry, null, 2), 'utf8');
  } catch {
    telemetry.diagnostics.push('Telemetry persistence failed');
  }

  return { ...runProcessResult, callId, telemetry };
}

export { runCapturedProcess };

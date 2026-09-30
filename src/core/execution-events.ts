import type { IntakeStorage } from "./ports/intake-storage.js";

export async function appendRunEvent(projectRoot: string, runId: string, storage: IntakeStorage, event: Record<string, unknown>): Promise<void> {
  const fileContent = await storage.readRunFile(projectRoot, runId, 'events.jsonl');
  const events = fileContent.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as { sequence?: unknown });
  const sequence = events.reduce((maximum, entry) => typeof entry.sequence === 'number' && Number.isSafeInteger(entry.sequence) && entry.sequence >= 0 ? Math.max(maximum, entry.sequence) : maximum, events.length) + 1;
  const newEvent = { ...event, timestamp: new Date().toISOString(), sequence };
  const fileContentWithNewEvent = `${fileContent.trimEnd()}${fileContent.trim() ? "\n" : ""}${JSON.stringify(newEvent)}\n`;
  await storage.writeRunFiles(projectRoot, runId, { 'events.jsonl': fileContentWithNewEvent });
}

export async function traceProviderCall(projectRoot: string, runId: string, storage: IntakeStorage, context: { nodeId: string; attempt: number; callId: string; operation: "invoke" | "repair_response"; parentCallId?: string }, execute: () => Promise<string>): Promise<string> {
  const { nodeId, attempt, callId, operation, parentCallId } = context;
  const attemptRoot = `nodes/${nodeId}/attempt-${attempt.toString().padStart(3, '0')}`;
  await appendRunEvent(projectRoot, runId, storage, {
    event: "provider.call.started",
    runId,
    nodeId,
    attempt,
    callId,
    operation,
    parentCallId,
    refs: {
      responseRef: `${attemptRoot}/response.raw.txt`,
      validationRef: `${attemptRoot}/validation.json`
    }
  });
  const start = performance.now();
  let failed = false;
  let result;
  try {
    result = await execute();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const elapsedMs = Math.max(0, performance.now() - start);
    await appendRunEvent(projectRoot, runId, storage, {
      event: "provider.call.completed",
      runId,
      nodeId,
      attempt,
      callId,
      operation,
      parentCallId,
      refs: {
        responseRef: `${attemptRoot}/response.raw.txt`,
        validationRef: `${attemptRoot}/validation.json`
      },
      failed,
      elapsedMs
    });
  }
  return result;
}

export async function recordValidationEvent(projectRoot: string, runId: string, storage: IntakeStorage, attemptRoot: string): Promise<void> {
  const [invocationContent, validationContent] = await Promise.all([
    storage.readRunFile(projectRoot, runId, `${attemptRoot}/invocation.json`),
    storage.readRunFile(projectRoot, runId, `${attemptRoot}/validation.json`)
  ]);
  const invocation = JSON.parse(invocationContent) as { nodeId: string; attempt: number; callId: string };
  const validation = JSON.parse(validationContent) as { valid: boolean };
  await appendRunEvent(projectRoot, runId, storage, {
    event: "node.validation.completed",
    runId,
    nodeId: invocation.nodeId,
    attempt: invocation.attempt,
    callId: invocation.callId,
    validationRef: `${attemptRoot}/validation.json`,
    valid: validation.valid
  });
}

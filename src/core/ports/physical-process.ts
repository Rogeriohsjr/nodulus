export type PhysicalTerminationCause = "cancelled" | "timedOut" | "outputLimitExceeded";

export type ProcessCleanupUnverified = {
  code: "PROCESS_TREE_UNVERIFIED";
  message: string;
  operationCause: PhysicalTerminationCause;
};

export type PhysicalFailureEvidence = {
  source: "nodulus.process";
  terminationCause: PhysicalTerminationCause;
  cleanupUnverified?: ProcessCleanupUnverified;
};

/** Build validated physical evidence without importing an adapter process-result type. */
export function createPhysicalFailureEvidence(
  terminationCause: unknown,
  cleanupUnverified?: unknown,
): PhysicalFailureEvidence | undefined {
  if (!isTerminationCause(terminationCause)) return undefined;
  if (cleanupUnverified === undefined) return { source: "nodulus.process", terminationCause };
  const cleanup = readCleanupUnverified(cleanupUnverified, terminationCause);
  if (!cleanup) return undefined;
  return { source: "nodulus.process", terminationCause, cleanupUnverified: cleanup };
}

/** Attach validated evidence to the same Error object so its identity and cause survive. */
export function attachPhysicalFailureEvidence<T>(error: T, evidence: PhysicalFailureEvidence): T {
  const sanitized = sanitizePhysicalFailureEvidence(evidence);
  if (!sanitized || typeof error !== "object" || error === null) return error;
  try {
    Object.defineProperty(error, "physicalFailure", {
      configurable: true,
      enumerable: false,
      value: sanitized,
      writable: true,
    });
  } catch {
    // Physical provenance is optional; it must never replace the primary failure.
  }
  return error;
}

/** Copy validated evidence when a logical stop error replaces the original failure. */
export function copyPhysicalFailureEvidence<T>(target: T, source: unknown): T {
  const evidence = getPhysicalFailureEvidence(source);
  return evidence ? attachPhysicalFailureEvidence(target, evidence) : target;
}

/** Read only a validated own data property; arbitrary getters and proxies are ignored. */
export function getPhysicalFailureEvidence(error: unknown): PhysicalFailureEvidence | undefined {
  if (!isRecord(error)) return undefined;
  const property = ownDataValue(error, "physicalFailure");
  if (!property.found) return undefined;
  return sanitizePhysicalFailureEvidence(property.value);
}

function sanitizePhysicalFailureEvidence(value: unknown): PhysicalFailureEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const keys = safeOwnKeys(value);
  const source = ownDataValue(value, "source");
  const terminationCause = ownDataValue(value, "terminationCause");
  const cleanup = ownDataValue(value, "cleanupUnverified");
  if (!keys || !source.found || source.value !== "nodulus.process" ||
      !terminationCause.found || !isTerminationCause(terminationCause.value)) return undefined;
  if (!cleanup.found) {
    if (!hasExactKeys(keys, ["source", "terminationCause"])) return undefined;
    return { source: "nodulus.process", terminationCause: terminationCause.value };
  }
  if (cleanup.value === undefined || !hasExactKeys(keys, ["source", "terminationCause", "cleanupUnverified"])) return undefined;
  const cleanupUnverified = readCleanupUnverified(cleanup.value, terminationCause.value);
  if (!cleanupUnverified) return undefined;
  return { source: "nodulus.process", terminationCause: terminationCause.value, cleanupUnverified };
}
function readCleanupUnverified(value: unknown, cause: PhysicalTerminationCause): ProcessCleanupUnverified | undefined {
  if (!isRecord(value)) return undefined;
  const keys = safeOwnKeys(value);
  const code = ownDataValue(value, "code");
  const message = ownDataValue(value, "message");
  const operationCause = ownDataValue(value, "operationCause");
  if (!keys || !hasExactKeys(keys, ["code", "message", "operationCause"]) ||
      !code.found || code.value !== "PROCESS_TREE_UNVERIFIED" ||
      !message.found || typeof message.value !== "string" || message.value.trim().length === 0 ||
      !operationCause.found || operationCause.value !== cause) return undefined;
  return { code: "PROCESS_TREE_UNVERIFIED", message: message.value, operationCause: cause };
}

function ownDataValue(value: Record<string, unknown>, key: string): { found: true; value: unknown } | { found: false } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? { found: true, value: descriptor.value } : { found: false };
  } catch {
    return { found: false };
  }
}

function safeOwnKeys(value: Record<string, unknown>): string[] | undefined {
  try { return Object.keys(value); }
  catch { return undefined; }
}

function hasExactKeys(actual: string[], expected: string[]): boolean {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.length === sortedExpected.length && sortedActual.every((key, index) => key === sortedExpected[index]);
}

function isTerminationCause(value: unknown): value is PhysicalTerminationCause {
  return value === "cancelled" || value === "timedOut" || value === "outputLimitExceeded";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try { return !Array.isArray(value); }
  catch { return false; }
}

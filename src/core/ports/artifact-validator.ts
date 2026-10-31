import type { PhysicalTerminationCause, ProcessCleanupUnverified } from "./physical-process.js";

export type ValidatorProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled?: boolean;
  outputLimitExceeded: boolean;
  terminationCause?: PhysicalTerminationCause;
  cleanupUnverified?: ProcessCleanupUnverified;
};

export interface ArtifactValidator {
  execute(projectRoot: string, scriptPath: string, artifactJson: string, timeoutMs: number, signal?: AbortSignal): Promise<ValidatorProcessResult>;
}

export type ValidatorProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled?: boolean;
  outputLimitExceeded: boolean;
};

export interface ArtifactValidator {
  execute(projectRoot: string, scriptPath: string, artifactJson: string, timeoutMs: number, signal?: AbortSignal): Promise<ValidatorProcessResult>;
}

export type RunFiles = Record<string, string>;
export type RunLock = { release(): Promise<void> };

export interface IntakeStorage {
  readUtf8(absolutePath: string): Promise<string>;
  createRun(projectRoot: string, runId: string, files: RunFiles): Promise<string>;
  readRunFile(projectRoot: string, runId: string, relativePath: string): Promise<string>;
  writeRunFiles(projectRoot: string, runId: string, files: RunFiles): Promise<void>;
  acquireRunLock?(projectRoot: string, runId: string): Promise<RunLock>;
}

export type RunFiles = Record<string, string>;

export interface IntakeStorage {
  readUtf8(absolutePath: string): Promise<string>;
  createRun(projectRoot: string, runId: string, files: RunFiles): Promise<string>;
}

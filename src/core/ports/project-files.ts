export interface ProjectFiles {
  createFileIfMissing(relativePath: string, contents: string): Promise<void>;
  ensureLine(relativePath: string, line: string): Promise<void>;
}

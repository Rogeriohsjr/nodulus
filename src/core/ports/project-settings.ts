export interface ProjectSettingsStore {
  findNearestProject(startDirectory: string): Promise<string | null>;
  readSettings(projectRoot: string): Promise<string>;
}

export interface ExecutableDiscovery {
  isAvailable(executable: string, projectRoot: string): Promise<boolean>;
}

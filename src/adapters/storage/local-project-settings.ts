import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectSettingsStore } from "../../core/ports/project-settings.js";

const settingsRelativePath = path.join(".nodulus", "settings.json");

export class LocalProjectSettings implements ProjectSettingsStore {
  async findNearestProject(startDirectory: string): Promise<string | null> {
    let directory = path.resolve(startDirectory);
    while (true) {
      const candidate = path.join(directory, settingsRelativePath);
      try {
        if ((await stat(candidate)).isFile()) return directory;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }

  async readSettings(projectRoot: string): Promise<string> {
    const settingsPath = path.join(projectRoot, settingsRelativePath);
    try {
      return await readFile(settingsPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`No .nodulus/settings.json found in ${projectRoot}. Pass --project <path> or run from a project directory.`);
      }
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

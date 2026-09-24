import { access, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import type { ExecutableDiscovery } from "../../core/ports/project-settings.js";

export class LocalExecutableDiscovery implements ExecutableDiscovery {
  async isAvailable(executable: string, projectRoot: string): Promise<boolean> {
    const hasPathSeparator = executable.includes("/") || executable.includes("\\");
    const extensions = executableExtensions();
    for (const candidate of withPlatformExtensions(executable, extensions)) {
      const directCandidate = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(projectRoot, candidate);
      if (await isExecutableFile(directCandidate, extensions)) return true;
    }
    if (hasPathSeparator) return false;

    const searchDirectories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const directory of searchDirectories) {
      for (const candidate of withPlatformExtensions(executable, extensions)) {
        if (await isExecutableFile(path.join(directory, candidate), extensions)) return true;
      }
    }
    return false;
  }
}

function executableExtensions(): string[] {
  if (process.platform !== "win32") return [""];
  return (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
}

function withPlatformExtensions(executable: string, extensions: string[]): string[] {
  if (process.platform !== "win32") return [executable];
  const lowerName = executable.toLowerCase();
  if (extensions.some((extension) => lowerName.endsWith(extension))) return [executable];
  return extensions.map((extension) => `${executable}${extension}`);
}

async function isExecutableFile(filePath: string, extensions: string[]): Promise<boolean> {
  try {
    if (!(await stat(filePath)).isFile()) return false;
    if (process.platform === "win32") {
      const lowerPath = filePath.toLowerCase();
      if (!extensions.some((extension) => lowerPath.endsWith(extension))) return false;
    } else {
      await access(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectFiles } from "../../core/ports/project-files.js";

export class LocalProjectFiles implements ProjectFiles {
  constructor(private readonly projectRoot: string) {}

  async createFileIfMissing(relativePath: string, contents: string): Promise<void> {
    const absolutePath = this.resolveProjectPath(relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      await writeFile(absolutePath, contents, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return;
      throw error;
    }
  }

  async ensureLine(relativePath: string, line: string): Promise<void> {
    const absolutePath = this.resolveProjectPath(relativePath);
    let current: string;
    try {
      current = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.createFileIfMissing(relativePath, `${line}\n`);
        return;
      }
      throw error;
    }

    if (current.split(/\r?\n/).includes(line)) return;
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await appendFile(absolutePath, `${separator}${line}\n`, "utf8");
  }

  private resolveProjectPath(relativePath: string): string {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
      throw new Error(`Project path must stay relative to the project root: ${relativePath}`);
    }
    return path.resolve(this.projectRoot, relativePath);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

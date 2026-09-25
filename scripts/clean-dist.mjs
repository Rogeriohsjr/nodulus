import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.resolve(repositoryRoot, "dist");
const relativeTarget = path.relative(repositoryRoot, outputDirectory);
if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
  throw new Error(`Refusing to clean build output outside the repository: ${outputDirectory}`);
}
rmSync(outputDirectory, { recursive: true, force: true });

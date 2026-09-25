import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = path.join(repositoryRoot, "dist", "bin.js");

test("INIT-001 creates a usable starter project from an empty directory", () => {
  const project = mkdtempSync(path.join(tmpdir(), "nodulus-init-"));

  try {
    const result = spawnSync(
      process.execPath,
      [cliPath, "init", "--project", project],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);

    const expectedFiles = [
      ".nodulus/settings.json",
      ".nodulus/workflows/example.json",
      ".nodulus/nodes/example.json",
      ".nodulus/instructions/example.md",
      ".nodulus/contracts/example.v1.schema.json",
      ".gitignore",
    ];
    for (const relativePath of expectedFiles) {
      const absolutePath = path.join(project, relativePath);
      expect(existsSync(absolutePath), relativePath).toBe(true);
      expect(statSync(absolutePath).isFile(), relativePath).toBe(true);
    }

    const readJson = (relativePath: string): Record<string, unknown> =>
      JSON.parse(readFileSync(path.join(project, relativePath), "utf8")) as Record<string, unknown>;
    const settings = readJson(".nodulus/settings.json");
    const workflow = readJson(".nodulus/workflows/example.json");
    const node = readJson(".nodulus/nodes/example.json");
    const contract = readJson(".nodulus/contracts/example.v1.schema.json");

    expect(settings).toEqual(expect.any(Object));
    expect(settings.providerProfiles).toEqual({});
    expect(workflow.nodes).toContain("example");
    expect(node.id).toBe("example");
    expect(node.providerProfile).toBe("unconfigured");
    expect(Array.isArray(node.instructions)).toBe(true);
    expect(node.instructions).not.toHaveLength(0);
    expect(node.expectedOutputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "example", contract: "example.v1" })]),
    );
    const validateExample = new Ajv2020().compile(contract);
    expect(validateExample({ message: "Example output" })).toBe(true);
    expect(validateExample({ message: 42 })).toBe(false);
    const instructionPath = node.instructions[0];
    expect(typeof instructionPath).toBe("string");
    const resolvedInstructionPath = path.resolve(project, instructionPath as string);
    expect(resolvedInstructionPath.startsWith(`${path.resolve(project)}${path.sep}`)).toBe(true);
    expect(readFileSync(resolvedInstructionPath, "utf8").trim().length).toBeGreaterThan(0);
    expect(readFileSync(path.join(project, ".gitignore"), "utf8")).toContain(".nodulus/runs/");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("INIT-001 init help explains the generated project files", () => {
  const result = spawnSync(process.execPath, [cliPath, "init", "--help"], {
    encoding: "utf8",
    timeout: 10_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Create a project with starter settings");
  expect(result.stdout).toContain("contracts");
  expect(result.stdout).toContain("--project <path>");
});

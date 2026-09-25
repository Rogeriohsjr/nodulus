import { afterAll, beforeAll, expect, test } from "vitest";
import crossSpawn from "cross-spawn";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(path.join(tmpdir(), "nodulus-package-"));
const packageDirectory = path.join(scratch, "packed tarballs");
const installedPrefix = path.join(scratch, "isolated-prefix");
let archivePath = "";
let packageVersion = "";
let packageName = "";
let archivedPaths: string[] = [];

beforeAll(() => {
  mkdirSync(packageDirectory, { recursive: true });
  const staleOutputDirectory = path.join(repository, "dist", "core");
  mkdirSync(staleOutputDirectory, { recursive: true });
  for (const extension of ["js", "js.map", "d.ts"]) {
    writeFileSync(path.join(staleOutputDirectory, `execute-single-node.${extension}`), "stale generated output\n", "utf8");
  }
  runOk("npm", ["run", "build"], repository);
  const packed = runOk("npm", ["pack", "--json", "--pack-destination", packageDirectory], repository);
  const metadata = JSON.parse(packed.stdout)[0] as { filename: string; name: string; version: string; files: Array<{ path: string }> };
  archivePath = path.join(packageDirectory, metadata.filename);
  packageName = metadata.name;
  packageVersion = metadata.version;
  archivedPaths = metadata.files.map(({ path: filename }) => filename);
  runOk("npm", ["install", "--no-audit", "--no-fund", "--prefix", installedPrefix, archivePath], repository);
}, 120_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("PKG-001 installs and runs the actual archive CLI, initializer, and fixture workflow", () => {
  const help = runInstalled(installedPrefix, ["--help"], scratch);
  expect(help.status, `${String(help.stdout)}\n${String(help.stderr)}`).toBe(0);
  expect(help.stdout).toContain("Usage: nodulus");

  const version = runInstalled(installedPrefix, ["--version"], scratch);
  expect(version.status, `${String(version.stdout)}\n${String(version.stderr)}`).toBe(0);
  expect(version.stdout.trim()).toBe(packageVersion);

  const project = path.join(scratch, "installed project & ü %");
  const initialized = runInstalled(installedPrefix, ["init", "--project", project], scratch);
  expect(initialized.status).toBe(0);
  expect(JSON.parse(readFileSync(path.join(project, ".nodulus", "contracts", "example.v1.schema.json"), "utf8")).$id).toBe("example.v1");

  const fixture = installFixtureProvider(project, "success");
  configureExampleProvider(project, fixture.executable);
  const response = runInstalled(installedPrefix, ["run", "--project", project, "--request", "Packaged CLI fixture", "--json"], project);
  expect(response.status).toBe(0);
  expect(JSON.parse(response.stdout)).toMatchObject({ schemaVersion: 1, status: "success", result: { artifacts: [{ name: "example", data: { message: "archive fixture" } }] } });
  const invocation = JSON.parse(readFileSync(fixture.logPath, "utf8").trim());
  expect(invocation.argv).toContain("exec");
  expect(invocation.argv).toContain("--output-last-message");
});

test("PKG-002 includes the user guide and starter assets while excluding development files", () => {
  expect(archivedPaths).toContain("README.md");
  expect(archivedPaths).toContain("docs/user-guide.md");
  expect(archivedPaths.some((filename) => filename.startsWith("tests/"))).toBe(false);
  expect(archivedPaths.some((filename) => filename.startsWith(".agents/"))).toBe(false);
  expect(archivedPaths.some((filename) => filename.startsWith(".codex/"))).toBe(false);
  expect(archivedPaths.some((filename) => filename.startsWith("dist/core/execute-single-node."))).toBe(false);
  expect(archivedPaths).toContain("dist/bin.js");
  expect(archivedPaths).toContain("dist/index.js");
  const installedRoot = installedPackageDirectory(installedPrefix);
  const readme = readFileSync(path.join(installedRoot, "README.md"), "utf8");
  const guide = readFileSync(path.join(installedRoot, "docs", "user-guide.md"), "utf8");
  expect(readme).toMatch(/docs\/user-guide\.md/);
  for (const instruction of ["nodulus init", "nodulus run", "needs_input", "nodulus resume", "error", "example.v1", ".nodulus/contracts/"]) {
    expect(guide).toContain(instruction);
  }
});

test("PKG-002 resolves every local link in the installed package Markdown", () => {
  const installedRoot = installedPackageDirectory(installedPrefix);
  const markdownFiles = archivedPaths
    .filter((filename) => filename.endsWith(".md"))
    .map((filename) => path.join(installedRoot, filename));
  const localTargets: string[] = [];
  for (const markdownPath of markdownFiles) {
    const contents = readFileSync(markdownPath, "utf8");
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!.split("#", 1)[0]!;
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) continue;
      localTargets.push(path.resolve(path.dirname(markdownPath), decodeURIComponent(target)));
    }
  }
  expect(localTargets.length).toBeGreaterThan(0);
  for (const target of localTargets) expect(existsSync(target), target).toBe(true);
});

test("PKG-004 imports the installed application API without CLI argv or stdout effects", () => {
  const consumer = path.join(installedPrefix, "api consumer");
  const project = path.join(scratch, "api project");
  mkdirSync(consumer, { recursive: true });
  const initialized = runInstalled(installedPrefix, ["init", "--project", project], consumer);
  expect(initialized.status).toBe(0);
  const fixture = installFixtureProvider(project, "success");
  configureExampleProvider(project, fixture.executable);
  const resultPath = path.join(consumer, "result.json");
  const scriptPath = path.join(consumer, "consumer.mjs");
  writeFileSync(scriptPath, [
    "import { writeFileSync } from 'node:fs';",
    "import { runWorkflow } from '@rogeriohsjr/nodulus';",
    `const result = await runWorkflow({ projectRoot: ${JSON.stringify(project)}, cwd: ${JSON.stringify(project)}, workflow: 'example', sources: [{ kind: 'inline', text: 'API boundary' }] }, { async invoke() { return JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: 'api fixture' } }] }); } });`,
    `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));`,
  ].join("\n"), "utf8");
  const run = crossSpawn.sync(process.execPath, [scriptPath], { cwd: consumer, encoding: "utf8", timeout: 30_000, windowsHide: true });
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("");
  expect(run.stderr).toBe("");
  expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({ status: "success", result: { artifacts: [{ data: { message: "api fixture" } }] } });
  expect(existsSync(fixture.logPath)).toBe(false);
});

test("PKG-003 upgrades from a real older archive and resumes a paused run without changing captured definitions", () => {
  const priorStage = path.join(scratch, "prior package source");
  stageBuiltPackage(repository, priorStage);
  const priorPackageJson = path.join(priorStage, "package.json");
  const priorManifest = JSON.parse(readFileSync(priorPackageJson, "utf8"));
  priorManifest.version = "1.0.0-fixture.1";
  writeFileSync(priorPackageJson, `${JSON.stringify(priorManifest, null, 2)}\n`, "utf8");
  const priorPacked = runOk("npm", ["pack", "--json", "--pack-destination", packageDirectory], priorStage);
  const priorFilename = (JSON.parse(priorPacked.stdout)[0] as { filename: string; version: string }).filename;
  expect(priorFilename).toBe("rogeriohsjr-nodulus-1.0.0-fixture.1.tgz");

  const prefix = path.join(scratch, "upgrade-prefix");
  runOk("npm", ["install", "--no-audit", "--no-fund", "--prefix", prefix, path.join(packageDirectory, priorFilename)], priorStage);
  const project = path.join(scratch, "upgrade project");
  mkdirSync(project, { recursive: true });
  const oldInit = runInstalled(prefix, ["init", "--project", project], project);
  expect(oldInit.status, JSON.stringify(oldInit)).toBe(0);
  const oldVersion = runInstalled(prefix, ["--version"], project);
  expect(oldVersion.status).toBe(0);
  expect(oldVersion.stdout.trim()).toBe("1.0.0-fixture.1");
  const fixture = installFixtureProvider(project, "pause-then-success");
  configureExampleProvider(project, fixture.executable);
  const paused = runInstalled(prefix, ["run", "--project", project, "--request", "Keep this run", "--json"], project);
  expect(paused.status).toBe(2);
  const pending = JSON.parse(paused.stdout);
  const runId = pending.runId as string;
  const runRoot = path.join(project, ".nodulus", "runs", runId);
  const definitionsPath = path.join(runRoot, "context", "definitions.json");
  const capturedDefinitions = readFileSync(definitionsPath, "utf8");
  const checkpointPath = path.join(runRoot, "run.json");
  const pausedCheckpoint = readFileSync(checkpointPath, "utf8");
  const requestId = pending.result.request.id as string;

  runOk("npm", ["install", "--no-audit", "--no-fund", "--prefix", prefix, archivePath], project);
  expect(JSON.parse(readFileSync(path.join(installedPackageDirectory(prefix), "package.json"), "utf8")).version).toBe(packageVersion);
  const upgradedVersion = runInstalled(prefix, ["--version"], project);
  expect(upgradedVersion.status).toBe(0);
  expect(upgradedVersion.stdout.trim()).toBe(packageVersion);
  expect(readFileSync(definitionsPath, "utf8")).toBe(capturedDefinitions);
  expect(readFileSync(checkpointPath, "utf8")).toBe(pausedCheckpoint);
  const answersPath = path.join(project, "answers.json");
  writeFileSync(answersPath, JSON.stringify({ confirmed: true }), "utf8");
  const resumed = runInstalled(prefix, ["resume", runId, "--request-id", requestId, "--answers-file", answersPath, "--project", project, "--json"], project);
  expect(resumed.status).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ schemaVersion: 1, status: "success", runId });
  expect(JSON.parse(readFileSync(checkpointPath, "utf8")).status).toBe("success");
  expect(readFileSync(definitionsPath, "utf8")).toBe(capturedDefinitions);
  expect(readFileSync(fixture.logPath, "utf8").trim().split("\n")).toHaveLength(2);
}, 120_000);

function runInstalled(prefix: string, args: string[], cwd: string): ReturnType<typeof crossSpawn.sync> {
  const shim = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "nodulus.cmd" : "nodulus");
  return crossSpawn.sync(shim, args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
}

function runOk(command: string, args: string[], cwd: string): ReturnType<typeof crossSpawn.sync> {
  const result = crossSpawn.sync(command, args, { cwd, encoding: "utf8", timeout: 120_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  return result;
}

function installFixtureProvider(project: string, mode: "success" | "pause-then-success"): { executable: string; logPath: string } {
  const directory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(directory, { recursive: true });
  const scriptPath = path.join(directory, "fixture.mjs");
  const logPath = path.join(directory, "invocations.jsonl");
  writeFileSync(scriptPath, [
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    `const mode = ${JSON.stringify(mode)};`,
    `const logPath = ${JSON.stringify(logPath)};`,
    "const flag = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };",
    "if (args[0] === '--version') { process.stdout.write('codex-cli 0.144.4\\n'); process.exit(0); }",
    "if (args[0] === 'login' && args[1] === 'status') process.exit(0);",
    "const count = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\\n').filter(Boolean).length : 0;",
    "let raw;",
    "if (mode === 'pause-then-success' && count === 0) raw = JSON.stringify({ status: 'needs_input', request: { id: 'fixture-question', questions: [{ id: 'confirmed', message: 'Confirm?' }], answerContract: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'], additionalProperties: false } } });",
    "else raw = JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: 'archive fixture' } }] });",
    "appendFileSync(logPath, JSON.stringify({ argv: args }) + '\\n');",
    "const output = flag('--output-last-message'); if (output) writeFileSync(output, raw, 'utf8');",
    "process.stdout.write('{\\\"type\\\":\\\"turn.completed\\\"}\\n');",
  ].join("\n"), "utf8");
  const executable = process.platform === "win32"
    ? path.join(directory, "fixture provider.cmd")
    : path.join(directory, "fixture provider.sh");
  if (process.platform === "win32") {
    writeFileSync(executable, `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${scriptPath}' "$@"\n`, "utf8");
    chmodSync(executable, 0o755);
  }
  return { executable, logPath };
}

function configureExampleProvider(project: string, executable: string): void {
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles.fixture = { kind: "codex", enabled: true, executable, model: "fixture-model", timeoutMs: 5000, capabilities: [] };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  node.providerProfile = "fixture";
  node.inputs = { request: { from: "request", contract: "request.v1" } };
  writeFileSync(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");
}

function stageBuiltPackage(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const item of ["package.json", "README.md", "NOTICE", "LICENSE", "dist", "docs"]) {
    cpSync(path.join(source, item), path.join(destination, item), { recursive: true });
  }
}

test("PKG-005 packs the scoped public package with Apache-2.0 notices in the archive", () => {
  const installedRoot = installedPackageDirectory(installedPrefix);
  const manifest = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  expect(manifest).toMatchObject({
    name: "@rogeriohsjr/nodulus",
    version: packageVersion,
    private: false,
    license: "Apache-2.0",
    publishConfig: { access: "public" },
  });
  expect(manifest.version).not.toBe("0.0.0");
  expect(archivedPaths).toContain("LICENSE");
  expect(archivedPaths).toContain("NOTICE");
  expect(readFileSync(path.join(installedRoot, "LICENSE"), "utf8")).toContain("Apache License");
  expect(readFileSync(path.join(installedRoot, "NOTICE"), "utf8").trim().length).toBeGreaterThan(0);
});

function installedPackageDirectory(prefix: string): string {
  return path.join(prefix, "node_modules", ...packageName.split("/"));
}

import { exerciseTaskLoop } from '../support/task-loop-scenario.js';
import { afterAll, beforeAll, expect, test } from "vitest";
import crossSpawn from "cross-spawn";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyInstalledFailure, runInstalledProviderSmoke } from "../support/live-provider-observability.js";

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

test("PKG-008 installed task helper includes executable workflows and preserves existing setup", () => {
  const project = path.join(scratch, "task planning ü");
  mkdirSync(project);
  const shim = path.join(installedPrefix, "node_modules/.bin", process.platform === "win32" ? "nodulus-task.cmd" : "nodulus-task");
  expect(existsSync(shim), "archive must install nodulus-task executable").toBe(true);
  const setup = crossSpawn.sync(shim, ["setup", project], { cwd: scratch, encoding: "utf8", timeout: 30000, windowsHide: true });
  expect(setup.status, String(setup.stderr)).toBe(0);
  expect(existsSync(path.join(project, ".nodulus/workflows/task-plan.json"))).toBe(true);
  expect(existsSync(path.join(project, ".nodulus/task-tools/runtime.mjs"))).toBe(true);
  for (const helper of ["io.mjs", "recovery.mjs", "recovery-state.mjs", "rework.mjs", "loop-state.mjs"]) {
    expect(existsSync(path.join(project, ".nodulus/task-tools", helper)), `setup must install ${helper}`).toBe(true);
  }
  const recovery = crossSpawn.sync(process.execPath, [path.join(project, ".nodulus/task-tools/runtime.mjs"), "recover", project], { encoding: "utf8", timeout: 30000, windowsHide: true });
  expect(recovery.status).toBe(1);
  expect(JSON.parse(recovery.stderr).error).toBe("Task execution state not found");
  expect(JSON.parse(readFileSync(path.join(project, "opencode.json"), "utf8")).enabled_providers).toEqual(["ollama"]);
  const second = crossSpawn.sync(shim, ["setup", project], { cwd: scratch, encoding: "utf8", timeout: 30000, windowsHide: true });
  expect(second.status, String(second.stderr)).toBe(0);
  expect(JSON.parse(second.stdout).existingOpenCodeConfig).toBe(true);
});

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
  const parsedResponse = JSON.parse(response.stdout);
  expect(parsedResponse).toMatchObject({ schemaVersion: 1, status: "success", result: { artifacts: [{ name: "example", data: { message: "archive fixture" } }] } });
  const status = runInstalled(installedPrefix, ["status", parsedResponse.runId, "--project", project, "--json"], project);
  expect(status.status, String(status.stderr)).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    schemaVersion: 1,
    status: "success",
    runId: parsedResponse.runId,
    result: { metrics: { calls: [expect.objectContaining({ nodeId: "example", usage: null })] } },
  });
  const textStatus = runInstalled(installedPrefix, ["status", parsedResponse.runId, "--project", project], project);
  expect(textStatus.status, String(textStatus.stderr)).toBe(0);
  expect(textStatus.stdout).toContain("Input tokens: unknown");
  const invocation = JSON.parse(readFileSync(fixture.logPath, "utf8").trim());
  expect(invocation.argv).toContain("exec");
  expect(invocation.argv).toContain("--output-last-message");

  const callsBeforeInspection = readFileSync(fixture.logPath, "utf8");
  const inspectWorkflow = runInstalled(installedPrefix, ["inspect", "workflow", "example", "--project", project, "--json"], project);
  expect(inspectWorkflow.status, String(inspectWorkflow.stderr)).toBe(0);
  expect(JSON.parse(inspectWorkflow.stdout)).toMatchObject({ status: "success", result: { workflow: { id: "example" } } });
  const inspectRun = runInstalled(installedPrefix, ["inspect", "run", parsedResponse.runId, "--project", project, "--json"], project);
  expect(inspectRun.status, String(inspectRun.stderr)).toBe(0);
  expect(JSON.parse(inspectRun.stdout)).toMatchObject({ status: "success", runId: parsedResponse.runId, result: { status: "success" } });
  const exportRun = runInstalled(installedPrefix, ["inspect", "export", parsedResponse.runId, "--project", project, "--json"], project);
  expect(exportRun.status, String(exportRun.stderr)).toBe(0);
  expect(JSON.parse(exportRun.stdout)).toMatchObject({ status: "success", result: { schemaVersion: 1, run: { runId: parsedResponse.runId } } });
  const replayRun = runInstalled(installedPrefix, ["inspect", "replay", parsedResponse.runId, "--project", project, "--json"], project);
  expect(replayRun.status, String(replayRun.stderr)).toBe(0);
  expect(JSON.parse(replayRun.stdout)).toMatchObject({ status: "success", result: { mode: "schema-only", runId: parsedResponse.runId } });
  expect(readFileSync(fixture.logPath, "utf8")).toBe(callsBeforeInspection);
});

test("PKG-010 shared installed provider smokes run sequentially with real child-process fixtures", () => {
  for (const provider of ["codex", "cursor", "opencode"] as const) {
    const fixture = createInstalledSmokeFixture(provider);
    const model = provider === "opencode" ? "ollama/qwen3.5:9b" : null;
    const evidence = runInstalledProviderSmoke({
      provider,
      executable: fixture.executable,
      model,
      timeoutMs: 10_000,
      prepareProject: fixture.prepareProject,
    });
    expect(evidence).toMatchObject({ provider, model, reportedModel: null, runId: expect.any(String), callId: expect.any(String) });
    expect(evidence.coverage).toBe(provider === "cursor" ? "unavailable" : "complete");
  }
  const codexFixture = createInstalledSmokeFixture("codex");
  const unavailableExecutable = path.join(scratch, "private executable path that must not escape");
  expect(() => runInstalledProviderSmoke({
    provider: "codex",
    executable: unavailableExecutable,
    model: null,
    timeoutMs: 10_000,
    prepareProject: codexFixture.prepareProject,
  })).toThrow(/^Installed smoke run installed CLI failed \(exit 1, code unknown\)\.$/);
}, 360_000);

test("PKG-011 offline installed smoke fixtures do not overwrite saved live evidence", () => {
  const markerPath = path.join(scratch, "preserved live evidence.json");
  const marker = JSON.stringify({ source: "previous live run", marker: "must-remain-unchanged" });
  writeFileSync(markerPath, marker, "utf8");
  const previousEvidencePath = process.env.NODULUS_LIVE_EVIDENCE;
  process.env.NODULUS_LIVE_EVIDENCE = markerPath;
  try {
    const fixture = createInstalledSmokeFixture("codex");
    runInstalledProviderSmoke({
      provider: "codex",
      executable: fixture.executable,
      model: null,
      timeoutMs: 10_000,
      prepareProject: fixture.prepareProject,
    });
    expect(readFileSync(markerPath, "utf8")).toBe(marker);
  } finally {
    if (previousEvidencePath === undefined) delete process.env.NODULUS_LIVE_EVIDENCE;
    else process.env.NODULUS_LIVE_EVIDENCE = previousEvidencePath;
  }
}, 120_000);

test("PKG-012 installed smoke failure diagnostics classify a provider exit without exposing output", () => {
  const fixture = createFailingInstalledSmokeFixture();
  const diagnosticPath = path.join(scratch, "provider failure diagnostic.json");
  expect(() => runInstalledProviderSmoke({
    provider: "codex",
    executable: fixture.executable,
    model: null,
    timeoutMs: 10_000,
    diagnosticPath,
    prepareProject: fixture.prepareProject,
  })).toThrow();

  const diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8"));
  expect(diagnostic).toEqual({
    stage: "run",
    cliExitCode: 1,
    envelopeStatus: "error",
    errorCode: "PROVIDER_FAILURE",
    runIdPresent: true,
    callLaunched: true,
    requestAvailable: true,
    transportAvailable: true,
    transportExitCode: 23,
    timedOut: false,
    outputLimitExceeded: false,
  });
  const serialized = JSON.stringify(diagnostic);
  expect(serialized).not.toContain("FIXTURE-SECRET-CREDENTIAL");
  expect(serialized).not.toContain("FIXTURE-PRIVATE-PROMPT");
  expect(serialized).not.toContain(fixture.executable);
}, 120_000);

test("PKG-013 prelaunch installed smoke diagnostics report unavailable call evidence", () => {
  const fixture = createInstalledSmokeFixture("codex");
  const diagnosticPath = path.join(scratch, "prelaunch failure diagnostic.json");
  const executable = path.join(scratch, "missing provider executable");
  expect(() => runInstalledProviderSmoke({
    provider: "codex",
    executable,
    model: null,
    timeoutMs: 10_000,
    diagnosticPath,
    prepareProject: fixture.prepareProject,
  })).toThrow();

  const diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8"));
  expect(diagnostic).toEqual({
    stage: "run",
    cliExitCode: 1,
    envelopeStatus: "error",
    errorCode: "PROVIDER_FAILURE",
    runIdPresent: true,
    callLaunched: false,
    requestAvailable: false,
    transportAvailable: false,
    transportExitCode: null,
    timedOut: false,
    outputLimitExceeded: false,
  });
  expect(JSON.stringify(diagnostic)).not.toContain(executable);
}, 120_000);

test("PKG-014 failure diagnostic classifier redacts unknown envelope statuses and unavailable observations", () => {
  const project = path.join(scratch, "failure classification fixture");
  mkdirSync(project, { recursive: true });
  const envelopePath = path.join(project, "malformed-status-envelope.json");
  writeFileSync(envelopePath, JSON.stringify({
    schemaVersion: 1,
    status: "SECRET-UNRECOGNIZED-ENVELOPE-STATUS",
    runId: "runfixture123",
    result: { error: { code: "PROVIDER_FAILURE", message: "SECRET-PRIVATE-DIAGNOSTIC" } },
  }), "utf8");

  const diagnostic = classifyInstalledFailure(readFileSync(envelopePath, "utf8"), null, project);
  expect(diagnostic).toMatchObject({
    envelopeStatus: null,
    runIdPresent: true,
    callLaunched: null,
    requestAvailable: null,
    transportAvailable: null,
    transportExitCode: null,
    timedOut: null,
    outputLimitExceeded: null,
  });
  expect(JSON.stringify(diagnostic)).not.toContain("SECRET-UNRECOGNIZED-ENVELOPE-STATUS");
  expect(JSON.stringify(diagnostic)).not.toContain("SECRET-PRIVATE-DIAGNOSTIC");
});

test("PKG-002 includes the user guide and starter assets while excluding development files", () => {
  expect(archivedPaths).toContain("README.md");
  expect(archivedPaths).toContain("docs/user-guide.md");
  expect(archivedPaths).toContain("docs/provider-usage.md");
  expect(archivedPaths).toContain("docs/cost-estimates.md");
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

test("PKG-002 installed cost guide examples pass real CLI intake", () => {
  const installedRoot = installedPackageDirectory(installedPrefix);
  const guide = readFileSync(path.join(installedRoot, "docs", "cost-estimates.md"), "utf8");
  const examples = [...guide.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
  expect(examples).toHaveLength(3);

  const project = path.join(scratch, "cost guide example");
  const initialized = runInstalled(installedPrefix, ["init", "--project", project], scratch);
  expect(initialized.status, String(initialized.stderr)).toBe(0);
  writeFileSync(path.join(project, ".nodulus", "settings.json"), `${JSON.stringify(JSON.parse(examples[0]!), null, 2)}\n`, "utf8");
  writeFileSync(path.join(project, ".nodulus", "pricing.json"), examples[1]!, "utf8");
  const fixture = installFixtureProvider(project, "success");
  configureExampleProvider(project, fixture.executable);

  const response = runInstalled(installedPrefix, ["run", "--project", project, "--request", "Installed guide example", "--json"], project);
  expect(response.status, `${String(response.stdout)}\n${String(response.stderr)}`).toBe(0);
  expect(JSON.parse(response.stdout)).toMatchObject({ status: "success" });
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
    "import { exportRunDiagnostic, getRunStatus, inspectRun, inspectWorkflow, replaySavedRun, runWorkflow } from '@rogeriohsjr/nodulus';",
    "const response = JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: 'api fixture' } }] });",
    "let invokeOnlyCalls = 0;",
    `const request = { projectRoot: ${JSON.stringify(project)}, cwd: ${JSON.stringify(project)}, workflow: 'example', sources: [{ kind: 'inline', text: 'API boundary' }] };`,
    "const result = await runWorkflow(request, { async invoke() { invokeOnlyCalls += 1; return response; } });",
    `const status = await getRunStatus(${JSON.stringify(project)}, result.runId);`,
    "let legacyCalls = 0;",
    "const legacy = await runWorkflow(request, { async invoke() { legacyCalls += 1; return response; }, usageForLastCall() { return { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, costUsd: 0 }; } });",
    `const legacyStatus = await getRunStatus(${JSON.stringify(project)}, legacy.runId);`,
    `const workflowInspection = await inspectWorkflow(${JSON.stringify(project)}, 'example');`,
    `const runInspection = await inspectRun(${JSON.stringify(project)}, result.runId);`,
    `const exported = await exportRunDiagnostic(${JSON.stringify(project)}, result.runId);`,
    `const replay = await replaySavedRun(${JSON.stringify(project)}, result.runId);`,
    `writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ result, invokeOnlyCalls, status, legacyCalls, legacyStatus, workflowInspection, runInspection, exported, replay }));`,
  ].join("\n"), "utf8");
  const run = crossSpawn.sync(process.execPath, [scriptPath], { cwd: consumer, encoding: "utf8", timeout: 30_000, windowsHide: true });
  expect(run.status).toBe(0);
  expect(run.stdout).toBe("");
  expect(run.stderr).toBe("");
  const imported = JSON.parse(readFileSync(resultPath, "utf8"));
  expect(imported.result).toMatchObject({ status: "success", result: { artifacts: [{ data: { message: "api fixture" } }] } });
  expect(imported.invokeOnlyCalls).toBe(1);
  expect(imported.status.metrics).toMatchObject({ origins: ["unavailable"], calls: [{ usage: null }] });
  expect(imported.legacyCalls).toBe(1);
  expect(imported.workflowInspection.workflow.id).toBe("example");
  expect(imported.runInspection.status).toBe("success");
  expect(imported.exported.run.runId).toBe(imported.result.runId);
  expect(imported.replay.mode).toBe("schema-only");
  expect(imported.legacyStatus.metrics).toMatchObject({
    origins: ["legacy_adapter"],
    calls: [{ usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, costUsd: 0 } }],
    totals: { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, costUsd: 0 },
  });
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
    "const envelope = JSON.stringify({ response: raw });",
    "appendFileSync(logPath, JSON.stringify({ argv: args }) + '\\n');",
    "const output = flag('--output-last-message'); if (output) writeFileSync(output, envelope, 'utf8');",
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

function createInstalledSmokeFixture(kind: "codex" | "cursor" | "opencode"): {
  executable: string;
  prepareProject: (project: string) => void;
} {
  const fixtureDirectory = path.join(scratch, "installed smoke fixtures");
  mkdirSync(fixtureDirectory, { recursive: true });
  const scriptPath = path.join(fixtureDirectory, "usage-provider.mjs");
  cpSync(path.join(repository, "tests", "fixtures", "observability", "usage-provider.mjs"), scriptPath);
  const executable = path.join(fixtureDirectory, process.platform === "win32" ? `${kind}-smoke.cmd` : `${kind}-smoke.sh`);
  if (process.platform === "win32") {
    writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)} "$@"\n`, "utf8");
    chmodSync(executable, 0o755);
  }
  const message = `LIVE-${kind}-artifact`;
  const outcome = JSON.stringify({ status: "success", artifacts: [{ name: "example", contract: "example.v1", data: { message } }] });
  const version = kind === "codex" ? "0.144.4" : kind === "cursor" ? "2026.09.23-86fc751" : "1.18.32";
  const stdout = kind === "codex"
    ? JSON.stringify({ type: "turn.started" }) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 3 } }) + "\n"
    : kind === "cursor"
      ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: outcome })
      : [
          { type: "text", part: { messageID: "fixture-live-message", text: outcome } },
          { type: "step_finish", part: { id: "fixture-live-step", sessionID: "fixture-live-session", messageID: "fixture-live-message", reason: "stop", tokens: { input: 8, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } },
        ].map(event => JSON.stringify(event)).join("\n") + "\n";

  return {
    executable,
    prepareProject(project) {
      const directory = path.join(project, ".nodulus", "fixtures");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "usage-control.json"), JSON.stringify({ kind, stdout, version, outcome }), "utf8");
    },
  };
}

function createFailingInstalledSmokeFixture(): {
  executable: string;
  prepareProject: (project: string) => void;
} {
  const fixtureDirectory = path.join(scratch, "failure diagnostics fixture");
  mkdirSync(fixtureDirectory, { recursive: true });
  const scriptPath = path.join(fixtureDirectory, "provider.mjs");
  writeFileSync(scriptPath, [
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { process.stdout.write('codex-cli 0.156.1\\n'); process.exit(0); }",
    "if (args[0] === 'login' && args[1] === 'status') process.exit(0);",
    "const flag = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };",
    "let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;",
    "process.stderr.write('FIXTURE-SECRET-CREDENTIAL FIXTURE-PRIVATE-PROMPT ' + stdin);",
    "const output = flag('--output-last-message'); if (output) writeFileSync(output, JSON.stringify({ response: JSON.stringify({ status: 'success', artifacts: [] }) }));",
    "process.exit(23);",
  ].join("\n"), "utf8");
  const executable = path.join(fixtureDirectory, process.platform === "win32" ? "failing-codex.cmd" : "failing-codex.sh");
  if (process.platform === "win32") {
    writeFileSync(executable, `@echo off\r\n"${process.execPath}" "%~dp0provider.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${scriptPath}' "$@"\n`, "utf8");
    chmodSync(executable, 0o755);
  }
  return {
    executable,
    prepareProject(project) {
      const directory = path.join(project, ".nodulus", "fixtures");
      mkdirSync(directory, { recursive: true });
    },
  };
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

test("PKG-006 npm public-publish dry-run reports no corrected bin metadata", () => {
  const publishDirectory = path.join(scratch, "public publish dry run");
  stageBuiltPackage(repository, publishDirectory);
  const manifestPath = path.join(publishDirectory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = `${packageVersion}-dry-run.${Date.now()}.${process.pid}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const publishDryRun = crossSpawn.sync("npm", ["publish", "--dry-run", "--tag", "dry-run", "--access", "public", "--json", "--ignore-scripts"], {
    cwd: publishDirectory,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  expect(publishDryRun.status, `${String(publishDryRun.stdout)}\n${String(publishDryRun.stderr)}`).toBe(0);
  expect(`${String(publishDryRun.stdout)}\n${String(publishDryRun.stderr)}`).not.toMatch(/invalid.*bin|bin.*invalid|bin.*removed/i);
});

function installedPackageDirectory(prefix: string): string {
  return path.join(prefix, "node_modules", ...packageName.split("/"));
}

test("PKG-009 installed task loop revises and accepts through six real CLI runs", () => exerciseTaskLoop(path.join(installedPackageDirectory(installedPrefix), "scripts/task-workflow/cli.mjs")), 40000);

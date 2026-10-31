import { exerciseTaskLoop } from '../support/task-loop-scenario.js';
import { afterAll, beforeAll, expect, test } from "vitest";
import crossSpawn from "cross-spawn";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyInstalledFailure, runInstalledProviderSmoke } from "../support/live-provider-observability.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(path.join(tmpdir(), "nodulus-package-"));
const packageDirectory = path.join(scratch, "packed tarballs");
const installedPrefix = path.join(scratch, "isolated-prefix");
let archivePath = "";
let packageVersion = "";
let packageName = "";
let archivedPaths: string[] = [];
const successfulInstalledJourneyRoots: string[] = [];

type PackageStage = "help" | "version" | "init" | "run" | "status-json" | "status-text" | "inspect-workflow" | "inspect-run" | "inspect-export" | "inspect-replay";
type PackageStageTiming = { stage: PackageStage; startMs: number; endMs: number; durationMs: number; status: number | null | "threw" };

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

afterAll(() => {
  for (const root of successfulInstalledJourneyRoots) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: false });
  }
});

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

// Ten sequential installed CLI launches share this integration budget; each child keeps its own 30-second ceiling.
test("PKG-001 installs and runs the actual archive CLI, initializer, and fixture workflow", () => {
  const timingEnabled = process.env.NODULUS_PKG001_TIMING === "1";
  const timingStartedAt = timingEnabled ? performance.now() : 0;
  const timings: PackageStageTiming[] = [];
  try {
  const help = observePackageStage(timings, timingEnabled, "help", () => runInstalled(installedPrefix, ["--help"], scratch));
  expect(help.status, `${String(help.stdout)}\n${String(help.stderr)}`).toBe(0);
  expect(help.stdout).toContain("Usage: nodulus");

  const version = observePackageStage(timings, timingEnabled, "version", () => runInstalled(installedPrefix, ["--version"], scratch));
  expect(version.status, `${String(version.stdout)}\n${String(version.stderr)}`).toBe(0);
  expect(version.stdout.trim()).toBe(packageVersion);

  const project = path.join(scratch, "installed project & ü %");
  const initialized = observePackageStage(timings, timingEnabled, "init", () => runInstalled(installedPrefix, ["init", "--project", project], scratch));
  expect(initialized.status).toBe(0);
  expect(JSON.parse(readFileSync(path.join(project, ".nodulus", "contracts", "example.v1.schema.json"), "utf8")).$id).toBe("example.v1");

  const fixture = installFixtureProvider(project, "success");
  configureExampleProvider(project, fixture.executable);
  const response = observePackageStage(timings, timingEnabled, "run", () => runInstalled(installedPrefix, ["run", "--project", project, "--request", "Packaged CLI fixture", "--json"], project));
  expect(response.status).toBe(0);
  const parsedResponse = JSON.parse(response.stdout);
  expect(parsedResponse).toMatchObject({ schemaVersion: 1, status: "success", result: { artifacts: [{ name: "example", data: { message: "archive fixture" } }] } });
  const status = observePackageStage(timings, timingEnabled, "status-json", () => runInstalled(installedPrefix, ["status", parsedResponse.runId, "--project", project, "--json"], project));
  expect(status.status, String(status.stderr)).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    schemaVersion: 1,
    status: "success",
    runId: parsedResponse.runId,
    result: { metrics: { calls: [expect.objectContaining({ nodeId: "example", usage: null })] } },
  });
  const textStatus = observePackageStage(timings, timingEnabled, "status-text", () => runInstalled(installedPrefix, ["status", parsedResponse.runId, "--project", project], project));
  expect(textStatus.status, String(textStatus.stderr)).toBe(0);
  expect(textStatus.stdout).toContain("Input tokens: unknown");
  const invocation = JSON.parse(readFileSync(fixture.logPath, "utf8").trim());
  expect(invocation.argv).toContain("exec");
  expect(invocation.argv).toContain("--output-last-message");

  const callsBeforeInspection = readFileSync(fixture.logPath, "utf8");
  const inspectWorkflow = observePackageStage(timings, timingEnabled, "inspect-workflow", () => runInstalled(installedPrefix, ["inspect", "workflow", "example", "--project", project, "--json"], project));
  expect(inspectWorkflow.status, String(inspectWorkflow.stderr)).toBe(0);
  expect(JSON.parse(inspectWorkflow.stdout)).toMatchObject({ status: "success", result: { workflow: { id: "example" } } });
  const inspectRun = observePackageStage(timings, timingEnabled, "inspect-run", () => runInstalled(installedPrefix, ["inspect", "run", parsedResponse.runId, "--project", project, "--json"], project));
  expect(inspectRun.status, String(inspectRun.stderr)).toBe(0);
  expect(JSON.parse(inspectRun.stdout)).toMatchObject({ status: "success", runId: parsedResponse.runId, result: { status: "success" } });
  const exportRun = observePackageStage(timings, timingEnabled, "inspect-export", () => runInstalled(installedPrefix, ["inspect", "export", parsedResponse.runId, "--project", project, "--json"], project));
  expect(exportRun.status, String(exportRun.stderr)).toBe(0);
  expect(JSON.parse(exportRun.stdout)).toMatchObject({ status: "success", result: { schemaVersion: 1, run: { runId: parsedResponse.runId } } });
  const replayRun = observePackageStage(timings, timingEnabled, "inspect-replay", () => runInstalled(installedPrefix, ["inspect", "replay", parsedResponse.runId, "--project", project, "--json"], project));
  expect(replayRun.status, String(replayRun.stderr)).toBe(0);
  expect(JSON.parse(replayRun.stdout)).toMatchObject({ status: "success", result: { mode: "schema-only", runId: parsedResponse.runId } });
  expect(readFileSync(fixture.logPath, "utf8")).toBe(callsBeforeInspection);
  } finally {
    if (timingEnabled) {
      const endMs = performance.now();
      const lastCompletedStage = [...timings].reverse().find((entry) => entry.status !== "threw" && entry.status !== null)?.stage ?? null;
      process.stderr.write(`PKG-001_TIMING ${JSON.stringify({ lastCompletedStage, aggregateElapsedMs: endMs - timingStartedAt, stages: timings })}\n`);
    }
  }
}, 15_000);

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

test("PKG-015 installed smoke request names the exact artifact with unambiguous JSON", () => {
  const fixture = createInstalledSmokeFixture("codex");
  const capturedStdinPath = path.join(scratch, "PKG-015 captured child stdin.txt");
  const result = runInstalledProviderSmoke({
    provider: "codex",
    executable: fixture.executable,
    model: null,
    timeoutMs: 10_000,
    prepareProject(project) {
      fixture.prepareProject(project);
      const controlPath = path.join(project, ".nodulus", "fixtures", "usage-control.json");
      const control = JSON.parse(readFileSync(controlPath, "utf8"));
      control.capturePath = capturedStdinPath;
      writeFileSync(controlPath, JSON.stringify(control), "utf8");
    },
  });

  expect(result.provider).toBe("codex");
  const capturedStdin = readFileSync(capturedStdinPath, "utf8");
  const mappedHeader = "## Mapped Inputs\n";
  const mappedStart = capturedStdin.indexOf(mappedHeader);
  expect(mappedStart).toBeGreaterThanOrEqual(0);
  const mappedContentStart = mappedStart + mappedHeader.length;
  const mappedEnd = capturedStdin.indexOf("\n\n## ", mappedContentStart);
  const mappedText = capturedStdin.slice(mappedContentStart, mappedEnd < 0 ? undefined : mappedEnd).trim();
  const mappedInputs = JSON.parse(mappedText);
  expect(typeof mappedInputs.request).toBe("string");
  const exactArtifact = JSON.stringify({
    name: "example",
    contract: "example.v1",
    data: { message: "LIVE-codex-artifact" },
  });
  expect(mappedInputs.request).toContain(exactArtifact);
  expect(mappedInputs.request).toContain("raw JSON outcome");
}, 120_000);

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

test("PKG-060 ships and runs the feedback-routing example from the installed archive", async () => {
  const installedRoot = installedPackageDirectory(installedPrefix);
  const expectedFiles = [
    "README.md",
    ".nodulus/settings.json",
    ".nodulus/workflows/normalize-review.json",
    ".nodulus/nodes/prepare.json",
    ".nodulus/nodes/normalize.json",
    ".nodulus/nodes/review.json",
    ".nodulus/nodes/report.json",
    ".nodulus/contracts/text.v1.schema.json",
    ".nodulus/contracts/workflow-decision.v1.schema.json",
    "provider-fixture.mjs",
    "run.mjs",
  ].map((file) => "examples/feedback-routing/" + file);
  for (const file of expectedFiles) expect(archivedPaths, file).toContain(file);

  const project = path.join(scratch, "feedback example ü", "empty project");
  mkdirSync(project, { recursive: true });
  const exampleUrl = pathToFileURL(path.join(installedRoot, "examples", "feedback-routing", "run.mjs")).href;
  const example = await import(exampleUrl) as { runFeedbackExample(options: { projectRoot: string; text: string }): Promise<{ runId: string; status: string; trace: string[]; report: string }> };
  const result = await example.runFeedbackExample({ projectRoot: project, text: "  Cafe\u0301\n\n世界 👋  " });
  expect(result.status).toBe("success");
  expect(result.trace).toEqual(["prepare", "normalize", "review", "normalize", "review", "report"]);
  expect(result.report).toBe("Café 世界 👋");

  const runRoot = path.join(project, ".nodulus", "runs", result.runId);
  const checkpoint = JSON.parse(readFileSync(path.join(runRoot, "run.json"), "utf8"));
  const generations = checkpoint.feedbackRouting.regions.normalization.generationHistory.filter((entry: { nodeId: string }) => entry.nodeId === "normalize");
  expect(generations).toHaveLength(2);
  expect(generations.map((entry: { status: string }) => entry.status)).toEqual(["invalidated", "accepted"]);
  expect(generations.map((entry: { attemptPath: string }) => entry.attemptPath)).toEqual([
    "nodes/normalize/attempt-001/result.json",
    "nodes/normalize/attempt-002/result.json",
  ]);
  for (const generation of generations) {
    expect(existsSync(path.join(runRoot, "feedback", "normalization", "generations", generation.generationId + ".json"))).toBe(true);
  }
  const report = JSON.parse(readFileSync(path.join(runRoot, "nodes", "report", "attempt-001", "result.json"), "utf8"));
  expect(report.artifacts[0].data).toBe("Café 世界 👋");
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

function runInstalled(prefix: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  const shim = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "nodulus.cmd" : "nodulus");
  return crossSpawn.sync(shim, args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
}

function observePackageStage(
  timings: PackageStageTiming[],
  enabled: boolean,
  stage: PackageStage,
  run: () => SpawnSyncReturns<string>,
): SpawnSyncReturns<string> {
  if (!enabled) return run();
  const startMs = performance.now();
  try {
    const result = run();
    const endMs = performance.now();
    timings.push({ stage, startMs, endMs, durationMs: endMs - startMs, status: result.status });
    return result;
  } catch (error) {
    const endMs = performance.now();
    timings.push({ stage, startMs, endMs, durationMs: endMs - startMs, status: "threw" });
    throw error;
  }
}

function runOk(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
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

const parallelReviewArchivePaths = [
  "examples/parallel-review/README.md",
  "examples/parallel-review/.nodulus/settings.json",
  "examples/parallel-review/.nodulus/workflows/parallel-review.json",
  "examples/parallel-review/.nodulus/contracts/request.v1.schema.json",
  "examples/parallel-review/.nodulus/contracts/report.v1.schema.json",
  ...["prepare", "security", "quality", "join", "audit"].flatMap((node) => [
    `examples/parallel-review/.nodulus/nodes/${node}.json`,
    `examples/parallel-review/.nodulus/instructions/${node}.md`,
  ]),
  "examples/parallel-review/.nodulus/validators/report.mjs",
];

test("PKG-043 runs the installed parallel-review example with captured graph evidence", () => {
  const deadline = performance.now() + 15_000;
  expect(archivedPaths, "the package archive must contain the complete parallel-review example").toEqual(expect.arrayContaining(parallelReviewArchivePaths));

  const installedExample = path.join(installedPackageDirectory(installedPrefix), "examples", "parallel-review");
  return withOwnedInstalledProject("parallel-review café & %", deadline, (project) => {
    cpSync(installedExample, project, { recursive: true });
    const workflowPath = path.join(project, ".nodulus", "workflows", "parallel-review.json");
    const workflow = readJsonFile(workflowPath);
    expect(workflow).toMatchObject({
      schemaVersion: 2,
      id: "parallel-review",
      nodes: ["prepare", "security", "quality", "join", "audit"],
      execution: {
        kind: "dag",
        maxConcurrency: 3,
        dependsOn: { prepare: [], security: ["prepare"], quality: ["prepare"], join: ["security", "quality"], audit: ["prepare"] },
        resources: { prepare: [], security: [], quality: [], join: [], audit: [] },
      },
      outputs: [
        { name: "review", from: "join.report", contract: "report.v1" },
        { name: "audit", from: "audit.report", contract: "report.v1" },
      ],
    });
    expect(readJsonFile(path.join(project, ".nodulus", "nodes", "prepare.json")).inputs).toEqual({ brief: { from: "request", contract: "request.v1" } });
    expect(readJsonFile(path.join(project, ".nodulus", "nodes", "security.json")).inputs).toEqual({ brief: { from: "prepare.report", contract: "report.v1" } });
    expect(readJsonFile(path.join(project, ".nodulus", "nodes", "quality.json")).inputs).toEqual({ brief: { from: "prepare.report", contract: "report.v1" } });
    expect(readJsonFile(path.join(project, ".nodulus", "nodes", "join.json")).inputs).toEqual({
      security: { from: "security.report", contract: "report.v1" },
      quality: { from: "quality.report", contract: "report.v1" },
    });
    expect(readJsonFile(path.join(project, ".nodulus", "nodes", "audit.json")).inputs).toEqual({ brief: { from: "prepare.report", contract: "report.v1" } });

    const control = configureInstalledGraphProvider(project, "parallel-review", "parallel-review", "parallel-review-validator-invocations.jsonl");
    const cli = runInstalledWithinJourney(["run", "--project", project, "--workflow", "parallel-review", "--request", "Review the release brief", "--json"], project, deadline);
    expect(cli.status, `${String(cli.stdout)}\n${String(cli.stderr)}`).toBe(0);
    const envelope = parseCliEnvelope(cli.stdout);
    expect(envelope).toMatchObject({ schemaVersion: 1, status: "success", runId: expect.any(String) });
    const runId = requiredString(envelope.runId, "runId");
    const runResult = record(envelope.result, "run result");
    expect(runResult.artifacts).toEqual([
      { name: "review", contract: "report.v1", data: { text: "review=security:prepared:Review the release brief|quality:prepared:Review the release brief" } },
      { name: "audit", contract: "report.v1", data: { text: "audit=prepared:Review the release brief" } },
    ]);

    const calls = readJsonLines(control.callsPath);
    expect(calls.map(({ nodeId, attempt }) => `${String(nodeId)}/${String(attempt)}`).sort(comparePackageStrings)).toEqual([
      "audit/1", "join/1", "prepare/1", "quality/1", "security/1",
    ]);
    expect(calls).toHaveLength(5);
    expect(readdirSync(control.callsDirectory)).toHaveLength(5);
    expect(readdirSync(control.attemptsDirectory)).toHaveLength(5);
    expect(new Set(calls.map(({ callId }) => callId)).size).toBe(5);
    expect(calls.every((call) => call.runId === runId && call.completed === true)).toBe(true);
    const fixtureEvents = readJsonLines(control.eventsPath);
    const startedCallIds = fixtureEvents.filter(({ stage }) => stage === "inference-started").map(({ callId }) => requiredString(callId, "started fixture call id")).sort(comparePackageStrings);
    const completedCallIds = fixtureEvents.filter(({ stage }) => stage === "inference-completed").map(({ callId }) => requiredString(callId, "completed fixture call id")).sort(comparePackageStrings);
    expect(startedCallIds).toEqual(calls.map(({ callId }) => requiredString(callId, "captured call id")).sort(comparePackageStrings));
    expect(completedCallIds).toEqual(startedCallIds);
    expect(fixtureEvents.filter(({ stage }) => stage === "fixture-error")).toHaveLength(0);
    for (const call of calls) {
      const callId = requiredString(call.callId, "captured call id");
      const transport = readJsonFile(path.join(project, ".nodulus", "runs", runId, "calls", callId, "transport.json"));
      expect(transport).toMatchObject({ callId, started: true, exitCode: 0, timedOut: false, cancelled: false });
    }
    const join = calls.find(({ nodeId }) => nodeId === "join");
    expect(join).toBeDefined();
    expect(join?.mappedInputs).toEqual({
      security: { text: "security:prepared:Review the release brief" },
      quality: { text: "quality:prepared:Review the release brief" },
    });
    const joinCallId = requiredString(join?.callId, "join call id");
    const joinPrompt = readFileSync(path.join(project, ".nodulus", "runs", runId, "calls", joinCallId, "stdin.txt"), "utf8");
    expect(joinPrompt).toContain("security:prepared:Review the release brief");
    expect(joinPrompt).toContain("quality:prepared:Review the release brief");
    for (const nodeId of ["prepare", "security", "quality", "join", "audit"]) {
      const attempt = readJsonFile(path.join(project, ".nodulus", "runs", runId, "nodes", nodeId, "attempt-001", "validation.json"));
      expect(attempt).toEqual({ valid: true, outcome: "success", validators: [{ name: "report", valid: true, errors: [] }], errors: [] });
    }

    const runRoot = path.join(project, ".nodulus", "runs", runId);
    const acceptedCheckpoint = readJsonFile(path.join(runRoot, "run.json"));
    const acceptedGraph = record(acceptedCheckpoint.graph, "accepted graph checkpoint");
    const acceptedNodes = record(acceptedGraph.nodes, "accepted graph nodes");
    for (const nodeId of ["prepare", "security", "quality", "join", "audit"]) {
      const acceptedNode = record(acceptedNodes[nodeId], `${nodeId} checkpoint`);
      const accepted = record(acceptedNode.accepted, `${nodeId} accepted record`);
      const attempt = requiredNumber(accepted.attempt, `${nodeId} accepted attempt`);
      const expectedReferences = {
        resultRef: `nodes/${nodeId}/attempt-001/result.json`,
        validationRef: `nodes/${nodeId}/attempt-001/validation.json`,
        responseRef: `nodes/${nodeId}/attempt-001/response.raw.txt`,
      };
      expect(attempt).toBe(1);
      for (const referenceField of ["resultRef", "validationRef", "responseRef"] as const) {
        const hashField = referenceField.replace("Ref", "Sha256");
        const relative = requiredString(accepted[referenceField], `${nodeId} ${referenceField}`);
        expect(relative).toBe(expectedReferences[referenceField]);
        const expectedHash = requiredString(accepted[hashField], `${nodeId} ${hashField}`);
        expect(hashFile(path.join(runRoot, relative))).toBe(expectedHash);
      }
      const artifactPath = path.join(runRoot, "nodes", nodeId, "artifacts", "report.json");
      expect(records(accepted.artifacts, `${nodeId} accepted artifacts`)).toEqual([{
        name: "report",
        contract: "report.v1",
        ref: `nodes/${nodeId}/artifacts/report.json`,
        sha256: hashFile(artifactPath),
      }]);
      expect(acceptedNode).toMatchObject({ phase: "accepted", attempt });
    }
    const beforeReadOnlyCommands = snapshotOwnedTrees([project]);
    const status = runInstalledWithinJourney(["status", runId, "--project", project, "--json"], project, deadline);
    expect(status.status, String(status.stderr)).toBe(0);
    const statusEnvelope = parseCliEnvelope(status.stdout);
    expect(statusEnvelope).toMatchObject({ schemaVersion: 1, status: "success", runId });
    expect(record(statusEnvelope.result, "status result").status).toBe("success");
    expect(snapshotOwnedTrees([project])).toEqual(beforeReadOnlyCommands);

    const inspectWorkflow = runInstalledWithinJourney(["inspect", "workflow", "parallel-review", "--project", project, "--json"], project, deadline);
    expect(inspectWorkflow.status, String(inspectWorkflow.stderr)).toBe(0);
    expect(record(parseCliEnvelope(inspectWorkflow.stdout).result, "workflow inspection").workflow).toMatchObject({
      execution: { kind: "dag", maxConcurrency: 3 },
      outputs: [{ name: "review" }, { name: "audit" }],
    });
    expect(snapshotOwnedTrees([project])).toEqual(beforeReadOnlyCommands);

    const inspectRun = runInstalledWithinJourney(["inspect", "run", runId, "--project", project, "--json"], project, deadline);
    expect(inspectRun.status, String(inspectRun.stderr)).toBe(0);
    const inspection = record(parseCliEnvelope(inspectRun.stdout).result, "run inspection");
    expect(inspection.status).toBe("success");
    expect(inspection.artifacts).toEqual(["prepare", "security", "quality", "join", "audit"].map((nodeId) => ({
      nodeId,
      name: "report",
      reference: `nodes/${nodeId}/artifacts/report.json`,
      accepted: true,
    })));
    expect(snapshotOwnedTrees([project])).toEqual(beforeReadOnlyCommands);

    const exported = runInstalledWithinJourney(["inspect", "export", runId, "--project", project, "--json"], project, deadline);
    expect(exported.status, String(exported.stderr)).toBe(0);
    expect(record(parseCliEnvelope(exported.stdout).result, "run export")).toMatchObject({
      schemaVersion: 1,
      run: { runId, status: "success" },
      definitions: {
        workflow: {
          id: "parallel-review",
          nodes: ["prepare", "security", "quality", "join", "audit"],
          execution: {
            kind: "dag",
            maxConcurrency: 3,
            dependsOn: { prepare: [], security: ["prepare"], quality: ["prepare"], join: ["security", "quality"], audit: ["prepare"] },
            resources: { prepare: [], security: [], quality: [], join: [], audit: [] },
          },
          outputs: [{ name: "review", from: "join.report", contract: "report.v1" }, { name: "audit", from: "audit.report", contract: "report.v1" }],
        },
      },
    });
    expect(snapshotOwnedTrees([project])).toEqual(beforeReadOnlyCommands);

    const replay = runInstalledWithinJourney(["inspect", "replay", runId, "--project", project, "--json"], project, deadline);
    expect(replay.status, String(replay.stderr)).toBe(0);
    const replayResult = record(parseCliEnvelope(replay.stdout).result, "run replay");
    expect(replayResult).toMatchObject({ schemaVersion: 1, runId, mode: "schema-only", skipped: { providerCalls: true } });
    const replayCandidates = records(replayResult.candidates, "graph replay candidates");
    expect(record(replayResult.skipped, "graph replay skipped work")).toMatchObject({
      providerCalls: true,
      executableValidators: [".nodulus/validators/report.mjs"],
    });
    expect(replayCandidates).toHaveLength(5);
    expect(replayCandidates.map(({ nodeId, attempt, name, contract, valid, acceptanceStatus }) => ({ nodeId, attempt, name, contract, valid, acceptanceStatus })).sort((left, right) => comparePackageStrings(String(left.nodeId), String(right.nodeId)))).toEqual(
      ["prepare", "security", "quality", "join", "audit"].map((nodeId) => ({ nodeId, attempt: 1, name: "report", contract: "report.v1", valid: true, acceptanceStatus: "accepted" })).sort((left, right) => comparePackageStrings(left.nodeId, right.nodeId)),
    );
    expect(snapshotOwnedTrees([project])).toEqual(beforeReadOnlyCommands);
    expect(readFileSync(path.join(runRoot, "inputs.json"), "utf8")).toContain("Review the release brief");
    expect(performance.now()).toBeLessThan(deadline);
  });
}, 15_000);

test("PKG-044 installed graph resume preserves two root questions and joins answered roots", () => {
  const deadline = performance.now() + 15_000;
  return withOwnedInstalledProject("parallel-questions café & %", deadline, (project) => {
    mkdirSync(project);
    const init = runInstalledWithinJourney(["init", "--project", project], project, deadline);
    expect(init.status, `${String(init.stdout)}\n${String(init.stderr)}`).toBe(0);
    const control = configureQuestionGraph(project);
    const firstRun = runInstalledWithinJourney(["run", "--project", project, "--workflow", "parallel-questions", "--request", "Answer both review questions", "--json"], project, deadline);
    expect(firstRun.status, String(firstRun.stderr)).toBe(2);
    const paused = parseCliEnvelope(firstRun.stdout);
    expect(paused).toMatchObject({ schemaVersion: 1, status: "needs_input", runId: expect.any(String) });
    const runId = requiredString(paused.runId, "runId");
    const pausedResult = record(paused.result, "paused run result");
    const initialRequests = records(pausedResult.requests, "initial requests");
    expect(initialRequests.map(({ nodeId }) => nodeId)).toEqual(["alpha", "beta"]);
    expect(pausedResult.request).toEqual(initialRequests[0]);
    const alphaId = requiredString(initialRequests[0]!.id, "alpha request id");
    const betaId = requiredString(initialRequests[1]!.id, "beta request id");

    const initialCalls = readJsonLines(control.callsPath);
    const initialCallMarkers = readdirSync(control.callsDirectory).sort(comparePackageStrings);
    const initialAttemptMarkers = readdirSync(control.attemptsDirectory).sort(comparePackageStrings);
    expect(initialCalls.map(({ nodeId, attempt }) => `${String(nodeId)}/${String(attempt)}`).sort(comparePackageStrings)).toEqual(["alpha/1", "beta/1"]);
    expect(initialCallMarkers).toHaveLength(2);
    expect(initialAttemptMarkers).toHaveLength(2);
    expect(initialCalls.every((call) => call.runId === runId && call.completed === true)).toBe(true);
    const initialFixtureEvents = readJsonLines(control.eventsPath);
    const initialStartedIds = initialFixtureEvents.filter(({ stage }) => stage === "inference-started").map(({ callId }) => requiredString(callId, "initial fixture call id")).sort(comparePackageStrings);
    expect(initialFixtureEvents.filter(({ stage }) => stage === "fixture-error")).toHaveLength(0);
    for (const call of initialCalls) {
      const callId = requiredString(call.callId, "initial call id");
      expect(readJsonFile(path.join(project, ".nodulus", "runs", runId, "calls", callId, "transport.json"))).toMatchObject({
        callId, started: true, exitCode: 0, timedOut: false, cancelled: false,
      });
    }
    const runRoot = path.join(project, ".nodulus", "runs", runId);
    const capturedInputs = readFileSync(path.join(runRoot, "inputs.json"));
    const beforePartial = snapshotOwnedTrees([project]);
    const status = runInstalledWithinJourney(["status", runId, "--project", project, "--json"], project, deadline);
    expect(status.status, String(status.stderr)).toBe(0);
    const initialStatus = record(parseCliEnvelope(status.stdout).result, "initial graph status");
    expect(records(initialStatus.pendingRequests, "initial pending requests").map(({ id }) => id)).toEqual([alphaId, betaId]);
    expect(record(initialStatus.pendingRequest, "first pending request alias")).toMatchObject({ id: alphaId, nodeId: "alpha" });
    expect(snapshotOwnedTrees([project])).toEqual(beforePartial);

    const alphaAnswersPath = writeAnswersFile(project, "alpha-answers.json", { alphaApproval: true });
    const partial = runInstalledWithinJourney([
      "resume", runId, "--request-id", alphaId, "--answers-file", alphaAnswersPath, "--project", project, "--json",
    ], project, deadline);
    expect(partial.status, String(partial.stderr)).toBe(2);
    const partialEnvelope = parseCliEnvelope(partial.stdout);
    expect(partialEnvelope).toMatchObject({ schemaVersion: 1, status: "needs_input", runId });
    const partialResult = record(partialEnvelope.result, "partial resume result");
    expect(records(partialResult.requests, "remaining requests").map(({ id, nodeId }) => [id, nodeId])).toEqual([[betaId, "beta"]]);
    expect(partialResult.request).toEqual(records(partialResult.requests, "remaining request alias")[0]);
    expect(readJsonLines(control.callsPath)).toEqual(initialCalls);
    expect(readdirSync(control.callsDirectory).sort(comparePackageStrings)).toEqual(initialCallMarkers);
    expect(readdirSync(control.attemptsDirectory).sort(comparePackageStrings)).toEqual(initialAttemptMarkers);
    expect(readJsonLines(control.eventsPath).filter(({ stage }) => stage === "inference-started").map(({ callId }) => requiredString(callId, "partial fixture call id")).sort(comparePackageStrings)).toEqual(initialStartedIds);
    expect(readFileSync(control.validatorsPath, "utf8")).toBe("");
    const answerPath = path.join(project, ".nodulus", "runs", runId, "answers", `${alphaId}.json`);
    expect(readJsonFile(answerPath)).toEqual({ alphaApproval: true });
    const runEventsPath = path.join(runRoot, "events.jsonl");
    expect(readJsonLines(runEventsPath).filter(({ event, requestId }) => event === "request.answered" && requestId === alphaId)).toHaveLength(1);
    expect(readJsonLines(runEventsPath).filter(({ event }) => event === "run.resumed")).toHaveLength(0);
    const afterPartial = snapshotOwnedTrees([project]);
    const partialStatus = runInstalledWithinJourney(["status", runId, "--project", project, "--json"], project, deadline);
    expect(partialStatus.status, String(partialStatus.stderr)).toBe(0);
    const partialStatusResult = record(parseCliEnvelope(partialStatus.stdout).result, "partial graph status");
    expect(records(partialStatusResult.pendingRequests, "partial pending requests").map(({ id }) => id)).toEqual([betaId]);
    expect(record(partialStatusResult.pendingRequest, "remaining pending request alias")).toMatchObject({ id: betaId, nodeId: "beta" });
    expect(snapshotOwnedTrees([project])).toEqual(afterPartial);

    const betaAnswersPath = writeAnswersFile(project, "beta-answers.json", { betaApproval: true });
    const finalResume = runInstalledWithinJourney([
      "resume", runId, "--request-id", betaId, "--answers-file", betaAnswersPath, "--project", project, "--json",
    ], project, deadline);
    expect(finalResume.status, String(finalResume.stderr)).toBe(0);
    const finalEnvelope = parseCliEnvelope(finalResume.stdout);
    expect(finalEnvelope).toMatchObject({ schemaVersion: 1, status: "success", runId });
    expect(record(finalEnvelope.result, "final graph result").artifacts).toEqual([
      { name: "alphaFinal", contract: "report.v1", data: { text: "alpha:approved" } },
      { name: "betaFinal", contract: "report.v1", data: { text: "beta:approved" } },
      { name: "joined", contract: "report.v1", data: { text: "join=alpha:approved|beta:approved" } },
    ]);

    const finalCalls = readJsonLines(control.callsPath);
    expect(finalCalls.map(({ nodeId, attempt }) => `${String(nodeId)}/${String(attempt)}`).sort(comparePackageStrings)).toEqual([
      "alpha/1", "alpha/2", "beta/1", "beta/2", "join/1",
    ]);
    expect(finalCalls).toHaveLength(5);
    expect(readdirSync(control.callsDirectory)).toHaveLength(5);
    expect(readdirSync(control.attemptsDirectory)).toHaveLength(5);
    expect(finalCalls.every((call) => call.runId === runId && call.completed === true)).toBe(true);
    const finalFixtureEvents = readJsonLines(control.eventsPath);
    const finalStartedIds = finalFixtureEvents.filter(({ stage }) => stage === "inference-started").map(({ callId }) => requiredString(callId, "final fixture call id")).sort(comparePackageStrings);
    const finalCompletedIds = finalFixtureEvents.filter(({ stage }) => stage === "inference-completed").map(({ callId }) => requiredString(callId, "finished fixture call id")).sort(comparePackageStrings);
    expect(finalStartedIds).toEqual(finalCalls.map(({ callId }) => requiredString(callId, "completed call id")).sort(comparePackageStrings));
    expect(finalCompletedIds).toEqual(finalStartedIds);
    expect(finalFixtureEvents.filter(({ stage }) => stage === "fixture-error")).toHaveLength(0);
    const alphaFinal = finalCalls.find(({ nodeId, attempt }) => nodeId === "alpha" && attempt === 2);
    const betaFinal = finalCalls.find(({ nodeId, attempt }) => nodeId === "beta" && attempt === 2);
    expect(alphaFinal?.promptAnswers).toEqual({ alphaApproval: true });
    expect(betaFinal?.promptAnswers).toEqual({ betaApproval: true });
    expect(finalCalls.slice(0, initialCalls.length)).toEqual(initialCalls);
    const alphaInitial = initialCalls.find(({ nodeId }) => nodeId === "alpha");
    const betaInitial = initialCalls.find(({ nodeId }) => nodeId === "beta");
    expect(alphaInitial).toBeDefined();
    expect(betaInitial).toBeDefined();
    for (const call of finalCalls) {
      const callId = requiredString(call.callId, "final call id");
      const savedRequest = readJsonFile(path.join(project, ".nodulus", "runs", runId, "calls", callId, "request.json"));
      expect(savedRequest).toMatchObject({ runId, callId, nodeId: call.nodeId, attempt: call.attempt });
      expect(readJsonFile(path.join(project, ".nodulus", "runs", runId, "calls", callId, "transport.json"))).toMatchObject({
        callId, started: true, exitCode: 0, timedOut: false, cancelled: false,
      });
    }
    expect(readJsonFile(path.join(project, ".nodulus", "runs", runId, "calls", requiredString(alphaFinal?.callId, "alpha continuation call id"), "request.json")).parentCallId).toBe(alphaInitial?.callId);
    expect(readJsonFile(path.join(project, ".nodulus", "runs", runId, "calls", requiredString(betaFinal?.callId, "beta continuation call id"), "request.json")).parentCallId).toBe(betaInitial?.callId);
    expect(readJsonFile(path.join(project, ".nodulus", "runs", runId, "answers", `${alphaId}.json`))).toEqual({ alphaApproval: true });
    expect(readJsonFile(path.join(project, ".nodulus", "runs", runId, "answers", `${betaId}.json`))).toEqual({ betaApproval: true });
    const events = readJsonLines(runEventsPath);
    expect(events.filter(({ event, requestId }) => event === "run.resumed" && requestId === betaId)).toHaveLength(1);
    expect(events.filter(({ event }) => event === "run.resumed")).toHaveLength(1);
    expect(events.filter(({ event }) => event === "request.answered").map(({ requestId }) => requestId)).toEqual([alphaId, betaId]);
    const validatorCalls = readJsonLines(control.validatorsPath);
    expect(validatorCalls.map(({ nodeId }) => requiredString(nodeId, "validated node id")).sort(comparePackageStrings)).toEqual(["alpha", "beta", "join"]);
    expect(validatorCalls).toHaveLength(3);
    expect(validatorCalls.every(({ pid, data, valid }) => typeof pid === "number" && pid > 0 && valid === true && record(data, "validator input").text !== undefined)).toBe(true);
    expect(validatorCalls.map(({ nodeId, data }) => [nodeId, record(data, "validated data").text]).sort((left, right) => comparePackageStrings(String(left[0]), String(right[0])))).toEqual([
      ["alpha", "alpha:approved"], ["beta", "beta:approved"], ["join", "join=alpha:approved|beta:approved"],
    ]);
    const beforeFinalStatus = snapshotOwnedTrees([project]);
    const finalStatus = runInstalledWithinJourney(["status", runId, "--project", project, "--json"], project, deadline);
    expect(finalStatus.status, String(finalStatus.stderr)).toBe(0);
    const finalStatusResult = record(parseCliEnvelope(finalStatus.stdout).result, "final graph status");
    expect(finalStatusResult.status).toBe("success");
    expect(records(finalStatusResult.pendingRequests, "final pending requests")).toEqual([]);
    expect(snapshotOwnedTrees([project])).toEqual(beforeFinalStatus);
    const finalCheckpoint = readJsonFile(path.join(runRoot, "run.json"));
    const graph = record(finalCheckpoint.graph, "final graph checkpoint");
    const nodes = record(graph.nodes, "final graph nodes");
    for (const nodeId of ["alpha", "beta", "join"]) expect(nodes[nodeId]).toMatchObject({ phase: "accepted", attempt: nodeId === "join" ? 1 : 2 });
    expect(finalCheckpoint.status).toBe("success");
    expect([...(finalCheckpoint.completedNodes as string[])].sort(comparePackageStrings)).toEqual(["alpha", "beta", "join"]);
    expect(readFileSync(path.join(runRoot, "inputs.json"))).toEqual(capturedInputs);
    expect(performance.now()).toBeLessThan(deadline);
  });
}, 15_000);

type JsonRecord = Record<string, unknown>;
type InstalledCallRecord = JsonRecord & { nodeId: unknown; attempt: unknown };

function withOwnedInstalledProject<T>(label: string, deadline: number, run: (project: string) => T): T {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), `nodulus-${label}-`));
  const project = path.join(temporaryRoot, "project");
  try {
    const result = run(project);
    if (performance.now() >= deadline) throw new Error("Installed graph journey exceeded its whole-journey budget before cleanup registration.");
    successfulInstalledJourneyRoots.push(temporaryRoot);
    return result;
  } catch (error) {
    process.stderr.write(`PAR043 retained owned root after failure: ${temporaryRoot}; project: ${project}\n`);
    throw error;
  }
}

type InstalledJourneyResult = { status: number | null; stdout: string; stderr: string };

function runInstalledWithinJourney(args: string[], cwd: string, deadline: number): InstalledJourneyResult {
  const remainingMs = deadline - performance.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error(`Installed graph journey exceeded its aggregate budget before '${args[0]}'.`);
  const timeout = Math.max(1, Math.min(30_000, Math.floor(remainingMs)));
  const startedAt = performance.now();
  const shim = path.join(installedPrefix, "node_modules", ".bin", process.platform === "win32" ? "nodulus.cmd" : "nodulus");
  const result = crossSpawn.sync(shim, args, { cwd, encoding: "utf8", timeout, windowsHide: true });
  if (performance.now() - startedAt > remainingMs) throw new Error(`Installed graph journey command '${args[0]}' completed outside its aggregate budget.`);
  if (result.status === null) throw new Error(`Installed graph journey command '${args[0]}' timed out within its remaining aggregate budget: ${String(result.stderr).slice(0, 500)}`);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

type InstalledGraphMode = "parallel-review" | "questions";
type InstalledGraphFixture = { callsPath: string; validatorsPath: string; eventsPath: string; callsDirectory: string; attemptsDirectory: string };

function configureInstalledGraphProvider(project: string, prefix: string, mode: InstalledGraphMode, validatorLogName = `${prefix}-validators.jsonl`): InstalledGraphFixture {
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(fixtureDirectory, { recursive: true });
  const callsDirectory = path.join(fixtureDirectory, `${prefix}-calls`);
  const attemptsDirectory = path.join(fixtureDirectory, `${prefix}-attempts`);
  mkdirSync(callsDirectory);
  mkdirSync(attemptsDirectory);
  const callsPath = path.join(fixtureDirectory, `${prefix}-calls.jsonl`);
  const validatorsPath = path.join(fixtureDirectory, validatorLogName);
  const eventsPath = path.join(fixtureDirectory, `${prefix}-events.jsonl`);
  const controlPath = path.join(fixtureDirectory, "par-043-control.json");
  writeFileSync(callsPath, "", { encoding: "utf8", flag: "wx" });
  writeFileSync(validatorsPath, "", { encoding: "utf8", flag: "wx" });
  writeFileSync(eventsPath, "", { encoding: "utf8", flag: "wx" });
  const fixtureScript = path.join(fixtureDirectory, "par-043-installed-graph-provider.mjs");
  const fixtureSource = fileURLToPath(new URL("../fixtures/par-043-installed-graph-provider.mjs", import.meta.url));
  cpSync(fixtureSource, fixtureScript);
  const executable = path.join(fixtureDirectory, process.platform === "win32" ? "par-043-installed-graph-provider.cmd" : "par-043-installed-graph-provider.sh");
  if (process.platform === "win32") {
    writeFileSync(executable, `@echo off\r\n"${process.execPath}" ".nodulus\\fixtures\\par-043-installed-graph-provider.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  } else {
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixtureScript)} "$@"\n`, "utf8");
    chmodSync(executable, 0o755);
  }

  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = readJsonFile(settingsPath);
  const profiles = record(settings.providerProfiles, "provider profiles");
  if (Object.keys(profiles).length === 0) {
    profiles.fixture = { kind: "codex", enabled: true, model: "installed-graph-fixture", timeoutMs: 5000, capabilities: [] };
  }
  for (const [name, profileValue] of Object.entries(profiles)) {
    const profile = record(profileValue, `provider profile ${name}`);
    if (profile.kind !== "codex") throw new Error(`Installed graph fixture expected Codex profile '${name}'.`);
    profile.executable = executable;
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  writeFileSync(controlPath, `${JSON.stringify({
    mode,
    callsPath: path.relative(project, callsPath),
    validatorsPath: path.relative(project, validatorsPath),
    eventsPath: path.relative(project, eventsPath),
    callsDirectory: path.relative(project, callsDirectory),
    attemptsDirectory: path.relative(project, attemptsDirectory),
  })}\n`, "utf8");
  return { callsPath, validatorsPath, eventsPath, callsDirectory, attemptsDirectory };
}

function configureQuestionGraph(project: string): InstalledGraphFixture {
  const fixture = configureInstalledGraphProvider(project, "questions", "questions");
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = readJsonFile(settingsPath);
  settings.defaultWorkflow = "parallel-questions";
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const root = path.join(project, ".nodulus");
  mkdirSync(path.join(root, "workflows"), { recursive: true });
  mkdirSync(path.join(root, "contracts"), { recursive: true });
  mkdirSync(path.join(root, "nodes"), { recursive: true });
  mkdirSync(path.join(root, "instructions"), { recursive: true });
  mkdirSync(path.join(root, "validators"), { recursive: true });
  writeFileSync(path.join(root, "contracts", "report.v1.schema.json"), JSON.stringify({
    type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false,
  }), "utf8");
  writeFileSync(path.join(root, "workflows", "parallel-questions.json"), `${JSON.stringify({
    schemaVersion: 2,
    id: "parallel-questions",
    nodes: ["alpha", "beta", "join"],
    execution: { kind: "dag", maxConcurrency: 2, dependsOn: { alpha: [], beta: [], join: ["alpha", "beta"] }, resources: { alpha: [], beta: [], join: [] } },
    outputs: [
      { name: "alphaFinal", from: "alpha.report", contract: "report.v1" },
      { name: "betaFinal", from: "beta.report", contract: "report.v1" },
      { name: "joined", from: "join.report", contract: "report.v1" },
    ],
  }, null, 2)}\n`, "utf8");
  for (const nodeId of ["alpha", "beta", "join"]) {
    const inputs = nodeId === "join"
      ? { alpha: { from: "alpha.report", contract: "report.v1" }, beta: { from: "beta.report", contract: "report.v1" } }
      : { request: { from: "request", contract: "request.v1" } };
    writeFileSync(path.join(root, "nodes", `${nodeId}.json`), `${JSON.stringify({
      schemaVersion: 1,
      id: nodeId,
      providerProfile: "fixture",
      instructions: [`.nodulus/instructions/${nodeId}.md`],
      inputs,
      expectedOutputs: [{ name: "report", contract: "report.v1", validator: `.nodulus/validators/par-043-${nodeId}-validator.mjs` }],
    }, null, 2)}\n`, "utf8");
    writeFileSync(path.join(root, "instructions", `${nodeId}.md`), `Produce the ${nodeId} report for the installed graph scenario.\n`, "utf8");
    writeFileSync(path.join(root, "validators", `par-043-${nodeId}-validator.mjs`), [
      "import { appendFileSync } from 'node:fs';",
      `const nodeId = ${JSON.stringify(nodeId)};`,
      `const logPath = ${JSON.stringify(fixture.validatorsPath)};`,
      "let raw = ''; for await (const chunk of process.stdin) raw += chunk;",
      "const data = JSON.parse(raw);",
      "const valid = typeof data?.text === 'string' && data.text.length > 0;",
      "appendFileSync(logPath, JSON.stringify({ nodeId, pid: process.pid, data, valid }) + '\\n', 'utf8');",
      "process.stdout.write(JSON.stringify({ valid, errors: valid ? [] : ['report data text is missing'] }));",
    ].join("\n"), "utf8");
  }
  return fixture;
}

function writeAnswersFile(project: string, name: string, answers: Record<string, unknown>): string {
  const file = path.join(project, name);
  writeFileSync(file, `${JSON.stringify(answers)}\n`, "utf8");
  return file;
}

function parseCliEnvelope(text: string): JsonRecord {
  const value: unknown = JSON.parse(text);
  const envelope = record(value, "CLI envelope");
  expect(envelope.schemaVersion).toBe(1);
  return envelope;
}

function record(value: unknown, description: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} is not a JSON object.`);
  return value as JsonRecord;
}

function records(value: unknown, description: string): JsonRecord[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) {
    throw new Error(`${description} is not a JSON object array.`);
  }
  return value as JsonRecord[];
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${description} is not a nonempty string.`);
  return value;
}

function requiredNumber(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${description} is not a safe integer.`);
  return value;
}

function hashFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJsonFile(file: string): JsonRecord {
  return record(JSON.parse(readFileSync(file, "utf8")), path.relative(process.cwd(), file));
}

function readJsonLines(file: string): InstalledCallRecord[] {
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => record(JSON.parse(line), "fixture event") as InstalledCallRecord);
}

function snapshotOwnedTrees(roots: string[]): string {
  const entries: Array<{ path: string; kind: "directory" | "file"; size: number; sha256: string | null }> = [];
  let totalBytes = 0;
  const visit = (root: string, current: string, rootIndex: number): void => {
    if (entries.length >= 2048) throw new Error("Read-only CLI snapshot exceeded its entry bound before inspecting the next entry.");
    const names = current === root ? ["."] : [path.relative(root, current).replaceAll(path.sep, "/")];
    const stat = requireLstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Read-only snapshot refused a symbolic link: ${current}`);
    const name = names[0]!;
    if (stat.isDirectory()) {
      entries.push({ path: `root-${rootIndex}/${name}`, kind: "directory", size: 0, sha256: null });
      for (const child of readdirSync(current).sort(comparePackageStrings)) visit(root, path.join(current, child), rootIndex);
      return;
    }
    if (!stat.isFile()) throw new Error(`Read-only snapshot found an unsupported entry: ${current}`);
    if (stat.size > 8 * 1024 * 1024 - totalBytes) throw new Error("Read-only CLI snapshot exceeded its byte bound.");
    const bytes = readFileSync(current);
    if (bytes.byteLength !== stat.size) throw new Error(`Read-only snapshot observed a changing file: ${current}`);
    totalBytes += bytes.byteLength;
    entries.push({ path: `root-${rootIndex}/${name}`, kind: "file", size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  };
  for (const [rootIndex, root] of roots.entries()) visit(root, root, rootIndex);
  return JSON.stringify(entries.sort((left, right) => comparePackageStrings(left.path, right.path)));
}

function requireLstat(file: string): Stats {
  return lstatSync(file);
}

function comparePackageStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject } from "../../src/core/initialize-project.js";
import { LocalProjectFiles } from "../../src/adapters/storage/local-project-files.js";
import { runCli } from "../../src/cli.js";

export type FixtureProviderKind = "codex" | "cursor";

export async function createProviderScenario(kind: FixtureProviderKind, mode = "success"): Promise<{ project: string; logPath: string; probePath: string }> {
  const project = mkdtempSync(path.join(tmpdir(), `Nodulus ${kind} & % ü `));
  await initializeProject(new LocalProjectFiles(project));
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(fixtureDirectory, { recursive: true });
  const scriptPath = path.join(fixtureDirectory, `${kind}-fixture.mjs`);
  const logPath = path.join(fixtureDirectory, "provider-invocations.jsonl");
  const probePath = path.join(fixtureDirectory, "provider-probes.jsonl");
  const controlPath = path.join(fixtureDirectory, "provider-control.json");
  writeFileSync(controlPath, JSON.stringify({ mode }), "utf8");
  writeFileSync(scriptPath, providerFixtureSource(kind, logPath, probePath, controlPath), "utf8");
  const executable = writeWrapper(project, kind, scriptPath);

  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles.fixture = {
    kind,
    enabled: true,
    executable,
    model: "fixture-model",
    timeoutMs: 5000,
    capabilities: [],
    credentials: { token: "fixture-secret-must-not-be-captured" },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  node.providerProfile = "fixture";
  node.inputs = { request: { from: "request", contract: "request.v1" } };
  writeFileSync(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");
  return { project, logPath, probePath };
}

export async function runDefaultProviderCli(project: string, request: string): Promise<{ code: number; stdout: string; stderr: string; envelope: any }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    ["node", "nodulus", "run", "--project", project, "--request", request, "--json"],
    { writeOut: (text) => { stdout += text; }, writeErr: (text) => { stderr += text; } },
    { cwd: project },
  );
  return { code, stdout, stderr, envelope: JSON.parse(stdout) };
}

export async function resumeDefaultProviderCli(project: string, runId: string, requestId: string, answersPath: string): Promise<{ code: number; stdout: string; stderr: string; envelope: any }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    ["node", "nodulus", "resume", runId, "--request-id", requestId, "--answers-file", answersPath, "--project", project, "--json"],
    { writeOut: (text) => { stdout += text; }, writeErr: (text) => { stderr += text; } },
    { cwd: project },
  );
  return { code, stdout, stderr, envelope: JSON.parse(stdout) };
}

export function readProviderCalls(logPath: string): any[] {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

export function cleanupProviderProject(project: string): void {
  rmSync(project, { recursive: true, force: true });
}

function writeWrapper(project: string, kind: FixtureProviderKind, scriptPath: string): string {
  if (process.platform === "win32") {
    const wrapper = path.join(project, ".nodulus", "fixtures", `${kind} fixture & % ü.cmd`);
    // The runner sets cwd to the project. Keep the batch script's own literal
    // free of the temporary directory's shell-sensitive characters.
    const relativeScript = path.relative(project, scriptPath);
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${relativeScript}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = path.join(project, ".nodulus", "fixtures", `${kind} fixture & % ü.sh`);
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${scriptPath}' "$@"\n`, "utf8");
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function providerFixtureSource(kind: FixtureProviderKind, logPath: string, probePath: string, controlPath: string): string {
  return [
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    `const kind = ${JSON.stringify(kind)};`,
    `const logPath = ${JSON.stringify(logPath)};`,
    `const probePath = ${JSON.stringify(probePath)};`,
    `const controlPath = ${JSON.stringify(controlPath)};`,
    "const mode = JSON.parse(readFileSync(controlPath, 'utf8')).mode;",
    "const readFlag = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };",
    "let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;",
    "const logProbe = () => appendFileSync(probePath, JSON.stringify({ kind, argv: args, cwd: process.cwd() }) + '\\n');",
    "if (args[0] === '--version') { logProbe(); process.stdout.write(mode === 'unsupported-version' ? (kind === 'codex' ? 'codex-cli 0.0.1' : 'Cursor fixture version unavailable') : (kind === 'codex' ? 'codex-cli 0.144.4' : 'agent fixture version 1.0.0')); process.exit(0); }",
    "if (kind === 'codex' && args[0] === 'login' && args[1] === 'status') { logProbe(); if (mode === 'auth-failure') { process.stderr.write('fixture reports login required'); process.exit(1); } process.stdout.write('Logged in'); process.exit(0); }",
    "if (kind === 'cursor' && args[0] === 'status' && args.includes('--format') && readFlag('--format') === 'json') { logProbe(); if (mode === 'auth-failure') { process.stderr.write('fixture status check failed'); process.exit(1); } process.stdout.write('{}'); process.exit(0); }",
    "let promptFile;",
    "if (kind === 'cursor') { const prompt = readFlag('-p') ?? ''; const prefix = 'Read the complete captured prompt at '; if (prompt.startsWith(prefix)) { promptFile = prompt.slice(prefix.length); } }",
    "const promptContents = promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '';",
    "const callCount = (() => { try { return readFileSync(logPath, 'utf8').split('\\n').filter(Boolean).length; } catch { return 0; } })();",
    "const response = mode === 'invalid-response' ? 'not JSON' : mode === 'pause-then-success' && callCount === 0 ? JSON.stringify({ status: 'needs_input', request: { id: 'fixture-question', questions: [{ id: 'confirmed', message: 'Confirm?' }], answerContract: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'], additionalProperties: false } } }) : JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: mode === 'split-unicode-response' ? 'split Ω 🦊 response' : 'fixture result' } }] });",
    "appendFileSync(logPath, JSON.stringify({ kind, argv: args, cwd: process.cwd(), stdin, promptFile, promptContents }) + '\\n');",
    "if (kind === 'codex') { const output = readFlag('--output-last-message'); if (output) writeFileSync(output, response, 'utf8'); process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n'); }",
    "else { const transport = Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: response }), 'utf8'); if (mode === 'split-unicode-response') { for (const byte of transport) { process.stdout.write(Buffer.from([byte])); await new Promise(resolve => setTimeout(resolve, 1)); } } else process.stdout.write(transport); }",
    "",
  ].join("\n");
}

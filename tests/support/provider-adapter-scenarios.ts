import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeProject } from "../../src/core/initialize-project.js";
import { LocalProjectFiles } from "../../src/adapters/storage/local-project-files.js";
import { runCli } from "../../src/cli.js";

export type FixtureProviderKind = "codex" | "cursor" | "opencode";

export async function createProviderScenario(kind: FixtureProviderKind, mode = "success"): Promise<{ project: string; logPath: string; probePath: string; invocationPath: string }> {
  const project = mkdtempSync(path.join(tmpdir(), `Nodulus ${kind} & % ü `));
  await initializeProject(new LocalProjectFiles(project));
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(fixtureDirectory, { recursive: true });
  const scriptPath = path.join(fixtureDirectory, `${kind}-fixture.mjs`);
  const logPath = path.join(fixtureDirectory, "provider-invocations.jsonl");
  const probePath = path.join(fixtureDirectory, "provider-probes.jsonl");
  const invocationPath = path.join(fixtureDirectory, "provider-invocation-order.jsonl");
  const controlPath = path.join(fixtureDirectory, "provider-control.json");
  writeFileSync(controlPath, JSON.stringify({ mode }), "utf8");
  writeFileSync(scriptPath, providerFixtureSource(kind, logPath, probePath, invocationPath, controlPath), "utf8");
  const executable = writeWrapper(project, kind, scriptPath);

  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles.fixture = {
    kind,
    enabled: true,
    executable,
    model: kind === "opencode" ? "ollama/qwen3.5:9b" : "fixture-model",
    timeoutMs: 5000,
    capabilities: mode.startsWith("repair-") ? ["responseRepair"] : [],
    credentials: { token: "fixture-secret-must-not-be-captured" },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  node.providerProfile = "fixture";
  node.inputs = { request: { from: "request", contract: "request.v1" } };
  writeFileSync(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");
  return { project, logPath, probePath, invocationPath };
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

function providerFixtureSource(kind: FixtureProviderKind, logPath: string, probePath: string, invocationPath: string, controlPath: string): string {
  return [
    "import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    `const kind = ${JSON.stringify(kind)};`,
    `const logPath = ${JSON.stringify(logPath)};`,
    `const probePath = ${JSON.stringify(probePath)};`,
    `const invocationPath = ${JSON.stringify(invocationPath)};`,
    `const controlPath = ${JSON.stringify(controlPath)};`,
    "const mode = JSON.parse(readFileSync(controlPath, 'utf8')).mode;",
    "const readFlag = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };",
    "let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;",
    "const strictEnvelope = mode.startsWith('strict-envelope-');",
    "const strictMode = strictEnvelope ? mode.slice('strict-envelope-'.length) : mode;",
    "const logInvocation = (type) => appendFileSync(invocationPath, JSON.stringify({ type, argv: args, cwd: process.cwd() }) + '\\n');",
    "const logProbe = () => { appendFileSync(probePath, JSON.stringify({ kind, argv: args, cwd: process.cwd() }) + '\\n'); logInvocation('probe'); };",
    "if (args[0] === '--version') { logProbe(); process.stdout.write(mode === 'unrecognized-version' ? 'opencode fixture version unavailable' : mode === 'unsupported-version' ? (kind === 'codex' ? 'codex-cli 0.0.1' : kind === 'opencode' ? 'opencode 0.0.1' : 'Cursor fixture version unavailable') : (kind === 'codex' ? 'codex-cli 0.144.4' : kind === 'opencode' ? 'opencode 1.18.32' : 'agent fixture version 1.0.0')); process.exit(0); }",
    "if (kind === 'opencode' && args[0] === 'models') { logProbe(); if (args.includes('--format')) { process.stderr.write('unknown option --format'); process.exit(2); } if (JSON.stringify(args) !== JSON.stringify(['models', 'ollama'])) { process.stderr.write('fixture requires opencode models ollama'); process.exit(64); } if (mode === 'model-unavailable') { process.stdout.write('ollama/qwen3.5:9b-extended\\nollama/other:latest\\n'); process.exit(0); } process.stdout.write('ollama/qwen3.5:9b-extended\\nollama/qwen3.5:9b\\nollama/other:latest\\n'); process.exit(0); }",
    "if (kind === 'codex' && args[0] === 'login' && args[1] === 'status') { logProbe(); if (mode === 'auth-failure') { process.stderr.write('fixture reports login required'); process.exit(1); } process.stdout.write('Logged in'); process.exit(0); }",
    "if (kind === 'cursor' && args[0] === 'status' && args.includes('--format') && readFlag('--format') === 'json') { logProbe(); if (mode === 'auth-failure') { process.stderr.write('fixture status check failed'); process.exit(1); } process.stdout.write('{}'); process.exit(0); }",
    "let promptFile;",
    "if (kind === 'cursor') { const prompt = readFlag('-p') ?? ''; const prefix = 'Read the complete captured prompt at '; if (prompt.startsWith(prefix)) { promptFile = prompt.slice(prefix.length); } }",
    "const promptContents = promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '';",
    "const callCount = (() => { try { return readFileSync(logPath, 'utf8').split('\\n').filter(Boolean).length; } catch { return 0; } })();",
    "const repairMode = mode.startsWith('repair-');",
    "const isOpenCodeRepair = kind === 'opencode' && readFlag('--agent') === 'nodulus-response';",
    "const rawResponse = strictMode === 'invalid' ? JSON.stringify({ response: 42 }) : mode === 'invalid-outcome' ? JSON.stringify({ status: 'success', artifacts: [] }) : repairMode ? JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: 'fixture result' } }] }).slice(0, -1) : strictMode === 'malformed' || strictMode === 'invalid-response' || mode === 'invalid-response' ? 'not JSON' : strictMode === 'error' ? JSON.stringify({ status: 'error', error: { code: 'FIXTURE_ERROR', message: 'Fixture requested an error outcome.' } }) : (strictMode === 'pause-then-success' || mode === 'pause-then-success') && callCount === 0 ? JSON.stringify({ status: 'needs_input', request: { id: 'fixture-question', questions: [{ id: 'confirmed', message: 'Confirm?' }], answerContract: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'], additionalProperties: false } } }) : JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: mode === 'split-unicode-response' ? 'split Ω 🦊 response' : 'fixture result' } }] });",
    "let schemaValid = !strictEnvelope; if (kind === 'codex' && strictEnvelope) { try { const schema = JSON.parse(readFileSync(readFlag('--output-schema'), 'utf8')); schemaValid = schema.type === 'object' && schema.additionalProperties === false && Object.keys(schema.properties ?? {}).length === 1 && schema.properties.response?.type === 'string' && JSON.stringify(schema.required) === JSON.stringify(['response']); } catch { schemaValid = false; } }",
    "const response = kind === 'codex' ? strictMode === 'invalid' ? JSON.stringify({ response: 42 }) : JSON.stringify({ response: rawResponse }) : rawResponse;",
    "if (kind === 'opencode') { const probes = (() => { try { return readFileSync(probePath, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line).argv); } catch { return []; } })(); if (JSON.stringify(probes) !== JSON.stringify([['--version'], ['models', 'ollama']])) { process.stderr.write('fixture requires successful version and exact model discovery before OpenCode inference'); process.exit(64); } }",
    "appendFileSync(logPath, JSON.stringify({ kind, argv: args, cwd: process.cwd(), stdin, promptFile, promptContents, ...(strictEnvelope ? { schemaValid } : {}) }) + '\\n'); logInvocation('run');",
    "if (kind === 'codex' && strictEnvelope && strictMode !== 'invalid' && !schemaValid) { process.stderr.write('fixture requires strict response-string output schema'); process.exit(65); }",
    "if (kind === 'opencode') { const emit = (type, part) => process.stdout.write(JSON.stringify({ type, part }) + '\\n'); if (isOpenCodeRepair) { const repairDirectory = readFlag('--dir'); const expected = ['run', '--format', 'json', '--thinking', '--model', 'ollama/qwen3.5:9b', '--agent', 'nodulus-response', '--session', 'fixture-response-only-session', '--dir', repairDirectory]; if (!repairDirectory || realpathSync(repairDirectory) !== realpathSync(process.cwd())) { process.stderr.write('fixture requires the repair directory to resolve to the project cwd'); process.exit(67); } if (!repairMode || JSON.stringify(args) !== JSON.stringify(expected)) { process.stderr.write('fixture rejects repair without the response-only agent and captured session'); process.exit(66); } if (mode === 'repair-process-failure') { process.stdout.write('fixture response-only repair stdout'); process.stderr.write('fixture response-only repair stderr'); process.exit(24); } const earlierRepairMessageID = 'fixture-repair-earlier-tool'; const finalMessageID = `fixture-repair-final-${callCount}`; const repaired = JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: mode === 'repair-multiple' ? 'fixture second repair result' : 'fixture repaired result' } }] }); const repairResponse = mode === 'repair-multiple' && callCount === 1 ? repaired.slice(0, -1) : repaired; emit('step_start', { messageID: earlierRepairMessageID }); emit('reasoning', { messageID: earlierRepairMessageID, text: JSON.stringify({ status: 'error', error: { code: 'EARLIER_REPAIR_REASONING', message: 'Ignore this earlier repair reasoning.' } }) }); emit('text', { messageID: earlierRepairMessageID, text: JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: 'earlier repair text distractor' } }] }) }); emit('step_finish', { messageID: earlierRepairMessageID, reason: 'tool-calls' }); emit('step_start', { messageID: finalMessageID, sessionID: 'fixture-response-only-session' }); emit('reasoning', { messageID: finalMessageID, text: JSON.stringify({ status: 'error', error: { code: 'REPAIR_REASONING', message: 'Do not select this when text exists.' } }) }); emit('text', { messageID: finalMessageID, text: repairResponse }); emit('step_finish', { messageID: finalMessageID, reason: 'stop' }); process.exit(0); } if (mode === 'timeout') { process.stdout.write('fixture OpenCode timeout stdout'); process.stderr.write('fixture OpenCode timeout stderr'); await new Promise(resolve => setTimeout(resolve, 3000)); } if (mode === 'nonzero-exit') { process.stderr.write('fixture OpenCode failure'); process.exit(23); } if (mode === 'output-limit') { await new Promise(resolve => process.stdout.write('x'.repeat(3 * 1024 * 1024), resolve)); process.exit(0); } if (mode === 'malformed-event') { process.stdout.write('{not JSON}\\n'); process.exit(0); } const earlierMessageID = 'fixture-earlier-tool'; const finalMessageID = 'fixture-final-assistant'; const earlierText = JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: 'earlier text distractor' } }] }); const finalReasoning = JSON.stringify({ status: 'success', artifacts: [{ name: 'example', contract: 'example.v1', data: { message: 'final reasoning distractor' } }] }); emit('step_start', { messageID: earlierMessageID }); emit('reasoning', { messageID: earlierMessageID, text: JSON.stringify({ status: 'error', error: { code: 'EARLIER_REASONING', message: 'Ignore this earlier reasoning.' } }) }); emit('text', { messageID: earlierMessageID, text: earlierText }); emit('tool', { messageID: earlierMessageID, tool: 'write' }); emit('step_finish', { messageID: earlierMessageID, reason: 'tool-calls' }); emit('step_start', { messageID: finalMessageID, ...(mode === 'repair-missing-session' ? {} : repairMode ? { sessionID: 'fixture-response-only-session' } : {}) }); if (mode === 'reasoning-only') { emit('reasoning', { messageID: finalMessageID, text: rawResponse }); } else if (mode !== 'missing-text') { emit('reasoning', { messageID: finalMessageID, text: finalReasoning }); const midpoint = Math.ceil(rawResponse.length / 2); emit('text', { messageID: finalMessageID, text: rawResponse.slice(0, midpoint) }); emit('text', { messageID: finalMessageID, text: rawResponse.slice(midpoint) }); } emit('step_finish', { messageID: finalMessageID, reason: 'stop' }); }",
    "else if (kind === 'codex') { const output = readFlag('--output-last-message'); if (output) writeFileSync(output, response, 'utf8'); process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n'); }",
    "else { const transport = Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: response }), 'utf8'); if (mode === 'split-unicode-response') { for (const byte of transport) { process.stdout.write(Buffer.from([byte])); await new Promise(resolve => setTimeout(resolve, 1)); } } else process.stdout.write(transport); }",
    "",
  ].join("\n");
}

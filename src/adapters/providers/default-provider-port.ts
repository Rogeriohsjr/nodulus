import type { ProviderTelemetry } from "../../core/ports/provider-telemetry.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderInvocation, ProviderPort } from "../../core/ports/provider.js";
import { NodulusError } from "../../core/shared/nodulus-error.js";
import { runProcess } from "./process-runner.js";
import { runCapturedProcess } from "./captured-process.js";

type Capture = typeof runCapturedProcess;

type Kind = "codex" | "cursor" | "opencode" | "claude";
const invocationTimeout = 10 * 60 * 1000;
const outcomeSchema = {
  type: "object",
  properties: { response: { type: "string" } },
  required: ["response"],
  additionalProperties: false,
};
const openCodeTransportSuffix = "OpenCode transport instruction: Return exactly one complete Nodulus system outcome JSON object as your final assistant response. Do not return an artifact data value alone or write the outcome to a file. A success outcome has this shape: {\"status\":\"success\",\"artifacts\":[{\"name\":\"node-supplied name\",\"contract\":\"node-supplied contract\",\"data\":{}}]}. The node prompt supplies the actual expected names and contracts.";
const claudeTransportSuffix = "Claude Code transport instruction: The JSON schema requires an outer object with exactly one string property named response. Set response to the complete serialized Nodulus system outcome JSON object. Do not return the Nodulus outcome as the outer object, return artifact data alone, or write the outcome to a file. A success outcome has this shape: {\"status\":\"success\",\"artifacts\":[{\"name\":\"node-supplied name\",\"contract\":\"node-supplied contract\",\"data\":{}}]}. The node prompt supplies the actual expected names and contracts.";

export function createDefaultProviderPort(projectRoot: string): ProviderPort {
  const openCodeRepairSessions = new Map<string, { sessionID: string; count: number }>();
  const telemetryByCall = new Map<string, ProviderTelemetry>();
  const launchByCall = new Map<string, boolean | null>();
  const versions = new Map<string, string>();
  let lastTelemetry: ProviderTelemetry | null = null;
  const captureWithVersion = (version: string | null): Capture => async (executable, args, options, invocation, operation) => {
    assertInvocationActive(invocation);
    if (invocation.call) launchByCall.set(invocation.call.callId, null);
    const result = await runCapturedProcess(executable, args, { ...options, deadlineAtMs: invocation.deadlineAtMs }, invocation, operation, version);
    launchByCall.set(result.callId, result.started);
    lastTelemetry = result.telemetry;
    telemetryByCall.set(result.callId, result.telemetry);
    return result;
  };
  return {
    async invoke(invocation) {
      lastTelemetry = null;
      if (invocation.call) launchByCall.set(invocation.call.callId, false);
      const profile = invocation.providerProfile;
      const kind = requireKind(profile);
      try {
        assertInvocationActive(invocation);
        if (profile.enabled !== true) throw new NodulusError("PROVIDER_DISABLED", `Captured ${kind} provider profile is disabled.`);
        const executable = typeof profile.executable === "string" ? profile.executable : "";
        const timeout = boundedTimeout(profile.timeoutMs);
        const readinessTimeout = kind === "opencode" ? invocationTimeout : timeout;
        const version = await checkVersion(kind, executable, projectRoot, readinessTimeout, invocation.signal);
        assertInvocationActive(invocation);
        versions.set(repairSessionKey(invocation), version);
        const capture = captureWithVersion(version);
        await checkReadiness(kind, executable, profile, projectRoot, readinessTimeout, invocation.signal);
        assertInvocationActive(invocation);
        let response: string;
        if (kind === "claude") response = await invokeClaude(executable, projectRoot, invocation, timeout, capture);
        else if (kind === "codex") response = await invokeCodex(executable, projectRoot, invocation, timeout, capture);
        else if (kind === "cursor") response = await invokeCursor(executable, projectRoot, invocation, timeout, capture);
        else response = await invokeOpenCode(executable, projectRoot, invocation, timeout, openCodeRepairSessions, capture);
        assertInvocationActive(invocation);
        return response;
      } catch (error) {
        if (invocation.signal?.aborted || (invocation.deadlineAtMs !== undefined && Date.now() >= invocation.deadlineAtMs)) {
          const error = new NodulusError("FEEDBACK_LIMIT_EXCEEDED", "Feedback routing elapsed-time limit was reached.");
          throw error;
        }
        if ((kind === "opencode" || kind === "claude") && error instanceof NodulusError) return providerError(error);
        throw error;
      }
    },
    async repairResponse(invocation, previousRawResponse, validationErrors) {
      lastTelemetry = null;
      if (invocation.call) launchByCall.set(invocation.call.callId, false);
      assertInvocationActive(invocation);
      const kind = requireKind(invocation.providerProfile);
      if (kind !== "opencode") {
        throw new NodulusError("RESPONSE_REPAIR_UNAVAILABLE", "Safe response-only repair is unavailable for this provider; the full provider action will not be replayed.");
      }
      const executable = typeof invocation.providerProfile.executable === "string" ? invocation.providerProfile.executable : "";
      const timeout = boundedTimeout(invocation.providerProfile.timeoutMs);
      try {
        const response = await repairOpenCodeResponse(executable, projectRoot, invocation, previousRawResponse, validationErrors, timeout, openCodeRepairSessions, captureWithVersion(versions.get(repairSessionKey(invocation)) ?? null));
        assertInvocationActive(invocation);
        return response;
      } catch (error) {
        if (!isProviderActive(invocation.signal, invocation.deadlineAtMs)) {
          throw new NodulusError("FEEDBACK_LIMIT_EXCEEDED", "Feedback routing elapsed-time limit was reached.");
        }
        throw error;
      }
    },
    async isAvailable(profile, options) {
      if (profile.enabled !== true || typeof profile.executable !== "string" || !profile.executable) return false;
      const kind = requireKind(profile);
      try {
        if (!isProviderActive(options?.signal, options?.deadlineAtMs)) return false;
        const timeout = boundedTimeout(profile.timeoutMs);
        const readinessTimeout = kind === "opencode" ? invocationTimeout : timeout;
        await checkVersion(kind, profile.executable, projectRoot, readinessTimeout, options?.signal);
        if (!isProviderActive(options?.signal, options?.deadlineAtMs)) return false;
        await checkReadiness(kind, profile.executable, profile, projectRoot, readinessTimeout, options?.signal);
        return isProviderActive(options?.signal, options?.deadlineAtMs);
      } catch { return false; }
    },
    telemetryForCall: callId => telemetryByCall.get(callId) ?? null,
    launchForCall: callId => launchByCall.get(callId) ?? null,
    usageForLastCall: () => lastTelemetry ? {
      inputTokens: lastTelemetry.normalized.inputTokens,
      outputTokens: lastTelemetry.normalized.outputTokens,
      cacheReadTokens: lastTelemetry.coverage === "complete" ? lastTelemetry.reported.cacheReadTokens : null,
      costUsd: lastTelemetry.coverage === "complete" ? lastTelemetry.reported.costUsd : null,
    } : null,
  };
}

function assertInvocationActive(invocation: ProviderInvocation): void {
  if (!isProviderActive(invocation.signal, invocation.deadlineAtMs)) {
    throw new NodulusError("FEEDBACK_LIMIT_EXCEEDED", "Feedback routing elapsed-time limit was reached.");
  }
}

function isProviderActive(signal?: AbortSignal, deadlineAtMs?: number): boolean {
  return !signal?.aborted && (deadlineAtMs === undefined || Date.now() < deadlineAtMs);
}

function requireKind(profile: Record<string, unknown>): Kind {
  if (profile.kind === "codex" || profile.kind === "cursor" || profile.kind === "opencode" || profile.kind === "claude") return profile.kind;
  throw new NodulusError("PROVIDER_KIND_REQUIRED", "The default provider adapter requires an explicit provider kind: 'codex', 'cursor', 'opencode', or 'claude'.");
}

async function checkVersion(kind: Kind, executable: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  let result;
  try { result = await runProcess(executable, ["--version"], { cwd, timeoutMs, ...(signal ? { signal } : {}) }); }
  catch (error) { throw new NodulusError("PROVIDER_EXECUTABLE_UNAVAILABLE", `${kind} executable could not be started: ${messageOf(error)}`); }
  if (result.timedOut || result.exitCode !== 0) throw new NodulusError("PROVIDER_VERSION_UNAVAILABLE", `${kind} version probe failed${detail(result.stderr)}.`);
  const match = `${result.stdout}\n${result.stderr}`.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?/);
  if (!match) throw new NodulusError("PROVIDER_VERSION_UNRECOGNIZED", `${kind} version is unavailable or unrecognized; install a documented compatible CLI version.`);
  if (kind === "codex" && compareVersion(match.slice(1).map(Number), [0, 144, 4]) < 0) {
    throw new NodulusError("PROVIDER_VERSION_UNSUPPORTED", `Codex CLI version ${match[0].trim()} is unsupported; the verified minimum is 0.144.4.`);
  }
  if (kind === "opencode" && compareVersion(match.slice(1).map(Number), [1, 18, 32]) < 0) {
    throw new NodulusError("PROVIDER_VERSION_UNSUPPORTED", `OpenCode CLI version ${match[0].trim()} is unsupported; the verified minimum is 1.18.32.`);
  }
  if (kind === "claude" && compareVersion(match.slice(1).map(Number), [2, 1, 294]) < 0) {
    throw new NodulusError("PROVIDER_VERSION_UNSUPPORTED", `Claude Code version ${match[0].trim()} is unsupported; the verified minimum is 2.1.294.`);
  }
  return match[0].trim();
}

function compareVersion(actual: number[], required: number[]): number {
  for (let i = 0; i < 3; i++) if (actual[i] !== required[i]) return actual[i]! - required[i]!;
  return 0;
}

async function checkReadiness(kind: Kind, executable: string, profile: Record<string, unknown>, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (kind === "opencode") return checkOpenCodeModel(executable, profile, cwd, timeoutMs, signal);
  if (kind === "claude") return checkClaudeReadiness(executable, cwd, timeoutMs, signal);
  const args = kind === "codex" ? ["login", "status"] : ["status", "--format", "json"];
  let result;
  try { result = await runProcess(executable, args, { cwd, timeoutMs: Math.min(timeoutMs, 30_000), ...(signal ? { signal } : {}) }); }
  catch (error) { throw new NodulusError("PROVIDER_AUTH_UNAVAILABLE", `${kind} authentication status could not be checked: ${messageOf(error)}`); }
  if (result.timedOut || result.exitCode !== 0) {
    throw new NodulusError("PROVIDER_AUTH_REQUIRED", `${kind} authentication check failed${detail(result.stderr)}. Sign in using the provider's documented CLI command.`);
  }
  if (kind === "cursor") {
    let status: unknown;
    try { status = JSON.parse(result.stdout) as unknown; }
    catch (error) { throw new NodulusError("PROVIDER_AUTH_UNAVAILABLE", `cursor authentication status returned malformed JSON: ${messageOf(error)}${detail(result.stderr)}.`); }
    if (!isRecord(status) || typeof status.isAuthenticated !== "boolean") {
      throw new NodulusError("PROVIDER_AUTH_UNAVAILABLE", "cursor authentication status did not include the expected isAuthenticated boolean.");
    }
    if (!status.isAuthenticated) {
      throw new NodulusError("PROVIDER_AUTH_REQUIRED", "cursor authentication is required. Sign in using the provider's documented CLI command.");
    }
  }
}

async function checkClaudeReadiness(executable: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  let result;
  try { result = await runProcess(executable, ["auth", "status"], { cwd, timeoutMs: Math.min(timeoutMs, 30_000), ...(signal ? { signal } : {}) }); }
  catch (error) { throw new NodulusError("PROVIDER_AUTH_UNAVAILABLE", `claude authentication status could not be checked: ${messageOf(error)}`); }
  if (result.timedOut || result.exitCode !== 0) {
    throw new NodulusError("PROVIDER_AUTH_REQUIRED", `claude authentication check failed${detail(result.stderr)}. Sign in using the provider's documented CLI command.`);
  }
  let status: unknown;
  try { status = JSON.parse(result.stdout) as unknown; }
  catch (error) { throw new NodulusError("PROVIDER_AUTH_UNAVAILABLE", `claude authentication status returned malformed JSON: ${messageOf(error)}${detail(result.stderr)}.`); }
  if (!isRecord(status) || typeof status.loggedIn !== "boolean") {
    throw new NodulusError("PROVIDER_AUTH_UNAVAILABLE", "claude authentication status did not include the expected loggedIn boolean.");
  }
  if (!status.loggedIn) throw new NodulusError("PROVIDER_AUTH_REQUIRED", "claude authentication is required. Sign in using the provider's documented CLI command.");
}

async function checkOpenCodeModel(executable: string, profile: Record<string, unknown>, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (typeof profile.model !== "string" || profile.model.trim() === "") {
    throw new NodulusError("CONFIGURATION_INVALID", "OpenCode provider profiles require a non-empty model.");
  }
  let result;
  try { result = await runProcess(executable, ["models", "ollama"], { cwd, timeoutMs: Math.min(timeoutMs, 30_000), ...(signal ? { signal } : {}) }); }
  catch (error) { throw new NodulusError("PROVIDER_MODEL_UNAVAILABLE", `OpenCode model discovery could not be started: ${messageOf(error)}`); }
  if (result.timedOut || result.exitCode !== 0) {
    throw new NodulusError("PROVIDER_MODEL_UNAVAILABLE", `OpenCode model discovery failed${detail(result.stderr)}.`);
  }
  if (!result.stdout.split(/\r?\n/).some((model) => model === profile.model)) {
    throw new NodulusError("PROVIDER_MODEL_UNAVAILABLE", `OpenCode model '${profile.model}' is unavailable.`);
  }
}

async function invokeCodex(executable: string, cwd: string, invocation: ProviderInvocation, timeoutMs: number, capture: Capture): Promise<string> {
  const directory = await attemptDirectory(cwd, invocation);
  const outputPath = path.join(directory, "last-message.txt");
  const schemaPath = path.join(directory, "outcome.schema.json");
  await writeFile(schemaPath, `${JSON.stringify(outcomeSchema, null, 2)}\n`, "utf8");
  const sandbox = invocation.providerProfile.sandbox ?? "read-only";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new NodulusError("CONFIGURATION_INVALID", "Captured Codex sandbox must be 'read-only' or 'workspace-write'.");
  }
  const args = ["exec", "--json", "--ephemeral", "--cd", cwd, "--sandbox", sandbox, "-c", "approval_policy=never", "--output-last-message", outputPath, "--output-schema", schemaPath];
  if (typeof invocation.providerProfile.model === "string") args.push("--model", invocation.providerProfile.model);
  const reasoningEffort = invocation.providerProfile.reasoningEffort;
  if (reasoningEffort !== undefined) {
    if (!isCodexReasoningEffort(reasoningEffort)) {
      throw new NodulusError("CONFIGURATION_INVALID", "Captured Codex reasoningEffort must be one of: minimal, low, medium, high, xhigh.");
    }
    args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }
  args.push("-");
  const transportPrompt = `${invocation.prompt}\n\nCodex transport envelope: return exactly one JSON object with a string property named response. Its string value must be the exact Nodulus outcome JSON text.`;
  const result = await capture(executable, args, { cwd, stdin: transportPrompt, timeoutMs, ...(invocation.signal ? { signal: invocation.signal } : {}) }, invocation);
  if (result.timedOut) {
    await saveTransport(directory, "codex", result);
    throw new NodulusError("PROVIDER_TIMEOUT", "Codex CLI exceeded its configured invocation timeout.");
  }
  if (result.outputLimitExceeded) {
    await saveTransport(directory, "codex", result);
    throw new NodulusError("PROVIDER_OUTPUT_LIMIT", "Codex CLI exceeded the 2 MiB transport output limit.");
  }
  if (result.exitCode !== 0) {
    await saveTransport(directory, "codex", result);
    throw new NodulusError("PROVIDER_PROCESS_FAILED", `Codex CLI exited with code ${result.exitCode}${detail(result.stderr)}.`);
  }
  let lastMessage: string;
  try { lastMessage = await readFile(outputPath, "utf8"); }
  catch (error) {
    await saveTransport(directory, "codex", result);
    throw new NodulusError("PROVIDER_RESPONSE_MISSING", `Codex CLI did not write its final message: ${messageOf(error)}${detail(result.stderr)}.`);
  }
  await saveTransport(directory, "codex", result, lastMessage);
  let envelope: unknown;
  try { envelope = JSON.parse(lastMessage) as unknown; }
  catch (error) { throw new NodulusError("PROVIDER_TRANSPORT_INVALID", `Codex CLI returned malformed response-envelope JSON: ${messageOf(error)}.`); }
  if (!isRecord(envelope) || typeof envelope.response !== "string" || Object.keys(envelope).some((key) => key !== "response")) {
    throw new NodulusError("PROVIDER_TRANSPORT_INVALID", "Codex CLI response envelope must contain exactly one string property named 'response'.");
  }
  return envelope.response;
}

async function invokeCursor(executable: string, cwd: string, invocation: ProviderInvocation, timeoutMs: number, capture: Capture): Promise<string> {
  const directory = await attemptDirectory(cwd, invocation);
  const args = ["-p", "--output-format", "stream-json", "--trust", "--workspace", cwd];
  if (typeof invocation.providerProfile.model === "string") args.push("--model", invocation.providerProfile.model);
  const result = await capture(executable, args, { cwd, stdin: invocation.prompt, timeoutMs, ...(invocation.signal ? { signal: invocation.signal } : {}) }, invocation);
  await saveTransport(directory, "cursor", result);
  if (result.timedOut) throw new NodulusError("PROVIDER_TIMEOUT", "Cursor CLI exceeded its configured invocation timeout.");
  if (result.outputLimitExceeded) throw new NodulusError("PROVIDER_OUTPUT_LIMIT", "Cursor CLI exceeded the 2 MiB transport output limit.");
  if (result.exitCode !== 0) throw new NodulusError("PROVIDER_PROCESS_FAILED", `Cursor CLI exited with code ${result.exitCode}${detail(result.stderr)}.`);
  return parseCursorStreamOutcome(result.stdout, result.stderr);
}

async function invokeClaude(executable: string, cwd: string, invocation: ProviderInvocation, timeoutMs: number, capture: Capture): Promise<string> {
  const directory = await attemptDirectory(cwd, invocation);
  const profile = invocation.providerProfile;
  if (profile.maxTurns !== undefined && (typeof profile.maxTurns !== "number" || !Number.isInteger(profile.maxTurns) || profile.maxTurns <= 0)) {
    throw new NodulusError("CONFIGURATION_INVALID", "Claude maxTurns must be a positive integer.");
  }
  if (profile.maxBudgetUsd !== undefined && (typeof profile.maxBudgetUsd !== "number" || !Number.isFinite(profile.maxBudgetUsd) || profile.maxBudgetUsd <= 0)) {
    throw new NodulusError("CONFIGURATION_INVALID", "Claude maxBudgetUsd must be a positive finite number.");
  }
  if (profile.tools !== undefined && typeof profile.tools !== "string") throw new NodulusError("CONFIGURATION_INVALID", "Claude tools must be a string.");
  if (profile.safeMode !== undefined && typeof profile.safeMode !== "boolean") throw new NodulusError("CONFIGURATION_INVALID", "Claude safeMode must be a boolean.");

  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(outcomeSchema), "--no-session-persistence"];
  if (typeof profile.model === "string") args.push("--model", profile.model);
  if (typeof profile.maxTurns === "number") args.push("--max-turns", String(profile.maxTurns));
  if (typeof profile.maxBudgetUsd === "number") args.push("--max-budget-usd", String(profile.maxBudgetUsd));
  if (typeof profile.tools === "string") {
    args.push("--tools", profile.tools);
    if (profile.tools === "") args.push("--mcp-config", JSON.stringify({ mcpServers: {} }), "--strict-mcp-config");
  }
  if (profile.safeMode === true) args.push("--safe-mode");
  const transportPrompt = `${invocation.prompt}\n\n${claudeTransportSuffix}`;
  const result = await capture(executable, args, { cwd, stdin: transportPrompt, timeoutMs, ...(invocation.signal ? { signal: invocation.signal } : {}) }, invocation);
  await saveTransport(directory, "claude", result);
  if (result.timedOut) throw new NodulusError("PROVIDER_TIMEOUT", "Claude Code CLI exceeded its configured invocation timeout.");
  if (result.outputLimitExceeded) throw new NodulusError("PROVIDER_OUTPUT_LIMIT", "Claude Code CLI exceeded the 2 MiB transport output limit.");
  if (result.exitCode !== 0) throw new NodulusError("PROVIDER_PROCESS_FAILED", `Claude Code CLI exited with code ${result.exitCode}${detail(result.stderr)}.`);
  let envelope: unknown;
  try { envelope = JSON.parse(result.stdout) as unknown; }
  catch (error) { throw new NodulusError("PROVIDER_TRANSPORT_INVALID", `Claude Code CLI returned malformed JSON: ${messageOf(error)}${detail(result.stderr)}.`); }
  if (!isRecord(envelope) || envelope.type !== "result" || envelope.subtype !== "success" || envelope.is_error !== false) {
    const subtype = isRecord(envelope) && typeof envelope.subtype === "string" ? envelope.subtype : "unknown";
    const errors = isRecord(envelope) && Array.isArray(envelope.errors) ? envelope.errors.filter((item): item is string => typeof item === "string").join("; ") : "";
    throw new NodulusError("PROVIDER_PROCESS_FAILED", `Claude Code CLI reported ${subtype}${errors ? `: ${errors}` : ""}${detail(result.stderr)}.`);
  }
  if (!isRecord(envelope.structured_output)) throw new NodulusError("PROVIDER_RESPONSE_MISSING", `Claude Code CLI did not return structured_output${detail(result.stderr)}.`);
  if (Object.keys(envelope.structured_output).length !== 1 || typeof envelope.structured_output.response !== "string") {
    throw new NodulusError("PROVIDER_TRANSPORT_INVALID", "Claude Code structured_output did not match the requested response-string schema.");
  }
  return envelope.structured_output.response;
}

function parseCursorStreamOutcome(stdout: string, stderr: string): string {
  const events: unknown[] = [];
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try { events.push(JSON.parse(line) as unknown); }
    catch (error) { throw new NodulusError("PROVIDER_TRANSPORT_INVALID", `Cursor CLI returned malformed NDJSON on line ${index + 1}: ${messageOf(error)}${detail(stderr)}.`); }
  }
  const terminal = events.at(-1);
  if (!isRecord(terminal) || terminal.type !== "result") {
    throw new NodulusError("PROVIDER_TRANSPORT_INVALID", `Cursor CLI stream is missing its terminal result event${detail(stderr)}.`);
  }
  if (events.slice(0, -1).some((event) => isRecord(event) && event.type === "result")) {
    throw new NodulusError("PROVIDER_TRANSPORT_INVALID", `Cursor CLI stream contains a result event before its terminal event${detail(stderr)}.`);
  }
  if (terminal.subtype !== "success" || terminal.is_error !== false || typeof terminal.result !== "string") {
    throw new NodulusError("PROVIDER_TRANSPORT_INVALID", `Cursor CLI terminal result did not report success${detail(stderr)}.`);
  }

  let finalAssistantText: string | undefined;
  for (const event of events) {
    if (!isRecord(event) || event.type !== "assistant") continue;
    if (!isRecord(event.message) || event.message.role !== "assistant" || !Array.isArray(event.message.content)) {
      throw new NodulusError("PROVIDER_TRANSPORT_INVALID", "Cursor CLI returned a malformed assistant event.");
    }
    const textBlocks: string[] = [];
    for (const block of event.message.content) {
      if (!isRecord(block) || block.type !== "text") continue;
      if (typeof block.text !== "string") throw new NodulusError("PROVIDER_TRANSPORT_INVALID", "Cursor CLI returned a malformed assistant text block.");
      textBlocks.push(block.text);
    }
    finalAssistantText = textBlocks.join("");
  }
  if (finalAssistantText === undefined) throw new NodulusError("PROVIDER_TRANSPORT_INVALID", "Cursor CLI stream contains no complete assistant message.");
  return finalAssistantText;
}

async function invokeOpenCode(executable: string, cwd: string, invocation: ProviderInvocation, timeoutMs: number, repairSessions: Map<string, { sessionID: string; count: number }>, capture: Capture): Promise<string> {
  const directory = await attemptDirectory(cwd, invocation);
  const model = invocation.providerProfile.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new NodulusError("CONFIGURATION_INVALID", "Captured OpenCode provider profile requires a non-empty model.");
  }
  const args = ["run", "--format", "json", "--thinking", "--model", model, "--agent", "build", "--dir", cwd];
  const transportPrompt = `${invocation.prompt}\n\n${openCodeTransportSuffix}`;
  const result = await capture(executable, args, { cwd, stdin: transportPrompt, timeoutMs, ...(invocation.signal ? { signal: invocation.signal } : {}) }, invocation);
  await saveTransport(directory, "opencode", result);
  if (result.timedOut) throw new NodulusError("PROVIDER_TIMEOUT", "OpenCode CLI exceeded its configured invocation timeout.");
  if (result.outputLimitExceeded) throw new NodulusError("PROVIDER_OUTPUT_LIMIT", "OpenCode CLI exceeded the 2 MiB transport output limit.");
  if (result.exitCode !== 0) throw new NodulusError("PROVIDER_PROCESS_FAILED", `OpenCode CLI exited with code ${result.exitCode}${detail(result.stderr)}.`);
  const parsed = parseOpenCodeResponse(result.stdout);
  if (parsed.sessionID !== undefined) repairSessions.set(repairSessionKey(invocation), { sessionID: parsed.sessionID, count: 0 });
  return parsed.response;
}

async function repairOpenCodeResponse(
  executable: string,
  cwd: string,
  invocation: ProviderInvocation,
  previousRawResponse: string,
  validationErrors: string[],
  timeoutMs: number,
  repairSessions: Map<string, { sessionID: string; count: number }>,
  capture: Capture,
): Promise<string> {
  const model = invocation.providerProfile.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new NodulusError("CONFIGURATION_INVALID", "Captured OpenCode provider profile requires a non-empty model.");
  }
  const session = repairSessions.get(repairSessionKey(invocation));
  if (session === undefined) {
    throw new NodulusError("RESPONSE_REPAIR_SESSION_MISSING", "OpenCode did not provide a session ID for safe response-only repair; the writing action will not be replayed.");
  }
  session.count += 1;
  const initialDirectory = await attemptDirectory(cwd, invocation);
  const directory = path.join(initialDirectory, `repair-${String(session.count).padStart(3, "0")}`);
  await mkdir(directory, { recursive: true });
  const args = ["run", "--format", "json", "--thinking", "--model", model, "--agent", "nodulus-response", "--session", session.sessionID, "--dir", cwd];
  const prompt = `Your previous final Nodulus response was rejected with INVALID_NODE_RESPONSE. Return only a corrected complete Nodulus system outcome JSON object. Do not run tools or perform actions. Do not write the outcome to a file. Preserve the node-supplied artifact name, contract, and data. A structurally complete success response has this exact shape: {"status":"success","artifacts":[{"name":"node-supplied name","contract":"node-supplied contract","data":{}}]}. Check that both the data object and its containing artifact object close before the artifacts array.\n\nPrevious response:\n${previousRawResponse}\n\nValidation errors:\n${validationErrors.join("\n")}`;
  let result;
  try { result = await capture(executable, args, { cwd, stdin: prompt, timeoutMs, ...(invocation.signal ? { signal: invocation.signal } : {}) }, invocation, "repair_response"); }
  catch (error) { throw new NodulusError("RESPONSE_REPAIR_FAILED", `OpenCode response-only repair could not be started: ${messageOf(error)}`); }
  await saveTransport(directory, "opencode", result);
  if (result.timedOut) throw new NodulusError("RESPONSE_REPAIR_FAILED", "OpenCode response-only repair exceeded its configured invocation timeout.");
  if (result.outputLimitExceeded) throw new NodulusError("RESPONSE_REPAIR_FAILED", "OpenCode response-only repair exceeded the 2 MiB transport output limit.");
  if (result.exitCode !== 0) throw new NodulusError("RESPONSE_REPAIR_FAILED", `OpenCode response-only repair failed with code ${result.exitCode}${detail(result.stderr)}.`);
  try { return parseOpenCodeResponse(result.stdout).response; }
  catch (error) {
    if (error instanceof NodulusError) throw new NodulusError("RESPONSE_REPAIR_FAILED", `OpenCode response-only repair failed: ${error.message}`);
    throw error;
  }
}

function parseOpenCodeResponse(stdout: string): { response: string; sessionID: string | undefined } {
  const contentByMessageID = new Map<string, { text: string[]; reasoning: string[]; sessionID?: string }>();
  let finalStoppedMessageID: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    let event: unknown;
    try { event = JSON.parse(line) as unknown; }
    catch (error) { throw new NodulusError("PROVIDER_TRANSPORT_INVALID", `OpenCode CLI returned malformed NDJSON: ${messageOf(error)}.`); }
    if (!isRecord(event) || !isRecord(event.part)) continue;
    const messageID = event.part.messageID;
    if (typeof messageID === "string" && typeof event.part.sessionID === "string") {
      const content = contentByMessageID.get(messageID) ?? { text: [], reasoning: [] };
      content.sessionID = event.part.sessionID;
      contentByMessageID.set(messageID, content);
    }
    if (event.type === "step_finish" && event.part.reason === "stop" && typeof messageID === "string") {
      finalStoppedMessageID = messageID;
      continue;
    }
    if ((event.type !== "text" && event.type !== "reasoning") || typeof messageID !== "string" || typeof event.part.text !== "string") continue;
    const content = contentByMessageID.get(messageID) ?? { text: [], reasoning: [] };
    content[event.type].push(event.part.text);
    contentByMessageID.set(messageID, content);
  }
  const content = finalStoppedMessageID === undefined ? undefined : contentByMessageID.get(finalStoppedMessageID);
  if (content === undefined) throw new NodulusError("PROVIDER_RESPONSE_MISSING", "OpenCode CLI did not return content for its final stopped assistant message.");
  const selected = content.text.length > 0 ? content.text : content.reasoning;
  if (selected.length === 0) throw new NodulusError("PROVIDER_RESPONSE_MISSING", "OpenCode CLI did not return text or reasoning for its final stopped assistant message.");
  return { response: selected.join(""), sessionID: content.sessionID };
}

function providerError(error: NodulusError): string {
  return JSON.stringify({ status: "error", error: { code: error.code, message: error.message } });
}

async function saveTransport(directory: string, kind: Kind, result: Awaited<ReturnType<typeof runProcess>>, lastMessage?: string): Promise<void> {
  await writeFile(path.join(directory, "transport.json"), `${JSON.stringify({
    provider: kind,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    started: result.started,
    ...(lastMessage === undefined ? {} : { lastMessage }),
  }, null, 2)}\n`, "utf8");
}

async function attemptDirectory(cwd: string, invocation: ProviderInvocation): Promise<string> {
  const runPath = path.join(cwd, ".nodulus", "runs", invocation.runId);
  const directory = path.join(runPath, "provider", invocation.nodeId, `attempt-${String(invocation.attempt).padStart(3, "0")}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

function repairSessionKey(invocation: ProviderInvocation): string {
  return `${invocation.runId}\u0000${invocation.nodeId}\u0000${invocation.attempt}`;
}

function boundedTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(value, invocationTimeout)) : invocationTimeout;
}
function detail(value: string): string { return value.trim() ? `: ${value.trim().slice(0, 4000)}` : ""; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isCodexReasoningEffort(value: unknown): value is "minimal" | "low" | "medium" | "high" | "xhigh" {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

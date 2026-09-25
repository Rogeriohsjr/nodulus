import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderInvocation, ProviderPort } from "../../core/ports/provider.js";
import { NodulusError } from "../../core/shared/nodulus-error.js";
import { runProcess } from "./process-runner.js";

type Kind = "codex" | "cursor";
const invocationTimeout = 10 * 60 * 1000;
const outcomeSchema = {
  type: "object",
  properties: { response: { type: "string" } },
  required: ["response"],
  additionalProperties: false,
};

export function createDefaultProviderPort(projectRoot: string): ProviderPort {
  return {
    async invoke(invocation) {
      const profile = invocation.providerProfile;
      const kind = requireKind(profile);
      if (profile.enabled !== true) throw new NodulusError("PROVIDER_DISABLED", `Captured ${kind} provider profile is disabled.`);
      const executable = typeof profile.executable === "string" ? profile.executable : "";
      const timeout = boundedTimeout(profile.timeoutMs);
      await checkVersion(kind, executable, projectRoot, timeout);
      await checkAuthentication(kind, executable, projectRoot, timeout);
      return kind === "codex"
        ? invokeCodex(executable, projectRoot, invocation, timeout)
        : invokeCursor(executable, projectRoot, invocation, timeout);
    },
    async isAvailable(profile) {
      if (profile.enabled !== true || typeof profile.executable !== "string" || !profile.executable) return false;
      const kind = requireKind(profile);
      try {
        await checkVersion(kind, profile.executable, projectRoot, boundedTimeout(profile.timeoutMs));
        await checkAuthentication(kind, profile.executable, projectRoot, boundedTimeout(profile.timeoutMs));
        return true;
      } catch { return false; }
    },
    usageForLastCall: () => null,
  };
}

function requireKind(profile: Record<string, unknown>): Kind {
  if (profile.kind === "codex" || profile.kind === "cursor") return profile.kind;
  throw new NodulusError("PROVIDER_KIND_REQUIRED", "The default provider adapter requires an explicit provider kind: 'codex' or 'cursor'.");
}

async function checkVersion(kind: Kind, executable: string, cwd: string, timeoutMs: number): Promise<void> {
  let result;
  try { result = await runProcess(executable, ["--version"], { cwd, timeoutMs }); }
  catch (error) { throw new NodulusError("PROVIDER_EXECUTABLE_UNAVAILABLE", `${kind} executable could not be started: ${messageOf(error)}`); }
  if (result.timedOut || result.exitCode !== 0) throw new NodulusError("PROVIDER_VERSION_UNAVAILABLE", `${kind} version probe failed${detail(result.stderr)}.`);
  const match = `${result.stdout}\n${result.stderr}`.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?/);
  if (!match) throw new NodulusError("PROVIDER_VERSION_UNRECOGNIZED", `${kind} version is unavailable or unrecognized; install a documented compatible CLI version.`);
  if (kind === "codex" && compareVersion(match.slice(1).map(Number), [0, 144, 4]) < 0) {
    throw new NodulusError("PROVIDER_VERSION_UNSUPPORTED", `Codex CLI version ${match[0].trim()} is unsupported; the verified minimum is 0.144.4.`);
  }
}

function compareVersion(actual: number[], required: number[]): number {
  for (let i = 0; i < 3; i++) if (actual[i] !== required[i]) return actual[i]! - required[i]!;
  return 0;
}

async function checkAuthentication(kind: Kind, executable: string, cwd: string, timeoutMs: number): Promise<void> {
  const args = kind === "codex" ? ["login", "status"] : ["status", "--format", "json"];
  let result;
  try { result = await runProcess(executable, args, { cwd, timeoutMs: Math.min(timeoutMs, 30_000) }); }
  catch (error) { throw new NodulusError("PROVIDER_AUTH_UNAVAILABLE", `${kind} authentication status could not be checked: ${messageOf(error)}`); }
  if (result.timedOut || result.exitCode !== 0) {
    throw new NodulusError("PROVIDER_AUTH_REQUIRED", `${kind} authentication check failed${detail(result.stderr)}. Sign in using the provider's documented CLI command.`);
  }
  // Cursor's status JSON has no relied-upon auth schema; only its documented exit status is used.
}

async function invokeCodex(executable: string, cwd: string, invocation: ProviderInvocation, timeoutMs: number): Promise<string> {
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
  const result = await runProcess(executable, args, { cwd, stdin: transportPrompt, timeoutMs });
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

async function invokeCursor(executable: string, cwd: string, invocation: ProviderInvocation, timeoutMs: number): Promise<string> {
  const directory = await attemptDirectory(cwd, invocation);
  const promptPath = path.join(directory, "prompt.md");
  await writeFile(promptPath, invocation.prompt, "utf8");
  const args = ["-p", `Read the complete captured prompt at ${promptPath}`, "--output-format", "json", "--workspace", cwd];
  if (typeof invocation.providerProfile.model === "string") args.push("--model", invocation.providerProfile.model);
  const result = await runProcess(executable, args, { cwd, timeoutMs });
  await saveTransport(directory, "cursor", result);
  if (result.timedOut) throw new NodulusError("PROVIDER_TIMEOUT", "Cursor CLI exceeded its configured invocation timeout.");
  if (result.outputLimitExceeded) throw new NodulusError("PROVIDER_OUTPUT_LIMIT", "Cursor CLI exceeded the 2 MiB transport output limit.");
  if (result.exitCode !== 0) throw new NodulusError("PROVIDER_PROCESS_FAILED", `Cursor CLI exited with code ${result.exitCode}${detail(result.stderr)}.`);
  let envelope: unknown;
  try { envelope = JSON.parse(result.stdout) as unknown; }
  catch (error) { throw new NodulusError("PROVIDER_TRANSPORT_INVALID", `Cursor CLI returned malformed JSON: ${messageOf(error)}${detail(result.stderr)}.`); }
  if (!isRecord(envelope) || envelope.type !== "result" || envelope.subtype !== "success" || envelope.is_error !== false || typeof envelope.result !== "string") {
    throw new NodulusError("PROVIDER_TRANSPORT_INVALID", `Cursor CLI returned an unrecognized result envelope${detail(result.stderr)}.`);
  }
  return envelope.result;
}

async function saveTransport(directory: string, kind: Kind, result: Awaited<ReturnType<typeof runProcess>>, lastMessage?: string): Promise<void> {
  await writeFile(path.join(directory, "transport.json"), `${JSON.stringify({
    provider: kind,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(lastMessage === undefined ? {} : { lastMessage }),
  }, null, 2)}\n`, "utf8");
}

async function attemptDirectory(cwd: string, invocation: ProviderInvocation): Promise<string> {
  const runPath = path.join(cwd, ".nodulus", "runs", invocation.runId);
  const directory = path.join(runPath, "provider", invocation.nodeId, `attempt-${String(invocation.attempt).padStart(3, "0")}`);
  await mkdir(directory, { recursive: true });
  return directory;
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

import crossSpawn from "cross-spawn";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { fileURLToPath } from "node:url";
import type { getRunStatus } from "../../src/application/resume-workflow.js";

type RunStatus = Awaited<ReturnType<typeof getRunStatus>>;

export interface LiveEvidenceMetadata {
  packageVersion: string;
  archiveSha256: string;
  model: string | null;
  endpointOrigin?: string;
}

export interface InstalledProviderSmokeOptions {
  provider: "codex" | "cursor" | "opencode";
  executable: string;
  model: string | null;
  timeoutMs: number;
  endpointOrigin?: string;
  evidencePath?: string;
  diagnosticPath?: string;
  prepareProject?: (project: string) => void;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function processErrorCode(error: unknown): string | null {
  const code = record(error)?.["code"];
  return typeof code === "string" ? code : null;
}

function run(stage: string, command: string, args: string[], cwd: string, timeout = 30_000): { stdout: string; stderr: string } {
  const result = crossSpawn.sync(command, args, { cwd, encoding: "utf8", timeout, windowsHide: true });
  const errorCode = processErrorCode(result.error);
  if (result.error) throw new Error(`Installed smoke ${stage} could not start (code ${errorCode ?? "unknown"}).`);
  if (result.status !== 0) throw new Error(`Installed smoke ${stage} failed (exit ${String(result.status ?? "unknown")}, code ${errorCode ?? "unknown"}).`);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function capture(command: string, args: string[], cwd: string, timeout = 30_000) {
  const result = crossSpawn.sync(command, args, { cwd, encoding: "utf8", timeout, windowsHide: true });
  const errorCode = processErrorCode(result.error);
  return {
    stdout: String(result.stdout ?? ""),
    exitCode: result.status,
    errorCode,
    timedOut: errorCode === "ETIMEDOUT",
  };
}

const safeErrorCodes = new Set([
  "PROVIDER_FAILURE", "PROVIDER_EXECUTABLE_UNAVAILABLE", "PROVIDER_VERSION_UNAVAILABLE",
  "PROVIDER_VERSION_UNRECOGNIZED", "PROVIDER_VERSION_UNSUPPORTED", "PROVIDER_MODEL_UNAVAILABLE",
  "PROVIDER_DISABLED", "PROVIDER_KIND_REQUIRED", "RESPONSE_REPAIR_UNAVAILABLE",
  "OUTPUT_CONTRACT_INVALID", "RUN_STATE_INVALID", "PROJECT_NOT_FOUND", "INVALID_SETTINGS",
  "INVALID_SETTINGS_JSON", "CONFIGURATION_INVALID",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(value)); } catch { return undefined; }
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && safeErrorCodes.has(value) ? value : null;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function writeFailureDiagnostic(destination: string | undefined, diagnostic: Record<string, unknown>): void {
  if (!destination) return;
  const resolved = path.resolve(destination);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
}

export function classifyInstalledFailure(stdout: string, statusStdout: string | null, projectRoot: string): Record<string, unknown> {
  const envelope = parseJsonRecord(stdout);
  const runId = envelope?.["runId"];
  const safeRunId = safeId(runId) ? runId : null;
  const runRoot = safeRunId ? path.resolve(projectRoot, ".nodulus", "runs", safeRunId) : null;
  const runsRoot = path.resolve(projectRoot, ".nodulus", "runs");
  const diagnostic: Record<string, unknown> = {
    stage: "run",
    cliExitCode: null,
    envelopeStatus: envelope?.["status"] === "success" || envelope?.["status"] === "needs_input" || envelope?.["status"] === "error"
      ? envelope["status"]
      : null,
    errorCode: safeCode(record(envelope?.["result"])?.["code"])
      ?? safeCode(record(record(envelope?.["result"])?.["error"])?.["code"]),
    runIdPresent: safeRunId !== null,
    callLaunched: null,
    requestAvailable: null,
    transportAvailable: null,
    transportExitCode: null,
    timedOut: null,
    outputLimitExceeded: null,
  };
  if (safeRunId && runRoot && within(runsRoot, runRoot) && statusStdout !== null) {
    const statusEnvelope = parseJsonRecord(statusStdout);
    const status = record(statusEnvelope?.["result"]);
    const metrics = record(status?.["metrics"]);
    const calls = Array.isArray(metrics?.["calls"]) ? metrics["calls"] as unknown[] : [];
    const call = record(calls[0]);
    if (typeof call?.["launched"] === "boolean") diagnostic["callLaunched"] = call["launched"];
    const callId = call?.["callId"];
    let safeRunRoot: string | undefined;
    try {
      const nodulusRoot = realpathSync(path.resolve(projectRoot, ".nodulus"));
      const realRunsRoot = realpathSync(runsRoot);
      const candidateRunRoot = realpathSync(runRoot);
      if (within(nodulusRoot, realRunsRoot) && within(realRunsRoot, candidateRunRoot)) safeRunRoot = candidateRunRoot;
    } catch { /* An unavailable or invalid run directory is unobserved evidence. */ }
    if (safeId(callId) && safeRunRoot) {
      const callRoot = path.resolve(safeRunRoot, "calls", callId);
      if (within(safeRunRoot, callRoot)) {
        let safeCallRoot: string | undefined;
        try {
          const candidateCallRoot = realpathSync(callRoot);
          if (within(safeRunRoot, candidateCallRoot)) safeCallRoot = candidateCallRoot;
        } catch {
          if (!existsSync(callRoot)) {
            diagnostic["requestAvailable"] = false;
            diagnostic["transportAvailable"] = false;
            diagnostic["timedOut"] = false;
            diagnostic["outputLimitExceeded"] = false;
          }
        }
        if (safeCallRoot) {
          const safeRequestPath = path.join(safeCallRoot, "request.json");
          const safeTransportPath = path.join(safeCallRoot, "transport.json");
          if (existsSync(safeRequestPath)) {
            try { diagnostic["requestAvailable"] = within(safeCallRoot, realpathSync(safeRequestPath)); }
            catch { diagnostic["requestAvailable"] = false; }
          } else diagnostic["requestAvailable"] = false;
          if (existsSync(safeTransportPath)) {
            let transportIsContained = false;
            try { transportIsContained = within(safeCallRoot, realpathSync(safeTransportPath)); } catch { /* Invalid transport is unavailable. */ }
            const transport = transportIsContained ? parseJsonRecord(readFileSync(safeTransportPath, "utf8")) : undefined;
            if (transport?.["callId"] === callId) {
              diagnostic["transportAvailable"] = true;
              diagnostic["transportExitCode"] = typeof transport["exitCode"] === "number" ? transport["exitCode"] : null;
              diagnostic["timedOut"] = typeof transport["timedOut"] === "boolean" ? transport["timedOut"] : null;
              diagnostic["outputLimitExceeded"] = typeof transport["outputLimitExceeded"] === "boolean" ? transport["outputLimitExceeded"] : null;
            } else {
              diagnostic["transportAvailable"] = false;
            }
          } else {
            diagnostic["transportAvailable"] = false;
          }
        }
      }
    }
  }
  return diagnostic;
}

function parseRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} must be an object.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${description} must be a nonempty string.`);
  return value;
}

function readRecord(filePath: string, description: string): Record<string, unknown> {
  return parseRecord(JSON.parse(readFileSync(filePath, "utf8")), description);
}

export function runInstalledProviderSmoke(options: InstalledProviderSmokeOptions) {
  const scratch = mkdtempSync(path.join(tmpdir(), `nodulus-live-${options.provider}-`));
  try {
    const packageDirectory = path.join(scratch, "package");
    const prefix = path.join(scratch, "installed");
    const project = path.join(scratch, "project");
    mkdirSync(packageDirectory, { recursive: true });
    run("build", "npm", ["run", "build"], repository, 120_000);
    const packed = run("pack", "npm", ["pack", "--json", "--pack-destination", packageDirectory], repository, 120_000);
    const packageInfo = parseRecord(JSON.parse(packed.stdout)[0], "packed package metadata");
    const archivePath = path.join(packageDirectory, requireString(packageInfo["filename"], "package filename"));
    const archiveSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    run("install archive", "npm", ["install", "--no-audit", "--no-fund", "--prefix", prefix, archivePath], repository, 120_000);

    const shim = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "nodulus.cmd" : "nodulus");
    run("initialize project", shim, ["init", "--project", project], scratch);
    const packageVersion = run("read installed version", shim, ["--version"], project).stdout.trim();
    expect(packageVersion).toBe(packageInfo["version"]);
    options.prepareProject?.(project);
    if (options.provider === "codex") run("initialize isolated Git repository", "git", ["init"], project);

    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = readRecord(settingsPath, "initialized settings");
    const profile: Record<string, unknown> = {
      kind: options.provider,
      enabled: true,
      executable: options.executable,
      timeoutMs: options.timeoutMs,
      capabilities: [],
    };
    if (options.model !== null) profile["model"] = options.model;
    if (options.provider === "codex") Object.assign(profile, { sandbox: "read-only", reasoningEffort: "low" });
    settings["providerProfiles"] = { live: profile };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
    const node = readRecord(nodePath, "example node");
    node["providerProfile"] = "live";
    node["inputs"] = { request: { from: "request", contract: "request.v1" } };
    writeFileSync(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");

    const request = `OBS-012 ${options.provider} live fixture: return exactly the requested artifact with message LIVE-${options.provider}-artifact.`;
    const expectedArtifact = { name: "example", contract: "example.v1", data: { message: `LIVE-${options.provider}-artifact` } };
    const execution = capture(shim, ["run", "--project", project, "--request", request, "--json"], project, options.timeoutMs + 30_000);
    if (execution.exitCode !== 0) {
      const envelope = parseJsonRecord(execution.stdout);
      const runId = envelope?.["runId"];
      const safeRunId = safeId(runId) ? runId : null;
      const statusCapture = safeRunId ? capture(shim, ["status", safeRunId, "--project", project, "--json"], project, 15_000) : null;
      const statusStdout = statusCapture?.exitCode === 0 ? statusCapture.stdout : null;
      const diagnostic = classifyInstalledFailure(execution.stdout, statusStdout, project);
      diagnostic["cliExitCode"] = execution.exitCode;
      try { writeFailureDiagnostic(options.diagnosticPath, diagnostic); } catch { /* Keep the bounded CLI failure summary independent of optional export I/O. */ }
      throw new Error(`Installed smoke run installed CLI failed (exit ${String(execution.exitCode ?? "unknown")}, code ${execution.errorCode ?? "unknown"}).`);
    }
    const runEnvelope = parseRecord(JSON.parse(execution.stdout), "run result");
    expect(runEnvelope["status"]).toBe("success");
    const runId = requireString(runEnvelope["runId"], "runId");
    const runResult = parseRecord(runEnvelope["result"], "run result payload");
    expect(runResult["artifacts"]).toEqual([expectedArtifact]);

    const statusEnvelope = parseRecord(JSON.parse(run("read installed status", shim, ["status", runId, "--project", project, "--json"], project).stdout), "status result");
    const status = parseRecord(statusEnvelope["result"], "status result payload") as Parameters<typeof collectLiveEvidence>[0]["status"];
    const calls = status.metrics?.calls ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.launched).toBe(true);
    expect(calls[0]?.telemetry?.provider).toBe(options.provider);
    expect(["complete", "partial", "unavailable"]).toContain(calls[0]?.telemetry?.coverage);

    const evidence = collectLiveEvidence({
      projectRoot: project,
      runId,
      status,
      metadata: { packageVersion, archiveSha256, model: options.model, ...(options.endpointOrigin ? { endpointOrigin: options.endpointOrigin } : {}) },
    });
    const runRoot = path.join(project, ".nodulus", "runs", runId);
    const savedResult = readRecord(path.join(runRoot, evidence.refs.result), "saved accepted result");
    expect(savedResult["status"]).toBe("success");
    expect(savedResult["artifacts"]).toEqual([expectedArtifact]);
    const call = calls[0]!;
    const callId = requireString(call.callId, "callId");
    const callRoot = path.join(project, ".nodulus", "runs", runId, "calls", callId);
    for (const filename of ["request.json", "stdin.txt", "transport.json", "telemetry.json"]) expect(existsSync(path.join(callRoot, filename)), filename).toBe(true);
    const capturedRequest = readRecord(path.join(callRoot, "request.json"), "request capture");
    const transport = readRecord(path.join(callRoot, "transport.json"), "transport capture");
    expect(capturedRequest).toMatchObject({ callId, requestedModel: options.model, provider: options.provider });
    expect(readFileSync(path.join(callRoot, "stdin.txt"), "utf8")).toContain(request);
    expect(transport).toMatchObject({ callId: call.callId, exitCode: 0, timedOut: false, outputLimitExceeded: false });

    const evidencePath = options.evidencePath;
    if (evidencePath) {
      mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
      writeFileSync(path.resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    return evidence;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function collectLiveEvidence({
  projectRoot,
  runId,
  status,
  metadata,
}: {
  projectRoot: string;
  runId: string;
  status: RunStatus;
  metadata: LiveEvidenceMetadata;
}) {
  const calls = status.metrics?.calls ?? [];
  if (calls.length !== 1) throw new Error("Expected one persisted metric call.");
  const call = calls[0];
  if (!call) throw new Error("Expected one persisted metric call.");
  const telemetry = call.telemetry;
  if (!telemetry) throw new Error("Expected persisted call telemetry.");

  const runRoot = path.resolve(projectRoot, ".nodulus", "runs", runId);
  const callRoot = `calls/${call.callId}`;
  const attemptRoot = `nodes/${call.nodeId}/attempt-${call.attempt.toString().padStart(3, "0")}`;
  const refs = {
    request: `${callRoot}/request.json`,
    stdin: `${callRoot}/stdin.txt`,
    transport: `${callRoot}/transport.json`,
    telemetry: `${callRoot}/telemetry.json`,
    prompt: `${attemptRoot}/prompt.md`,
    response: `${attemptRoot}/response.raw.txt`,
    validation: `${attemptRoot}/validation.json`,
    result: `${attemptRoot}/result.json`,
  };

  const resolveReference = (reference: string): string => {
    if (path.isAbsolute(reference) || reference.includes("\\")) throw new Error("Evidence references must be relative POSIX paths.");
    const resolved = path.resolve(runRoot, ...reference.split("/"));
    const relative = path.relative(runRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Evidence reference escapes the run directory.");
    return resolved;
  };
  const readText = (reference: string): string => readFileSync(resolveReference(reference), "utf8");
  const parseObject = (contents: string, description: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(contents);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} must be an object.`);
    return value as Record<string, unknown>;
  };

  const request = parseObject(readText(refs.request), "request.json");
  if (request["callId"] !== call.callId || request["runId"] !== runId || request["nodeId"] !== call.nodeId || request["attempt"] !== call.attempt || request["provider"] !== telemetry.provider) {
    throw new Error("request.json identity does not match status telemetry.");
  }
  const requestRefs = request["refs"];
  if (typeof requestRefs !== "object" || requestRefs === null || Array.isArray(requestRefs)) throw new Error("request.json refs must be an object.");
  for (const key of ["prompt", "response", "validation", "result"] as const) {
    const value = (requestRefs as Record<string, unknown>)[key];
    if (value !== refs[key]) throw new Error(`request.json ${key} reference does not match the run record.`);
    resolveReference(value);
  }
  if ((requestRefs as Record<string, unknown>)["stdin"] !== refs.stdin || (requestRefs as Record<string, unknown>)["transport"] !== refs.transport) {
    throw new Error("request.json provider references do not match the run record.");
  }

  const transport = parseObject(readText(refs.transport), "transport.json");
  if (transport["callId"] !== call.callId || transport["provider"] !== telemetry.provider || transport["exitCode"] !== 0 || transport["timedOut"] !== false || transport["outputLimitExceeded"] !== false) {
    throw new Error("transport.json does not show a successful provider call.");
  }
  const persistedTelemetry = parseObject(readText(refs.telemetry), "telemetry.json");
  if (JSON.stringify(persistedTelemetry) !== JSON.stringify(telemetry)) throw new Error("Persisted telemetry does not match status telemetry.");
  for (const reference of [refs.stdin, refs.prompt, refs.response]) readText(reference);
  const validation = parseObject(readText(refs.validation), "validation.json");
  if (validation["valid"] !== true) throw new Error("The saved validation did not accept the artifact.");
  const result = parseObject(readText(refs.result), "result.json");
  if (result["status"] !== "success" || !Array.isArray(result["artifacts"]) || result["artifacts"].length === 0) {
    throw new Error("The saved result does not contain a successful artifact.");
  }

  return {
    schemaVersion: 1,
    packageVersion: metadata.packageVersion,
    archiveSha256: metadata.archiveSha256,
    runId,
    callId: call.callId,
    provider: telemetry.provider,
    model: metadata.model,
    reportedModel: telemetry.reportedModel ?? null,
    ...(metadata.endpointOrigin ? { endpointOrigin: metadata.endpointOrigin } : {}),
    cliVersion: telemetry.cliVersion,
    coverage: telemetry.coverage,
    reported: telemetry.reported,
    normalized: telemetry.normalized,
    os: { platform: platform(), arch: arch(), release: release() },
    nodeVersion: process.version,
    refs,
  };
}

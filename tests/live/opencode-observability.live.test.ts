import crossSpawn from "cross-spawn";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const enabled = process.env.NODULUS_LIVE_OPENCODE === "1";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test.skipIf(!enabled)("LIVE-OPENCODE-001 runs the installed archive through local OpenCode and captures observability evidence", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "nodulus-live-opencode-"));
  try {
    const packageDirectory = path.join(scratch, "package");
    const prefix = path.join(scratch, "installed");
    const project = path.join(scratch, "project");
    mkdirSync(packageDirectory, { recursive: true });

    run("npm", ["run", "build"], repository, 120_000);
    const packed = run("npm", ["pack", "--json", "--pack-destination", packageDirectory], repository, 120_000);
    const metadata = JSON.parse(packed.stdout)[0] as { filename: string; version: string };
    const archivePath = path.join(packageDirectory, metadata.filename);
    const archiveSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    run("npm", ["install", "--no-audit", "--no-fund", "--prefix", prefix, archivePath], repository, 120_000);

    const shim = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "nodulus.cmd" : "nodulus");
    run(shim, ["init", "--project", project], scratch);
    const version = run(shim, ["--version"], project).stdout.trim();
    expect(version).toBe(metadata.version);

    const sourceConfigPath = process.env.NODULUS_LIVE_OPENCODE_CONFIG ?? path.join(repository, "opencode.json");
    const sourceConfig = parseRecord(readFileSync(sourceConfigPath, "utf8"), "OpenCode config");
    const model = process.env.NODULUS_LIVE_OPENCODE_MODEL ?? sourceConfig.model;
    if (typeof model !== "string" || !model.startsWith("ollama/")) throw new Error("The live model must use the ollama provider.");
    const provider = requireRecord(requireRecord(sourceConfig.provider, "provider").ollama, "provider.ollama");
    const options = requireRecord(provider.options, "provider.ollama.options");
    const baseURL = new URL(String(options.baseURL));
    if (baseURL.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(baseURL.hostname)) {
      throw new Error("The OpenCode/Ollama endpoint must be loopback HTTP.");
    }
    const buildAgent = requireRecord(requireRecord(sourceConfig.agent, "agent").build, "agent.build");
    const liveConfig = {
      $schema: sourceConfig.$schema,
      provider: { ollama: provider },
      enabled_providers: ["ollama"],
      model,
      small_model: model,
      permission: { "*": "deny" },
      compaction: { auto: false, prune: false },
      agent: {
        build: { ...buildAgent, permission: { "*": "deny" } },
        title: { disable: true },
      },
    };
    writeFileSync(path.join(project, "opencode.json"), `${JSON.stringify(liveConfig, null, 2)}\n`, "utf8");

    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = parseRecord(readFileSync(settingsPath, "utf8"), "settings");
    settings.providerProfiles = {
      live: {
        kind: "opencode",
        enabled: true,
        executable: process.env.NODULUS_OPENCODE_EXECUTABLE ?? "opencode",
        model,
        timeoutMs: 300_000,
        capabilities: [],
      },
    };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
    const node = parseRecord(readFileSync(nodePath, "utf8"), "example node");
    node.providerProfile = "live";
    writeFileSync(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");

    const completed = run(shim, ["run", "--project", project, "--request", "Return a short nonempty message in the declared example artifact.", "--json"], project, 360_000);
    const runEnvelope = parseRecord(completed.stdout, "run result");
    expect(runEnvelope).toMatchObject({ schemaVersion: 1, status: "success" });
    const runId = requireString(runEnvelope.runId, "runId");
    const statusEnvelope = parseRecord(run(shim, ["status", runId, "--project", project, "--json"], project).stdout, "status result");
    const result = requireRecord(statusEnvelope.result, "status result payload");
    const metrics = requireRecord(result.metrics, "metrics");
    const calls = metrics.calls;
    if (!Array.isArray(calls) || calls.length !== 1) throw new Error("Expected one persisted metric call.");
    const call = requireRecord(calls[0], "metric call");
    const callId = requireString(call.callId, "callId");
    const telemetry = requireRecord(call.telemetry, "telemetry");
    expect(call.launched).toBe(true);
    expect(telemetry.provider).toBe("opencode");
    expect(requireString(telemetry.cliVersion, "cliVersion")).not.toHaveLength(0);
    expect(["complete", "partial", "unavailable"]).toContain(telemetry.coverage);
    expect(requireRecord(telemetry.source, "telemetry.source").transportRef).toBe(`calls/${callId}/transport.json`);

    const callDirectory = path.join(project, ".nodulus", "runs", runId, "calls", callId);
    for (const filename of ["request.json", "stdin.txt", "transport.json", "telemetry.json"]) {
      expect(existsSync(path.join(callDirectory, filename)), filename).toBe(true);
    }
    const request = parseRecord(readFileSync(path.join(callDirectory, "request.json"), "utf8"), "request capture");
    const transport = parseRecord(readFileSync(path.join(callDirectory, "transport.json"), "utf8"), "transport capture");
    expect(request).toMatchObject({ callId, requestedModel: model });
    expect(transport).toMatchObject({ callId, exitCode: 0, timedOut: false, outputLimitExceeded: false });

    const evidencePath = process.env.NODULUS_LIVE_EVIDENCE;
    if (evidencePath) {
      const evidence = {
        schemaVersion: 1,
        packageVersion: version,
        archiveSha256,
        runId,
        callId,
        model,
        endpointOrigin: baseURL.origin,
        cliVersion: telemetry.cliVersion,
        coverage: telemetry.coverage,
        reported: telemetry.reported,
        normalized: telemetry.normalized,
      };
      mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
      writeFileSync(path.resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 420_000);

function run(command: string, args: string[], cwd: string, timeout = 30_000): { stdout: string; stderr: string } {
  const result = crossSpawn.sync(command, args, { cwd, encoding: "utf8", timeout, windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${String(result.status)}): ${String(result.stderr)}`);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function parseRecord(contents: string, description: string): Record<string, unknown> {
  const value: unknown = JSON.parse(contents);
  return requireRecord(value, description);
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} must be an object.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${description} must be a nonempty string.`);
  return value;
}

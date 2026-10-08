import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runInstalledProviderSmoke } from "../support/live-provider-observability.js";

const enabled = process.env.NODULUS_LIVE_OPENCODE === "1";

test.skipIf(!enabled)("LIVE-OPENCODE-001 verifies installed OpenCode/Ollama observability", () => {
  const sourceConfigPath = process.env.NODULUS_LIVE_OPENCODE_CONFIG ?? path.resolve("opencode.json");
  const sourceConfig = parseRecord(readFileSync(sourceConfigPath, "utf8"), "OpenCode config");
  const model = process.env.NODULUS_LIVE_OPENCODE_MODEL ?? sourceConfig["model"];
  if (typeof model !== "string" || !model.startsWith("ollama/")) throw new Error("The live model must use the ollama provider.");
  const provider = requireRecord(requireRecord(sourceConfig["provider"], "provider")["ollama"], "provider.ollama");
  const options = requireRecord(provider["options"], "provider.ollama.options");
  const baseURL = new URL(String(options["baseURL"]));
  if (baseURL.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(baseURL.hostname)) {
    throw new Error("The OpenCode/Ollama endpoint must be loopback HTTP.");
  }
  const buildAgent = requireRecord(requireRecord(sourceConfig["agent"], "agent")["build"], "agent.build");
  const liveConfig = {
    $schema: sourceConfig["$schema"],
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
  const evidence = runInstalledProviderSmoke({
    provider: "opencode",
    executable: process.env.NODULUS_OPENCODE_EXECUTABLE ?? "opencode",
    model,
    endpointOrigin: baseURL.origin,
    timeoutMs: 300_000,
    evidencePath: process.env.NODULUS_LIVE_EVIDENCE,
    diagnosticPath: process.env.NODULUS_LIVE_EVIDENCE ? `${process.env.NODULUS_LIVE_EVIDENCE}.failure.json` : undefined,
    prepareProject: project => writeFileSync(path.join(project, "opencode.json"), `${JSON.stringify(liveConfig, null, 2)}\n`, "utf8"),
  });
  expect(evidence.provider).toBe("opencode");
}, 600_000);

function parseRecord(contents: string, description: string): Record<string, unknown> {
  return requireRecord(JSON.parse(contents), description);
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} must be an object.`);
  return value as Record<string, unknown>;
}

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createProviderScenario, type FixtureProviderKind } from "./provider-adapter-scenarios.js";

export const usageOutcome = JSON.stringify({ status: "success", artifacts: [{ name: "example", contract: "example.v1", data: { message: "usage fixture result" } }] });
export const jsonLines = (events: unknown[]): string => events.map(event => JSON.stringify(event)).join("\n") + "\n";
export async function createUsageScenario(kind: FixtureProviderKind, stdout: string, version = kind === "codex" ? "0.144.4" : kind === "opencode" ? "1.18.32" : "2026.09.23-86fc751") {
  const scenario = await createProviderScenario(kind);
  const directory = path.join(scenario.project, ".nodulus/fixtures");
  writeFileSync(path.join(directory, `${kind}-fixture.mjs`), readFileSync(new URL("../fixtures/observability/usage-provider.mjs", import.meta.url), "utf8"));
  writeFileSync(path.join(directory, "usage-control.json"), JSON.stringify({ kind, stdout, version, outcome: usageOutcome }));
  return scenario;
}

import type { ProviderTelemetry } from "../../core/ports/provider-telemetry.js";
import { parseCodexUsage } from "./codex-usage.js";
import { parseCursorUsage } from "./cursor-usage.js";
import { parseOpenCodeUsage } from "./opencode-usage.js";
import { makeTelemetry } from "./usage-common.js";

export function parseProviderTelemetry(provider: string, stdout: string, cliVersion: string | null): ProviderTelemetry {
  if (provider === "codex") return parseCodexUsage(stdout, cliVersion);
  if (provider === "cursor") return parseCursorUsage(stdout, cliVersion);
  if (provider === "opencode") return parseOpenCodeUsage(stdout, cliVersion);
  return makeTelemetry(provider, cliVersion, "unsupported", []);
}

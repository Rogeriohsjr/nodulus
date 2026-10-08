import { expect, test } from "vitest";
import { runInstalledProviderSmoke } from "../support/live-provider-observability.js";

const enabled = process.env.NODULUS_LIVE_CODEX === "1";

test.skipIf(!enabled)("LIVE-CODEX-001 verifies installed Codex observability", () => {
  const evidence = runInstalledProviderSmoke({
    provider: "codex",
    executable: process.env.NODULUS_CODEX_EXECUTABLE ?? "codex",
    model: process.env.NODULUS_LIVE_CODEX_MODEL ?? null,
    timeoutMs: 120_000,
    evidencePath: process.env.NODULUS_LIVE_EVIDENCE,
    diagnosticPath: process.env.NODULUS_LIVE_EVIDENCE ? `${process.env.NODULUS_LIVE_EVIDENCE}.failure.json` : undefined,
  });
  expect(evidence.provider).toBe("codex");
}, 480_000);

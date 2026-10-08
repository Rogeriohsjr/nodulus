import { expect, test } from "vitest";
import { runInstalledProviderSmoke } from "../support/live-provider-observability.js";

const enabled = process.env.NODULUS_LIVE_CURSOR === "1";

test.skipIf(!enabled)("LIVE-CURSOR-001 verifies installed Cursor observability", () => {
  const evidence = runInstalledProviderSmoke({
    provider: "cursor",
    executable: process.env.NODULUS_CURSOR_EXECUTABLE ?? "agent",
    model: process.env.NODULUS_LIVE_CURSOR_MODEL ?? null,
    timeoutMs: 120_000,
    evidencePath: process.env.NODULUS_LIVE_EVIDENCE,
    diagnosticPath: process.env.NODULUS_LIVE_EVIDENCE ? `${process.env.NODULUS_LIVE_EVIDENCE}.failure.json` : undefined,
  });
  expect(evidence.provider).toBe("cursor");
}, 480_000);

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";

const liveCursorEnabled = process.env.NODULUS_LIVE_CURSOR === "1";

test.skipIf(!liveCursorEnabled)("LIVE-CURSOR-001 invokes the installed Cursor CLI through the production adapter", async () => {
  const project = mkdtempSync(path.join(tmpdir(), "nodulus-live-cursor-"));
  const executable = process.env.NODULUS_CURSOR_EXECUTABLE ?? "agent";
  const expected = {
    status: "success",
    artifacts: [{ name: "smoke", contract: "smoke.v1", data: { message: "cursor-live-smoke" } }],
  };

  try {
    const provider = createDefaultProviderPort(project);
    const raw = await provider.invoke({
      runId: "live-cursor-smoke",
      attempt: 1,
      workflow: "live-cursor-smoke",
      nodeId: "cursor",
      inputs: {},
      providerProfile: {
        kind: "cursor",
        enabled: true,
        executable,
        timeoutMs: 120_000,
        capabilities: [],
      },
      prompt: [
        "This is a read-only adapter smoke test. Do not edit files or run shell commands.",
        "Read this complete prompt and return only the following JSON object, without Markdown fences or commentary:",
        JSON.stringify(expected),
      ].join("\n"),
    });

    expect(JSON.parse(raw)).toEqual(expected);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 180_000);

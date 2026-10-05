import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import * as api from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";

type InspectRun = (projectRoot: string, runId: string) => Promise<Record<string, unknown>>;
type ReplayRun = (projectRoot: string, runId: string) => Promise<Record<string, unknown>>;
const inspectRun = (api as unknown as { inspectRun: InspectRun }).inspectRun;
const replayRun = (api as unknown as { replaySavedRun: ReplayRun }).replaySavedRun;
const RUN_MALFORMED = "841c1ff4-31f1-4a02-a2bc-84d298fad905";
const RUN_LEGACY = "841c1ff4-31f1-4a02-a2bc-84d298fad906";

function write(project: string, runId: string, relative: string, contents: string): void {
  const target = path.join(project, ".nodulus", "runs", runId, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function snapshot(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push(`${path.relative(root, file)}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`);
    }
  };
  visit(root);
  return files.sort();
}

test("INS-005 reports damaged and legacy evidence without changing the saved runs", async () => {
  const project = createInitializedProject("ins-005 damaged evidence café");
  const runsRoot = path.join(project, ".nodulus", "runs");
  write(project, RUN_MALFORMED, "run.json", "{broken json");
  write(project, RUN_LEGACY, "run.json", JSON.stringify({ schemaVersion: 1, engineVersion: "0.9.0", runId: RUN_LEGACY, workflow: "build", phase: "execution", status: "error", activeNode: "worker", completedNodes: [], attempt: 1 }));
  write(project, RUN_LEGACY, "context/definitions.json", JSON.stringify({
    schemaVersion: 1,
    engineVersion: "0.9.0",
    workflow: { schemaVersion: 1, id: "build", nodes: ["worker"] },
    nodes: [{ schemaVersion: 1, id: "worker", providerProfile: "fixture", instructions: ["instructions/worker.md"], inputs: {}, expectedOutputs: [{ name: "result", contract: "result.v1" }] }],
    contracts: { "request.v1": { type: "string", minLength: 1 }, "result.v1": { type: "object", properties: { result: { type: "string" } } } },
    providerProfiles: { fixture: { kind: "codex", enabled: true, sandbox: "read-only" } },
  }));
  write(project, RUN_LEGACY, "events.jsonl", `${JSON.stringify({ event: "node.started", runId: RUN_LEGACY, nodeId: "worker", attempt: 1, sequence: 1 })}\n{broken event\n`);
  write(project, RUN_LEGACY, "nodes/worker/attempt-001/response.raw.txt", "not-json");
  const before = snapshot(runsRoot);
  try {
    const damaged = await inspectRun(project, RUN_MALFORMED);
    expect(damaged).toMatchObject({
      runId: RUN_MALFORMED,
      status: "unavailable",
      checkpoint: null,
      diagnostics: { messages: expect.arrayContaining([expect.stringContaining("run")]) },
    });

    const legacy = await replayRun(project, RUN_LEGACY);
    expect(legacy).toMatchObject({
      runId: RUN_LEGACY,
      drift: expect.arrayContaining([expect.objectContaining({ kind: "engine-version", captured: "0.9.0", current: "1.0.0" })]),
      diagnostics: expect.arrayContaining([expect.stringContaining("malformed"), expect.stringContaining("response.raw.txt")]),
    });
    expect(snapshot(runsRoot)).toEqual(before);
  } finally {
    try { expect(snapshot(runsRoot)).toEqual(before); }
    finally { rmSync(project, { recursive: true, force: true }); }
  }
});

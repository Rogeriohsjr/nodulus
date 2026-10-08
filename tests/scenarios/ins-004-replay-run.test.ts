import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import * as api from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";

type ReplayRun = (projectRoot: string, runId: string) => Promise<Record<string, unknown>>;
const replayRun = (api as unknown as { replaySavedRun?: ReplayRun }).replaySavedRun;
const RUN_ID = "641c1ff4-31f1-4a02-a2bc-84d298fad914";

function write(project: string, relative: string, contents: string): void {
  const file = path.join(project, ".nodulus", "runs", RUN_ID, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function snapshot(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else entries.push(`${path.relative(root, file)}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`);
    }
  };
  visit(root);
  return entries.sort();
}

function createFixture(): { project: string; runsRoot: string; sentinel: string } {
  const project = createInitializedProject("ins-004 replay café project");
  const runsRoot = path.join(project, ".nodulus", "runs");
  const sentinel = path.join(project, "validator-ran.txt");
  const providerSentinel = path.join(project, "provider-ran.txt");
  const scriptPath = (name: string) => path.join(project, "validator fixture café", process.platform === "win32" ? `${name}.cmd` : `${name}.sh`);
  const makeScript = (name: string, target: string) => {
    const file = scriptPath(name);
    mkdirSync(path.dirname(file), { recursive: true });
    const script = process.platform === "win32"
      ? `@echo off\r\necho ran>"${target}"\r\nexit /b 71\r\n`
      : `#!/bin/sh\nprintf ran > '${target.replaceAll("'", "'\\''")}'\nexit 71\n`;
    writeFileSync(file, script, "utf8");
    if (process.platform !== "win32") chmodSync(file, 0o755);
    return path.relative(project, file).replaceAll(path.sep, "/");
  };
  const validatorPath = makeScript("reject-validator", sentinel);
  const providerPath = makeScript("reject-provider", providerSentinel);
  write(project, "run.json", JSON.stringify({ schemaVersion: 1, engineVersion: "1.0.0", runId: RUN_ID, workflow: "build", phase: "execution", status: "error", activeNode: "worker", completedNodes: [], attempt: 1 }));
  write(project, "context/definitions.json", JSON.stringify({
    schemaVersion: 1,
    engineVersion: "1.0.0",
    workflow: { schemaVersion: 1, id: "build", nodes: ["worker"] },
    nodes: [{ schemaVersion: 1, id: "worker", providerProfile: "fixture", instructions: ["instructions/worker.md"], inputs: {}, expectedOutputs: [
      { name: "accepted", contract: "accepted.v1", validator: validatorPath },
      { name: "rejected", contract: "rejected.v1" },
    ] }],
    contracts: {
      "request.v1": { type: "string", minLength: 1 },
      "accepted.v1": { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 0 } }, additionalProperties: false },
      "rejected.v1": { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 0 } }, additionalProperties: false },
    },
    providerProfiles: { fixture: { kind: "codex", enabled: true, executable: providerPath, sandbox: "read-only" } },
  }));
  write(project, "nodes/worker/attempt-001/response.raw.txt", JSON.stringify({ status: "success", artifacts: [
    { name: "accepted", contract: "accepted.v1", data: { count: 3 } },
    { name: "rejected", contract: "rejected.v1", data: { count: -1 } },
    { name: "unmapped", contract: "missing.v1", data: { count: 4 } },
  ] }));
  write(project, "events.jsonl", JSON.stringify({ event: "node.started", runId: RUN_ID, nodeId: "worker", attempt: 1, sequence: 1 }) + "\n");
  write(project, "nodes/worker/attempt-001/validation.json", JSON.stringify({ valid: false, code: "VALIDATOR_REJECTED", errors: ["original validator rejected the output"] }));
  writeFileSync(path.join(project, ".nodulus", "contracts", "accepted.v1.schema.json"), JSON.stringify({ type: "object", required: ["changed"], properties: { changed: { type: "boolean" } } }), "utf8");
  return { project, runsRoot, sentinel };
}

test("INS-004 replays captured artifact candidates using captured schemas and skips providers and executable validators", async () => {
  const { project, runsRoot, sentinel } = createFixture();
  const before = snapshot(runsRoot);
  try {
    expect(typeof replayRun).toBe("function");
    const first = await replayRun!(project, RUN_ID);
    expect(first).toMatchObject({
      schemaVersion: 1,
      runId: RUN_ID,
      mode: "schema-only",
      candidates: [
        { nodeId: "worker", name: "accepted", contract: "accepted.v1", valid: true },
        { nodeId: "worker", name: "rejected", contract: "rejected.v1", valid: false },
        { nodeId: "worker", name: "unmapped", contract: "missing.v1", valid: null },
      ],
      skipped: { providerCalls: true, executableValidators: [expect.stringContaining("validator fixture")] },
      drift: expect.arrayContaining([expect.objectContaining({ contract: "accepted.v1" })]),
    });
    expect(first).toEqual(await replayRun!(project, RUN_ID));
    expect(first.drift).not.toEqual(expect.arrayContaining([expect.objectContaining({ contract: "request.v1" })]));
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(path.join(project, "provider-ran.txt"))).toBe(false);
    expect(snapshot(runsRoot)).toEqual(before);

    let stdout = "";
    const exit = await runCli(["node", "nodulus", "inspect", "replay", RUN_ID, "--project", project, "--json"], {
      writeOut: (chunk) => { stdout += chunk; }, writeErr: () => {},
    }, { cwd: project });
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ result: { mode: "schema-only", runId: RUN_ID } });
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(path.join(project, "provider-ran.txt"))).toBe(false);
    expect(snapshot(runsRoot)).toEqual(before);
  } finally {
    try {
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(path.join(project, "provider-ran.txt"))).toBe(false);
    }
    finally { rmSync(project, { recursive: true, force: true }); }
  }
});

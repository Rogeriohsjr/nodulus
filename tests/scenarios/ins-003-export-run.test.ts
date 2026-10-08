import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import * as api from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";

type ExportRun = (projectRoot: string, runId: string) => Promise<Record<string, unknown>>;
const exportRun = (api as unknown as { exportRunDiagnostic?: ExportRun }).exportRunDiagnostic;
const RUN_ID = "841c1ff4-31f1-4a02-a2bc-84d298fad913";
const PRIVATE_MARKERS = ["PRIVATE_REQUEST_7b1", "PRIVATE_PROMPT_8c2", "PRIVATE_ANSWER_9d3", "PRIVATE_TRANSCRIPT_a44", "PRIVATE_SCHEMA_55e", "PRIVATE_DEFAULT_66f", "PRIVATE_CAPABILITY_TOKEN_77g", "PRIVATE_EVENT_CODE_sensitive", "PRIVATE_EVENT_TYPE_sensitive", "PRIVATE_OPERATION_sensitive", "fixture-secret-token"];

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

function createFixture(): { project: string; runsRoot: string } {
  const project = createInitializedProject("ins-003 export café project");
  const runsRoot = path.join(project, ".nodulus", "runs");
  write(project, "run.json", JSON.stringify({ schemaVersion: 1, engineVersion: "1.0.0", runId: RUN_ID, workflowId: "build", phase: "execution", status: "success", activeNode: null, completedNodes: ["worker"], attempt: 1 }));
  write(project, "context/definitions.json", JSON.stringify({
    schemaVersion: 1,
    engineVersion: "1.0.0",
    workflow: { id: "build", version: "1", nodes: ["worker"], schema: { type: "object", properties: { result: { type: "string" } } } },
    nodes: [{ id: "worker", providerProfile: "profile-private-name", contract: "result.v1", source: "nodes/worker.json" }],
    contracts: { "result.v1": { type: "object", description: "PRIVATE_SCHEMA_55e", default: "PRIVATE_DEFAULT_66f", examples: ["C:\\Users\\someone\\private.json"], properties: { result: { type: "string" } } } },
    providerProfiles: { "profile-private-name": { kind: "codex", model: "C:\\Users\\someone\\private-model", capabilities: ["PRIVATE_CAPABILITY_TOKEN_77g"], sandbox: "read-only" } },
    projectRoot: project,
    settings: { apiKey: "fixture-secret-token", providerProfiles: { fixture: { model: "fixture" } } },
  }));
  write(project, "events.jsonl", [
    { event: "node.started", sequence: 1, nodeId: "worker", attempt: 1 },
    { event: "provider.call.started", sequence: 2, callId: "018bb9a5-9e6e-4a66-9000-000000000013", nodeId: "worker", attempt: 1, operation: "invoke", refs: { promptRef: "calls/018bb9a5-9e6e-4a66-9000-000000000013/request.json", responseRef: "calls/018bb9a5-9e6e-4a66-9000-000000000013/transport.json", invocationRef: "nodes/worker/attempt-001/invocation.json" } },
    { event: "provider.call.completed", sequence: 3, callId: "018bb9a5-9e6e-4a66-9000-000000000013", nodeId: "worker", attempt: 1, operation: "PRIVATE_OPERATION_sensitive", failed: false, elapsedMs: 12 },
    { event: "node.validation.completed", sequence: 4, nodeId: "worker", attempt: 1, valid: true, validationRef: "nodes/worker/attempt-001/validation.json" },
    { event: "PRIVATE_EVENT_TYPE_sensitive", sequence: 5, nodeId: "worker", artifactNames: ["result"], code: "PRIVATE_EVENT_CODE_sensitive" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  write(project, "nodes/worker/attempt-001/invocation.json", JSON.stringify({ prompt: "PRIVATE_PROMPT_8c2", request: "PRIVATE_REQUEST_7b1", answer: "PRIVATE_ANSWER_9d3", transcript: "PRIVATE_TRANSCRIPT_a44", transcriptPath: "C:\\Users\\someone\\secret\\transcript.txt", executable: "C:\\Users\\someone\\bin\\provider.exe" }));
  write(project, "calls/018bb9a5-9e6e-4a66-9000-000000000013/request.json", JSON.stringify({ prompt: "PRIVATE_PROMPT_8c2", request: "PRIVATE_REQUEST_7b1", credential: "fixture-secret-token" }));
  write(project, "calls/018bb9a5-9e6e-4a66-9000-000000000013/transport.json", JSON.stringify({ response: "PRIVATE_ANSWER_9d3", transcript: "PRIVATE_TRANSCRIPT_a44" }));
  write(project, "nodes/worker/attempt-001/validation.json", JSON.stringify({ valid: true, errors: [], validator: "C:\\Users\\someone\\scripts\\validator.cmd" }));
  write(project, "nodes/worker/artifacts/result.json", JSON.stringify({ name: "result", contract: "result.v1", data: { summary: "accepted" } }));
  write(project, "result.json", JSON.stringify({ runId: RUN_ID, status: "success", artifacts: [{ name: "result", contract: "result.v1", data: { summary: "accepted" } }] }));
  return { project, runsRoot };
}

test("INS-003 exports a deterministic versioned portable diagnostic while redacting private content and preserving the saved run", async () => {
  const { project, runsRoot } = createFixture();
  const before = snapshot(runsRoot);
  try {
    expect(typeof exportRun).toBe("function");
    const first = await exportRun!(project, RUN_ID);
    const second = await exportRun!(project, RUN_ID);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      run: { runId: RUN_ID, status: "success", phase: "execution", engineVersion: "1.0.0", workflowId: "build" },
      definitions: expect.objectContaining({ workflow: expect.objectContaining({ id: "build" }), nodes: expect.any(Array), contracts: expect.objectContaining({ "result.v1": { type: "object", propertyCount: 1 } }) }),
      timeline: expect.arrayContaining([expect.objectContaining({ event: "provider.call.started", nodeId: "worker", attempt: 1 })]),
      attempts: expect.arrayContaining([expect.objectContaining({ nodeId: "worker", attempt: 1 })]),
      acceptance: expect.arrayContaining([expect.objectContaining({ nodeId: "worker", valid: true })]),
      redactions: expect.objectContaining({ enabled: true, omitted: expect.arrayContaining([expect.stringContaining("prompt")]) }),
    });
    const serialized = JSON.stringify(first);
    expect(first.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "REDACTED_EVENT_TYPE", code: "REDACTED_DIAGNOSTIC_CODE" }),
      expect.objectContaining({ event: "provider.call.completed", operation: "REDACTED_OPERATION" }),
      expect.objectContaining({ event: "provider.call.started", operation: "invoke" }),
    ]));
    for (const marker of PRIVATE_MARKERS) expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("C:\\Users\\someone");
    expect(serialized).not.toContain("private.json");
    expect(serialized).not.toContain("profile-private-name");
    expect(serialized).not.toContain("private-model");
    expect(serialized).not.toContain(project);
    expect(serialized).not.toContain("transcript.txt");
    expect(serialized).toContain("nodes/worker/attempt-001/validation.json");
    expect(snapshot(runsRoot)).toEqual(before);
    expect(existsSync(path.join(runsRoot, RUN_ID, "export.json"))).toBe(false);

    let stdout = "";
    const exit = await runCli(["node", "nodulus", "inspect", "export", RUN_ID, "--project", project, "--json"], {
      writeOut: (chunk) => { stdout += chunk; }, writeErr: () => {},
    }, { cwd: project });
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ result: { schemaVersion: 1, run: { runId: RUN_ID } } });
    expect(JSON.stringify(JSON.parse(stdout))).not.toContain("PRIVATE_");
    expect(snapshot(runsRoot)).toEqual(before);
  } finally {
    try { expect(snapshot(runsRoot)).toEqual(before); }
    finally { rmSync(project, { recursive: true, force: true }); }
  }
});

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import * as api from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";

type InspectRun = (projectRoot: string, runId: string) => Promise<Record<string, unknown>>;
const inspectRun = (api as unknown as { inspectRun?: InspectRun }).inspectRun;
const RUN_IDS = {
  success: "841c1ff4-31f1-4a02-a2bc-84d298fad901",
  needsInput: "841c1ff4-31f1-4a02-a2bc-84d298fad902",
  error: "841c1ff4-31f1-4a02-a2bc-84d298fad903",
  interrupted: "841c1ff4-31f1-4a02-a2bc-84d298fad904",
} as const;
type RunKind = keyof typeof RUN_IDS;

function write(project: string, runId: string, relative: string, contents: string): void {
  const file = path.join(project, ".nodulus", "runs", runId, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function snapshot(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else result.push(`${path.relative(root, file)}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`);
    }
  };
  visit(root);
  return result.sort();
}

function createFixture(): { project: string; runsRoot: string; providerSentinel: string; validatorSentinel: string } {
  const project = createInitializedProject("ins-002 inspect run");
  const runsRoot = path.join(project, ".nodulus", "runs");
  const providerSentinel = path.join(project, "provider-was-invoked.txt");
  const validatorSentinel = path.join(project, "validator-was-invoked.txt");
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(fixtureDirectory, { recursive: true });
  const providerScript = path.join(fixtureDirectory, process.platform === "win32" ? "provider.cmd" : "provider.mjs");
  const validatorScript = path.join(fixtureDirectory, "validator.mjs");
  if (process.platform === "win32") {
    writeFileSync(providerScript, `@echo off\r\necho called > "${providerSentinel}"\r\nexit /b 97\r\n`, "utf8");
  } else {
    writeFileSync(providerScript, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(providerSentinel)}, "called");\nprocess.exit(97);\n`, "utf8");
    chmodSync(providerScript, 0o755);
  }
  writeFileSync(validatorScript, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(validatorSentinel)}, "called");\nprocess.exit(97);\n`, "utf8");
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  settings.providerProfiles = { fixture: { enabled: true, executable: providerScript } };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const statuses: Record<RunKind, string> = { success: "success", needsInput: "needs_input", error: "error", interrupted: "running" };
  for (const kind of Object.keys(RUN_IDS) as RunKind[]) {
    const runId = RUN_IDS[kind];
    write(project, runId, "run.json", `${JSON.stringify({ schemaVersion: 1, engineVersion: "1.0.0", runId, phase: "execution", status: statuses[kind], activeNode: kind === "success" ? null : "build", completedNodes: kind === "success" ? ["build"] : [], attempt: 2, ...(kind === "needsInput" ? { pendingKind: "node", pendingNodeId: "build", requestId: "pending-1" } : {}) }, null, 2)}\n`);
    const common = [
      { event: "node.started", sequence: 1, nodeId: "build", attempt: 2 },
      { event: "provider.call.started", sequence: 2, callId: "018bb9a5-9e6e-4a66-9000-000000000001", nodeId: "build", attempt: 2, operation: "invoke", refs: { responseRef: "nodes/build/attempt-002/response.raw.txt", validationRef: "nodes/build/attempt-002/validation.json" } },
    ];
    const events = [...common,
      ...(kind !== "interrupted" ? [{ event: "provider.call.completed", sequence: 3, callId: "018bb9a5-9e6e-4a66-9000-000000000001", nodeId: "build", attempt: 2, operation: "invoke", failed: false, elapsedMs: 12, refs: { responseRef: "nodes/build/attempt-002/response.raw.txt", validationRef: "nodes/build/attempt-002/validation.json" } }] : []),
      ...(kind === "success" ? [
        { event: "node.validation.completed", sequence: 4, callId: "018bb9a5-9e6e-4a66-9000-000000000001", nodeId: "build", attempt: 2, valid: true, validationRef: "nodes/build/attempt-002/validation.json" },
        { event: "node.succeeded", sequence: 5, nodeId: "build", artifactNames: ["report"] },
      ] : kind === "error" ? [
        { event: "node.validation.completed", sequence: 4, callId: "018bb9a5-9e6e-4a66-9000-000000000001", nodeId: "build", attempt: 2, valid: false, validationRef: "nodes/build/attempt-002/validation.json" },
        { event: "run.failed", sequence: 5, code: "ARTIFACT_REJECTED" },
      ] : kind === "needsInput" ? [
        { event: "node.validation.completed", sequence: 4, callId: "018bb9a5-9e6e-4a66-9000-000000000001", nodeId: "build", attempt: 2, valid: true, validationRef: "nodes/build/attempt-002/validation.json" },
        { event: "node.needs_input", sequence: 5, nodeId: "build", requestId: "pending-1" },
      ] : []),
    ];
    write(project, runId, "events.jsonl", events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    write(project, runId, "metrics.json", "[]\n");
    write(project, runId, "calls/018bb9a5-9e6e-4a66-9000-000000000001/request.json", JSON.stringify({ callId: "018bb9a5-9e6e-4a66-9000-000000000001", prompt: "private prompt" }));
    if (kind !== "interrupted") write(project, runId, "calls/018bb9a5-9e6e-4a66-9000-000000000001/transport.json", JSON.stringify({ callId: "018bb9a5-9e6e-4a66-9000-000000000001", response: "private response" }));
    write(project, runId, "nodes/build/attempt-002/invocation.json", JSON.stringify({ nodeId: "build", attempt: 2, callId: "018bb9a5-9e6e-4a66-9000-000000000001" }));
    if (kind !== "interrupted") write(project, runId, "nodes/build/attempt-002/validation.json", JSON.stringify({ valid: kind !== "error", ...(kind === "needsInput" ? { outcome: "needs_input" } : {}), errors: kind === "error" ? ["required output missing"] : [], validator: validatorScript }));
    if (kind === "success") {
      write(project, runId, "nodes/build/artifacts/report.json", JSON.stringify({ name: "report", contract: "report.v1", data: { summary: "fixture accepted" } }));
      write(project, runId, "result.json", JSON.stringify({ runId, status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { summary: "fixture accepted" } }] }));
    }
    if (kind === "needsInput") write(project, runId, "pending/request.json", JSON.stringify({ id: "pending-1", questions: [{ id: "confirm", message: "Confirm build target?" }] }));
  }
  return { project, runsRoot, providerSentinel, validatorSentinel };
}

test("INS-002 explains saved success, pause, failure and interruption without invoking tools or changing evidence", async () => {
  const { project, runsRoot, providerSentinel, validatorSentinel } = createFixture();
  const before = snapshot(runsRoot);
  try {
    expect(existsSync(providerSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);
    expect(snapshot(runsRoot)).toEqual(before);
    expect(typeof inspectRun).toBe("function");
    const byKind: Partial<Record<RunKind, Record<string, unknown>>> = {};
    for (const kind of Object.keys(RUN_IDS) as RunKind[]) {
      byKind[kind] = await inspectRun!(project, RUN_IDS[kind]);
    }
    expect(byKind.success).toMatchObject({
      runId: RUN_IDS.success, status: "success", checkpoint: { completedNodes: ["build"] }, timeline: expect.arrayContaining([expect.objectContaining({ event: "provider.call.started", nodeId: "build", attempt: 2 }), expect.objectContaining({ event: "provider.call.completed" }), expect.objectContaining({ event: "node.succeeded", nodeId: "build" })]),
      artifacts: expect.arrayContaining([expect.objectContaining({ nodeId: "build", name: "report" })]),
      validation: expect.arrayContaining([expect.objectContaining({ nodeId: "build", valid: true })]),
      attempts: expect.arrayContaining([expect.objectContaining({ nodeId: "build", attempt: 2 })]),
      callEvidence: expect.arrayContaining([expect.objectContaining({ callId: "018bb9a5-9e6e-4a66-9000-000000000001", nodeId: "build", launched: true })]), nextActions: [],
    });
    expect(byKind.needsInput).toMatchObject({
      runId: RUN_IDS.needsInput, status: "needs_input", pendingRequest: expect.objectContaining({ id: "pending-1" }), nextActions: expect.arrayContaining(["provide_pending_input"]),
      timeline: expect.arrayContaining([expect.objectContaining({ event: "provider.call.started", attempt: 2 })]),
      attempts: expect.arrayContaining([expect.objectContaining({ nodeId: "build", attempt: 2 })]),
    });
    expect(byKind.error).toMatchObject({
      runId: RUN_IDS.error, status: "error", nextActions: expect.arrayContaining(["inspect_attempts", "start_new_run"]),
      timeline: expect.arrayContaining([expect.objectContaining({ event: "run.failed" })]),
      uncertainty: expect.any(Array), validation: expect.arrayContaining([expect.objectContaining({ nodeId: "build", valid: false })]),
      attempts: expect.arrayContaining([expect.objectContaining({ nodeId: "build", attempt: 2 })]),
      callEvidence: expect.arrayContaining([expect.objectContaining({ callId: "018bb9a5-9e6e-4a66-9000-000000000001", status: "completed" })]),
    });
    expect(byKind.interrupted).toMatchObject({
      runId: RUN_IDS.interrupted, status: "running", nextActions: expect.arrayContaining(["inspect_attempts", "do_not_replay_uncertain_call"]),
      uncertainty: expect.arrayContaining([expect.stringContaining("uncertain")]),
      timeline: expect.arrayContaining([expect.objectContaining({ event: "provider.call.started", attempt: 2 })]),
      attempts: expect.arrayContaining([expect.objectContaining({ nodeId: "build", attempt: 2 })]),
      callEvidence: expect.arrayContaining([expect.objectContaining({ callId: "018bb9a5-9e6e-4a66-9000-000000000001", status: "incomplete" })]),
    });
    expect(await inspectRun!(project, RUN_IDS.error)).toEqual(byKind.error);

    const pausedEventsPath = path.join(runsRoot, RUN_IDS.needsInput, "events.jsonl");
    const pausedEvents = readFileSync(pausedEventsPath, "utf8");
    const pausedTransportPath = path.join(runsRoot, RUN_IDS.needsInput, "calls", "018bb9a5-9e6e-4a66-9000-000000000001", "transport.json");
    const pausedTransport = readFileSync(pausedTransportPath, "utf8");
    const uncertainPauseEvents = pausedEvents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event !== "provider.call.completed" && event.event !== "node.validation.completed");
    write(project, RUN_IDS.needsInput, "events.jsonl", `${uncertainPauseEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
    rmSync(pausedTransportPath);
    const uncertainPause = await inspectRun!(project, RUN_IDS.needsInput);
    write(project, RUN_IDS.needsInput, "events.jsonl", pausedEvents);
    writeFileSync(pausedTransportPath, pausedTransport, "utf8");
    expect(uncertainPause).toMatchObject({
      status: "needs_input",
      nextActions: expect.arrayContaining(["do_not_replay_uncertain_call"]),
    });
    expect(uncertainPause.nextActions).not.toContain("provide_pending_input");

    const errorValidationPath = path.join(runsRoot, RUN_IDS.error, "nodes", "build", "attempt-002", "validation.json");
    const errorValidation = readFileSync(errorValidationPath, "utf8");
    write(project, RUN_IDS.error, "nodes/build/attempt-002/validation.json", JSON.stringify({ valid: true, errors: [] }));
    const errorEventsPath = path.join(runsRoot, RUN_IDS.error, "events.jsonl");
    const errorEvents = readFileSync(errorEventsPath, "utf8");
    const mispointedValidationEvents = errorEvents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((event) => event.event === "node.validation.completed" ? { ...event, validationRef: "nodes/build/attempt-001/validation.json" } : event);
    const previousValidationPath = path.join(runsRoot, RUN_IDS.error, "nodes", "build", "attempt-001", "validation.json");
    const hadPreviousValidation = existsSync(previousValidationPath);
    write(project, RUN_IDS.error, "events.jsonl", `${mispointedValidationEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
    write(project, RUN_IDS.error, "nodes/build/attempt-001/validation.json", JSON.stringify({ valid: true, errors: [] }));
    const contradictoryValidation = await inspectRun!(project, RUN_IDS.error);
    write(project, RUN_IDS.error, "events.jsonl", errorEvents);
    write(project, RUN_IDS.error, "nodes/build/attempt-002/validation.json", errorValidation);
    if (!hadPreviousValidation) rmSync(previousValidationPath);
    expect(contradictoryValidation.validation).toEqual([]);
    expect(contradictoryValidation.diagnostics).toMatchObject({ messages: expect.arrayContaining([expect.stringContaining("validation")]) });

    write(project, RUN_IDS.error, "nodes/build/attempt-002/validation.json", JSON.stringify({ valid: true, errors: [] }));
    const conflictingValidation = await inspectRun!(project, RUN_IDS.error);
    write(project, RUN_IDS.error, "nodes/build/attempt-002/validation.json", errorValidation);
    expect(conflictingValidation.validation).toEqual([]);
    expect(conflictingValidation.diagnostics).toMatchObject({ messages: expect.arrayContaining([expect.stringContaining("contradicts")]) });

    let stdout = "";
    const exit = await runCli(["node", "nodulus", "inspect", "run", RUN_IDS.error, "--project", project, "--json"], {
      writeOut: (chunk) => { stdout += chunk; }, writeErr: () => {},
    }, { cwd: project });
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, status: "success", runId: RUN_IDS.error, result: { status: "error", nextActions: expect.any(Array) } });
    expect(snapshot(runsRoot)).toEqual(before);
    expect(existsSync(providerSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);
  } finally {
    try {
      expect(snapshot(runsRoot)).toEqual(before);
      expect(existsSync(providerSentinel)).toBe(false);
      expect(existsSync(validatorSentinel)).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
});

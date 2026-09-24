import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IntakeRequest } from "../../src/application/intake.js";
import type { ProviderInvocation, ProviderPort } from "../../src/application/run-workflow.js";
import { createInitializedProject } from "./intake-project.js";

export type ClarificationProject = { project: string; providerPath: string; callLog: string };

export function createClarificationProject(label: string): ClarificationProject {
  const project = createInitializedProject(label);
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(fixtureDirectory, { recursive: true });
  const providerPath = path.join(fixtureDirectory, "provider.mjs");
  const callLog = path.join(fixtureDirectory, "calls.jsonl");
  writeFileSync(providerPath, providerFixtureSource(), "utf8");

  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 1,
    id: "example",
    inputs: { goal: { contract: "goal.v1" } },
    nodes: ["analyze", "build", "review"],
  });
  const schemas: Record<string, unknown> = {
    "goal.v1": { type: "object", required: ["target"], properties: { target: { type: "string", minLength: 1 } }, additionalProperties: false },
    "finding.v1": { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false },
    "implementation.v1": { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false },
    "review.v1": { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false },
  };
  for (const [contract, schema] of Object.entries(schemas)) {
    writeJson(project, `.nodulus/contracts/${contract}.schema.json`, schema);
  }

  const nodeDefinitions = [
    { id: "analyze", instructions: ".nodulus/instructions/analyze.md", inputs: { goal: { from: "caller.goal", contract: "goal.v1" } }, output: "findings", contract: "finding.v1" },
    { id: "build", instructions: ".nodulus/instructions/build.md", inputs: { findings: { from: "analyze.findings", contract: "finding.v1" } }, output: "implementation", contract: "implementation.v1" },
    { id: "review", instructions: ".nodulus/instructions/review.md", inputs: { implementation: { from: "build.implementation", contract: "implementation.v1" } }, output: "review", contract: "review.v1" },
  ];
  for (const node of nodeDefinitions) {
    writeJson(project, `.nodulus/nodes/${node.id}.json`, {
      schemaVersion: 1,
      id: node.id,
      providerProfile: "fixture",
      instructions: [node.instructions],
      inputs: node.inputs,
      expectedOutputs: [{ name: node.output, contract: node.contract }],
    });
    writeFileSync(path.join(project, node.instructions), `## ${node.id} instructions\nHandle ${node.id} stage.\n`, "utf8");
  }

  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles.fixture = {
    enabled: true,
    executable: providerPath,
    model: "fixture-model",
    timeoutMs: 5000,
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { project, providerPath, callLog };
}

export function configureSinglePauseNode(project: string): void {
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 1,
    id: "example",
    inputs: { goal: { contract: "goal.v1" } },
    nodes: ["build"],
  });
  const buildNode = JSON.parse(readFileSync(path.join(project, ".nodulus", "nodes", "build.json"), "utf8"));
  buildNode.inputs = { request: { from: "request", contract: "request.v1" } };
  writeJson(project, ".nodulus/nodes/build.json", buildNode);
}

export function createClarificationRunRequest(
  project: string,
  callerInputs: Record<string, unknown> = { goal: { target: "fixture goal" } },
  referencesFile?: string,
): IntakeRequest {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline", text: "Build the requested deliverable." }],
    ...(callerInputs ? { callerInputs } : {}),
    ...(referencesFile ? { referencesFile } : {}),
  };
}

export function fixtureProvider(project: string): ProviderPort {
  return {
    async invoke(invocation: ProviderInvocation): Promise<string> {
      const executable = String(invocation.providerProfile.executable);
      const child = spawnSync(process.execPath, [executable], {
        cwd: project,
        input: JSON.stringify(invocation),
        encoding: "utf8",
        timeout: 5000,
      });
      if (child.error || child.status !== 0) {
        throw new Error(`Fixture provider failed: ${child.error?.message ?? child.stderr}`);
      }
      return child.stdout;
    },
    isAvailable(profile) {
      return existsSync(String(profile.executable));
    },
  };
}

export function readCalls(callLog: string): Array<{ nodeId: string; inputs: Record<string, unknown>; answers?: Record<string, unknown> }> {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function writeJson(project: string, relative: string, value: unknown): void {
  writeFileSync(path.join(project, relative), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function cleanupClarificationProject(project: string): void {
  rmSync(project, { recursive: true, force: true });
}

export function runFreshWorkflowDriver(args: string[], cwd: string): SpawnSyncReturns<string> {
  const driverPath = new URL("../fixtures/workflow-driver.mjs", import.meta.url);
  return spawnSync(process.execPath, [fileURLToPath(driverPath), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function providerFixtureSource(): string {
  return [
    "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "let raw = '';",
    "for await (const chunk of process.stdin) raw += chunk;",
    "const invocation = JSON.parse(raw);",
    "const logPath = path.join(process.cwd(), '.nodulus', 'fixtures', 'calls.jsonl');",
    "const prior = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\\n').filter(Boolean).map(JSON.parse) : [];",
    "const priorBuildCalls = prior.filter((call) => call.nodeId === 'build').length;",
    "appendFileSync(logPath, JSON.stringify({ nodeId: invocation.nodeId, inputs: invocation.inputs, ...(invocation.answers ? { answers: invocation.answers } : {}) }) + '\\n');",
    "let response;",
    "if (invocation.nodeId === 'analyze') response = { status: 'success', artifacts: [{ name: 'findings', contract: 'finding.v1', data: { text: 'analysis findings' } }] };",
    "else if (invocation.nodeId === 'build' && priorBuildCalls === 0) response = { status: 'needs_input', request: { id: 'provider-q1', questions: [{ id: 'confirmed', message: 'Confirm the target?' }], answerContract: { type: 'object', required: ['confirmed'], properties: { confirmed: { type: 'boolean', const: true } }, additionalProperties: false } } };",
    "else if (invocation.nodeId === 'build' && priorBuildCalls === 1) response = { status: 'needs_input', request: { id: 'provider-q2', questions: [{ id: 'revision', message: 'Provide a revision label.' }], answerContract: { type: 'object', required: ['revision'], properties: { revision: { type: 'string', minLength: 1 } }, additionalProperties: false } } };",
    "else if (invocation.nodeId === 'build') response = { status: 'success', artifacts: [{ name: 'implementation', contract: 'implementation.v1', data: { text: 'built implementation' } }] };",
    "else if (invocation.nodeId === 'review') response = { status: 'success', artifacts: [{ name: 'review', contract: 'review.v1', data: { text: 'final review' } }] };",
    "else response = { status: 'error', error: { code: 'UNEXPECTED_NODE', message: invocation.nodeId } };",
    "process.stdout.write(JSON.stringify(response));",
    "",
  ].join("\n");
}

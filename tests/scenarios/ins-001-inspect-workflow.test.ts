import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import * as nodulusApi from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureSequenceProject, readProjectJson, setNodeInput, writeJson } from "../support/workflow-sequence.js";

type InspectWorkflow = (projectRoot: string, workflowId: string) => Promise<unknown>;
const inspectWorkflow = (nodulusApi as unknown as { inspectWorkflow?: InspectWorkflow }).inspectWorkflow;

function snapshotTree(root: string): Array<{ relativePath: string; sha256: string }> {
  const files: Array<{ relativePath: string; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push({ relativePath: `${path.relative(root, entryPath)}${path.sep}`, sha256: "directory" });
        visit(entryPath);
      } else files.push({
        relativePath: path.relative(root, entryPath),
        sha256: createHash("sha256").update(readFileSync(entryPath)).digest("hex"),
      });
    }
  };
  visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function createProviderFixture(project: string, sentinel: string): string {
  const directory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    const executable = path.join(directory, "codex-fixture.cmd");
    writeFileSync(executable, `@echo off\r\necho invoked > "${sentinel}"\r\nexit /b 97\r\n`, "utf8");
    return executable;
  }
  const executable = path.join(directory, "codex-fixture.mjs");
  writeFileSync(executable, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "invoked");\nprocess.exit(97);\n`, "utf8");
  chmodSync(executable, 0o755);
  return executable;
}

function setInspectionPolicies(project: string, invocationSentinel: string, validatorSentinel: string): void {
  const settings = readProjectJson(project, ".nodulus/settings.json");
  settings.providerProfiles.fixture = {
    enabled: true,
    executable: createProviderFixture(project, invocationSentinel),
    kind: "codex",
    model: "captured-model",
    timeoutMs: 5000,
    capabilities: ["responseRepair"],
    sandbox: "read-only",
    reasoningEffort: "medium",
  };
  writeJson(project, ".nodulus/settings.json", settings);

  const build = readProjectJson(project, ".nodulus/nodes/build.json");
  build.expectedOutputs[0].validator = ".nodulus/validators/build.mjs";
  build.expectedOutputs[0].validatorTimeoutMs = 1800;
  writeJson(project, ".nodulus/nodes/build.json", build);
  mkdirSync(path.join(project, ".nodulus", "validators"), { recursive: true });
  writeFileSync(
    path.join(project, ".nodulus", "validators", "build.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(validatorSentinel)}, "invoked");\nprocess.stdout.write('{"valid":false,"errors":["unexpected validator execution"]}');\n`,
    "utf8",
  );
}

test("INS-001 inspects the resolved workflow and policies without invoking its provider", async () => {
  const project = createInitializedProject("ins-001 inspect workflow");
  configureSequenceProject(project);
  const invocationSentinel = path.join(project, "provider-was-invoked.txt");
  const validatorSentinel = path.join(project, "validator-was-invoked.txt");
  setInspectionPolicies(project, invocationSentinel, validatorSentinel);
  const runsDirectory = path.join(project, ".nodulus", "runs");
  mkdirSync(path.join(runsDirectory, "preexisting-run"), { recursive: true });
  writeFileSync(path.join(runsDirectory, "preexisting-run", "evidence.json"), "{\"status\":\"fixture\"}\n", "utf8");
  const savedRunsBefore = snapshotTree(runsDirectory);
  const output: string[] = [];
  const errors: string[] = [];
  let providerInvocations = 0;
  try {
    let apiResult: unknown;
    if (inspectWorkflow) apiResult = await inspectWorkflow(project, "example");
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(invocationSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);
    if (apiResult !== undefined) expect(apiResult).toMatchObject({
      workflow: {
        id: "example",
        sourcePath: path.join(project, ".nodulus", "workflows", "example.json"),
        nodes: ["analyze", "build", "review"],
      },
      nodes: [
        {
          id: "analyze",
          sourcePath: path.join(project, ".nodulus", "nodes", "analyze.json"),
          instructionPaths: [path.join(project, ".nodulus", "instructions", "analyze.md")],
          providerProfile: "fixture",
          effectiveProfile: {
            enabled: true,
            kind: "codex",
            model: "captured-model",
            timeoutMs: 5000,
            capabilities: ["responseRepair"],
            sandbox: "read-only",
            reasoningEffort: "medium",
          },
          inputs: { request: { from: "request", contract: "request.v1" } },
          expectedOutputs: [{ name: "findings", contract: "finding.v1" }],
        },
        {
          id: "build",
          sourcePath: path.join(project, ".nodulus", "nodes", "build.json"),
          inputs: { findings: { from: "analyze.findings", contract: "finding.v1" } },
          effectiveProfile: expect.objectContaining({ timeoutMs: 5000 }),
          expectedOutputs: [{
            name: "implementation",
            contract: "implementation.v1",
            validator: ".nodulus/validators/build.mjs",
            validatorTimeoutMs: 1800,
          }],
        },
        {
          id: "review",
          sourcePath: path.join(project, ".nodulus", "nodes", "review.json"),
          inputs: { implementation: { from: "build.implementation", contract: "implementation.v1" } },
          expectedOutputs: [{ name: "review", contract: "review.v1" }],
        },
      ],
      contracts: {
        "request.v1": { sourcePath: null, schema: { type: "string", minLength: 1 } },
        "finding.v1": { sourcePath: path.join(project, ".nodulus", "contracts", "finding.v1.schema.json"), schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false } },
        "implementation.v1": { sourcePath: path.join(project, ".nodulus", "contracts", "implementation.v1.schema.json"), schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false } },
        "review.v1": { sourcePath: path.join(project, ".nodulus", "contracts", "review.v1.schema.json"), schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false } },
      },
    });

    const exitCode = await runCli(
      ["node", "nodulus", "inspect", "workflow", "example", "--project", project, "--json"],
      { writeOut: (message) => output.push(message), writeErr: (message) => errors.push(message) },
      {
        provider: {
          async invoke() {
            providerInvocations += 1;
            throw new Error(`Inspection must not invoke a provider; sentinel: ${invocationSentinel}`);
          },
        },
      },
    );

    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(providerInvocations).toBe(0);
    expect(existsSync(invocationSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);
    expect(typeof inspectWorkflow).toBe("function");
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toHaveLength(1);
    const envelope = JSON.parse(output[0]) as {
      schemaVersion: number;
      status: string;
      runId: string | null;
      result: Record<string, unknown>;
    };
    expect(envelope).toMatchObject({ schemaVersion: 1, status: "success", runId: null });
    expect(envelope.result).toMatchObject({
      workflow: {
        id: "example",
        sourcePath: path.join(project, ".nodulus", "workflows", "example.json"),
        nodes: ["analyze", "build", "review"],
      },
      nodes: [
        {
          id: "analyze",
          providerProfile: "fixture",
          effectiveProfile: {
            enabled: true,
            kind: "codex",
            model: "captured-model",
            timeoutMs: 5000,
            capabilities: ["responseRepair"],
            sandbox: "read-only",
            reasoningEffort: "medium",
          },
          inputs: { request: { from: "request", contract: "request.v1" } },
          sourcePath: path.join(project, ".nodulus", "nodes", "analyze.json"),
          instructionPaths: [path.join(project, ".nodulus", "instructions", "analyze.md")],
          expectedOutputs: [{ name: "findings", contract: "finding.v1" }],
        },
        {
          id: "build",
          sourcePath: path.join(project, ".nodulus", "nodes", "build.json"),
          inputs: { findings: { from: "analyze.findings", contract: "finding.v1" } },
          effectiveProfile: {
            enabled: true,
            kind: "codex",
            model: "captured-model",
            timeoutMs: 5000,
            capabilities: ["responseRepair"],
            sandbox: "read-only",
            reasoningEffort: "medium",
          },
          expectedOutputs: [{ name: "implementation", contract: "implementation.v1", validator: ".nodulus/validators/build.mjs", validatorPath: path.join(project, ".nodulus", "validators", "build.mjs"), validatorTimeoutMs: 1800 }],
        },
        {
          id: "review",
          sourcePath: path.join(project, ".nodulus", "nodes", "review.json"),
          inputs: { implementation: { from: "build.implementation", contract: "implementation.v1" } },
          expectedOutputs: [{ name: "review", contract: "review.v1" }],
        },
      ],
      contracts: {
        "request.v1": { sourcePath: null, schema: { type: "string", minLength: 1 } },
        "finding.v1": { sourcePath: path.join(project, ".nodulus", "contracts", "finding.v1.schema.json"), schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false } },
        "implementation.v1": { sourcePath: path.join(project, ".nodulus", "contracts", "implementation.v1.schema.json"), schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false } },
        "review.v1": { sourcePath: path.join(project, ".nodulus", "contracts", "review.v1.schema.json"), schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1 } }, additionalProperties: false } },
      },
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("INS-001 reports a structured diagnostic for a workflow with a missing node definition", async () => {
  const project = createInitializedProject("ins-001 missing node");
  configureSequenceProject(project, ["analyze", "build"]);
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 1,
    id: "example",
    nodes: ["analyze", "does-not-exist"],
  });
  const runsDirectory = path.join(project, ".nodulus", "runs");
  mkdirSync(runsDirectory, { recursive: true });
  const savedRunsBefore = snapshotTree(runsDirectory);
  const output: string[] = [];
  let providerInvocations = 0;
  try {
    const exitCode = await runCli(
      ["node", "nodulus", "inspect", "workflow", "example", "--project", project, "--json"],
      { writeOut: (message) => output.push(message), writeErr: () => {} },
      { provider: { async invoke() { providerInvocations += 1; throw new Error("Inspection must not invoke a provider"); } } },
    );

    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(providerInvocations).toBe(0);
    expect(exitCode).toBe(1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toMatchObject({
      schemaVersion: 1,
      status: "error",
      runId: null,
      result: { code: expect.any(String), message: expect.stringContaining("does-not-exist") },
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test.each([
  { label: "unknown source", from: "missing.findings", contract: "finding.v1" },
  { label: "forward source", from: "review.review", contract: "review.v1" },
  { label: "producer contract mismatch", from: "analyze.findings", contract: "implementation.v1" },
])("INS-001 rejects an invalid input mapping with a $label", async ({ from, contract }) => {
  const project = createInitializedProject(`ins-001 invalid mapping ${from}`);
  configureSequenceProject(project);
  const providerSentinel = path.join(project, "provider-was-invoked.txt");
  const validatorSentinel = path.join(project, "validator-was-invoked.txt");
  setInspectionPolicies(project, providerSentinel, validatorSentinel);
  setNodeInput(project, "build", "findings", { from, contract });
  const runsDirectory = path.join(project, ".nodulus", "runs");
  mkdirSync(runsDirectory, { recursive: true });
  const savedRunsBefore = snapshotTree(runsDirectory);
  try {
    await expect(inspectWorkflow!(project, "example")).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(providerSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("INS-001 resolves declared caller-input contracts and reports a missing caller schema", async () => {
  const project = createInitializedProject("ins-001 caller contract");
  configureSequenceProject(project);
  const providerSentinel = path.join(project, "provider-was-invoked.txt");
  const validatorSentinel = path.join(project, "validator-was-invoked.txt");
  setInspectionPolicies(project, providerSentinel, validatorSentinel);
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 1,
    id: "example",
    inputs: {
      goal: { contract: "goal.v1" },
      unusedContext: { contract: "unused-context.v1" },
    },
    nodes: ["analyze", "build", "review"],
  });
  setNodeInput(project, "analyze", "goal", { from: "caller.goal", contract: "goal.v1" });
  writeJson(project, ".nodulus/contracts/goal.v1.schema.json", {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1 } },
    additionalProperties: false,
  });
  writeJson(project, ".nodulus/contracts/unused-context.v1.schema.json", {
    type: "string",
    minLength: 1,
  });
  const runsDirectory = path.join(project, ".nodulus", "runs");
  mkdirSync(runsDirectory, { recursive: true });
  const savedRunsBefore = snapshotTree(runsDirectory);
  try {
    const result = await inspectWorkflow!(project, "example") as {
      workflow: { inputs?: Record<string, unknown> };
      contracts: Record<string, { sourcePath: string | null; schema: unknown }>;
    };
    expect(result.workflow.inputs).toEqual({
      goal: { contract: "goal.v1" },
      unusedContext: { contract: "unused-context.v1" },
    });
    expect(result.contracts["goal.v1"]).toEqual({
      sourcePath: path.join(project, ".nodulus", "contracts", "goal.v1.schema.json"),
      schema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
    });

    expect(result.contracts["unused-context.v1"]).toEqual({
      sourcePath: path.join(project, ".nodulus", "contracts", "unused-context.v1.schema.json"),
      schema: { type: "string", minLength: 1 },
    });
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(providerSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);

    rmSync(path.join(project, ".nodulus", "contracts", "unused-context.v1.schema.json"));
    await expect(inspectWorkflow!(project, "example")).rejects.toMatchObject({
      code: "CONFIGURATION_INVALID",
      message: expect.stringContaining("unused-context.v1"),
    });
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(providerSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);
    rmSync(path.join(project, ".nodulus", "contracts", "goal.v1.schema.json"));
    await expect(inspectWorkflow!(project, "example")).rejects.toMatchObject({
      code: "CONFIGURATION_INVALID",
      message: expect.stringContaining("goal.v1"),
    });
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(providerSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("INS-001 reports the effective Codex sandbox as read-only when none is configured", async () => {
  const project = createInitializedProject("ins-001 codex sandbox default");
  configureSequenceProject(project);
  const providerSentinel = path.join(project, "provider-was-invoked.txt");
  const validatorSentinel = path.join(project, "validator-was-invoked.txt");
  setInspectionPolicies(project, providerSentinel, validatorSentinel);
  const settings = readProjectJson(project, ".nodulus/settings.json");
  settings.providerProfiles.fixture.kind = "codex";
  delete settings.providerProfiles.fixture.sandbox;
  writeJson(project, ".nodulus/settings.json", settings);
  const runsDirectory = path.join(project, ".nodulus", "runs");
  mkdirSync(runsDirectory, { recursive: true });
  const savedRunsBefore = snapshotTree(runsDirectory);
  try {
    const result = await inspectWorkflow!(project, "example") as {
      nodes: Array<{ id: string; effectiveProfile: Record<string, unknown> }>;
    };
    expect(result.nodes[0].effectiveProfile).toMatchObject({ kind: "codex", sandbox: "read-only" });
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(providerSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test.each([
  { label: "undeclared caller input", from: "caller.unknown", contract: "goal.v1" },
  { label: "caller contract mismatch", from: "caller.goal", contract: "review.v1" },
])("INS-001 rejects a $label mapping", async ({ from, contract }) => {
  const project = createInitializedProject(`ins-001 ${from}`);
  configureSequenceProject(project);
  const providerSentinel = path.join(project, "provider-was-invoked.txt");
  const validatorSentinel = path.join(project, "validator-was-invoked.txt");
  setInspectionPolicies(project, providerSentinel, validatorSentinel);
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 1,
    id: "example",
    inputs: { goal: { contract: "goal.v1" } },
    nodes: ["analyze", "build", "review"],
  });
  setNodeInput(project, "analyze", "goal", { from, contract });
  writeJson(project, ".nodulus/contracts/goal.v1.schema.json", { type: "string", minLength: 1 });
  const runsDirectory = path.join(project, ".nodulus", "runs");
  mkdirSync(runsDirectory, { recursive: true });
  const savedRunsBefore = snapshotTree(runsDirectory);
  try {
    await expect(inspectWorkflow!(project, "example")).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(providerSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("INS-001 rejects nodes with no declared outputs as execution preflight does", async () => {
  const project = createInitializedProject("ins-001 empty outputs");
  configureSequenceProject(project);
  writeJson(project, ".nodulus/workflows/example.json", { schemaVersion: 1, id: "example", nodes: ["analyze"] });
  const node = readProjectJson(project, ".nodulus/nodes/analyze.json");
  node.expectedOutputs = [];
  writeJson(project, ".nodulus/nodes/analyze.json", node);
  try {
    await expect(inspectWorkflow!(project, "example")).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test.each([
  { label: "disabled", update: (profile: Record<string, unknown>) => { profile.enabled = false; } },
  { label: "invalid Codex sandbox", update: (profile: Record<string, unknown>) => { profile.kind = "codex"; profile.sandbox = "unrestricted"; } },
])("INS-001 rejects an execution-invalid provider profile ($label)", async ({ label, update }) => {
  const project = createInitializedProject(`ins-001 ${label}`);
  configureSequenceProject(project);
  const settings = readProjectJson(project, ".nodulus/settings.json");
  update(settings.providerProfiles.fixture);
  writeJson(project, ".nodulus/settings.json", settings);
  try {
    await expect(inspectWorkflow!(project, "example")).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test.each([
  { label: "empty instructions", update: (node: Record<string, unknown>) => { node.instructions = []; } },
  { label: "unknown node field", update: (node: Record<string, unknown>) => { node.unrecognized = true; } },
  { label: "zero validator timeout", update: (node: Record<string, unknown>) => { (node.expectedOutputs as Array<Record<string, unknown>>)[0].validatorTimeoutMs = 0; } },
])("INS-001 rejects runtime-schema-invalid node configuration ($label)", async ({ label, update }) => {
  const project = createInitializedProject(`ins-001 malformed ${label}`);
  configureSequenceProject(project);
  const node = readProjectJson(project, ".nodulus/nodes/analyze.json");
  update(node);
  writeJson(project, ".nodulus/nodes/analyze.json", node);
  try {
    await expect(inspectWorkflow!(project, "example")).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { inspectWorkflow, runWorkflow } from "../../src/index.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureSequenceProject, sequenceSuccess, writeJson } from "../support/workflow-sequence.js";

function snapshotTree(root: string): Array<{ relativePath: string; sha256: string }> {
  const entries: Array<{ relativePath: string; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push({ relativePath: `${path.relative(root, entryPath)}${path.sep}`, sha256: "directory" });
        visit(entryPath);
      } else {
        entries.push({
          relativePath: path.relative(root, entryPath),
          sha256: createHash("sha256").update(readFileSync(entryPath)).digest("hex"),
        });
      }
    }
  };
  visit(root);
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function writeNode(project: string, id: string, inputs: Record<string, unknown>, outputName: string, contract: string, validator?: string): void {
  writeJson(project, `.nodulus/nodes/${id}.json`, {
    schemaVersion: 1,
    id,
    providerProfile: "fixture",
    instructions: [`.nodulus/instructions/${id}.md`],
    inputs,
    expectedOutputs: [{ name: outputName, contract, ...(validator === undefined ? {} : { validator }) }],
  });
  writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
}

function configureGraphProject(project: string): { providerSentinel: string; validatorSentinel: string } {
  const providerSentinel = path.join(project, "provider-was-invoked.txt");
  const validatorSentinel = path.join(project, "validator-was-invoked.txt");
  const fixtures = path.join(project, ".nodulus", "fixtures");
  const validators = path.join(project, ".nodulus", "validators");
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(validators, { recursive: true });
  const providerPath = process.platform === "win32" ? path.join(fixtures, "provider.cmd") : path.join(fixtures, "provider.mjs");
  if (process.platform === "win32") {
    writeFileSync(providerPath, `@echo off\r\necho invoked > "${providerSentinel}"\r\nexit /b 97\r\n`, "utf8");
  } else {
    writeFileSync(providerPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(providerSentinel)}, "invoked");\nprocess.exit(97);\n`, "utf8");
    chmodSync(providerPath, 0o755);
  }
  const validatorPath = ".nodulus/validators/root-a.mjs";
  writeFileSync(
    path.join(project, validatorPath),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(validatorSentinel)}, "invoked");\nprocess.stdout.write('{"valid":true}');\n`,
    "utf8",
  );

  const settings = JSON.parse(readFileSync(path.join(project, ".nodulus", "settings.json"), "utf8")) as Record<string, any>;
  settings.providerProfiles.fixture = {
    enabled: true,
    executable: providerPath,
    kind: "codex",
    model: "captured-model",
    timeoutMs: 5000,
    capabilities: [],
    sandbox: "read-only",
    reasoningEffort: "medium",
  };
  writeJson(project, ".nodulus/settings.json", settings);

  const contractSchema = {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1 } },
    additionalProperties: false,
  };
  for (const contract of ["root.v1", "middle.v1", "leaf.v1", "join.v1"]) {
    writeJson(project, `.nodulus/contracts/${contract}.schema.json`, contractSchema);
  }
  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 2,
    id: "example",
    nodes: ["join", "leaf", "middle", "rootB", "rootA"],
    execution: {
      kind: "dag",
      maxConcurrency: 2,
      dependsOn: {
        join: ["middle", "rootB"],
        leaf: ["middle"],
        middle: ["rootA"],
        rootB: [],
        rootA: [],
      },
    },
    outputs: [
      { name: "joined", from: "join.result", contract: "join.v1" },
      { name: "leafResult", from: "leaf.copy", contract: "leaf.v1" },
    ],
  });
  writeNode(project, "rootA", { request: { from: "request", contract: "request.v1" } }, "result", "root.v1", validatorPath);
  writeNode(project, "rootB", { request: { from: "request", contract: "request.v1" } }, "result", "root.v1");
  writeNode(project, "middle", { source: { from: "rootA.result", contract: "root.v1" } }, "result", "middle.v1");
  writeNode(project, "join", { inherited: { from: "rootA.result", contract: "root.v1" } }, "result", "join.v1");
  writeNode(project, "leaf", { inherited: { from: "middle.result", contract: "middle.v1" } }, "copy", "leaf.v1");

  const runsDirectory = path.join(project, ".nodulus", "runs");
  mkdirSync(path.join(runsDirectory, "preexisting-run"), { recursive: true });
  writeFileSync(path.join(runsDirectory, "preexisting-run", "marker.json"), "{\"before\":true}\n", "utf8");
  return { providerSentinel, validatorSentinel };
}

test("PAR-001 inspects a declared DAG without executing providers or validators", async () => {
  const project = createInitializedProject("par-001 café graph project");
  const { providerSentinel, validatorSentinel } = configureGraphProject(project);
  const runsDirectory = path.join(project, ".nodulus", "runs");
  const savedRunsBefore = snapshotTree(runsDirectory);
  let inspection: Record<string, any> | undefined;
  let inspectionError: unknown;
  try {
    try {
      inspection = await inspectWorkflow(project, "example");
    } catch (error) {
      inspectionError = error;
    }

    expect(inspectionError, "PAR-001 must inspect a valid schema-2 graph").toBeUndefined();
    expect(inspection?.workflow).toMatchObject({
      executionSupported: false,
      execution: {
        kind: "dag",
        maxConcurrency: 2,
        dependsOn: {
          join: ["middle", "rootB"],
          leaf: ["middle"],
          middle: ["rootA"],
          rootB: [],
          rootA: [],
        },
      },
      outputs: [
        { name: "joined", from: "join.result", contract: "join.v1" },
        { name: "leafResult", from: "leaf.copy", contract: "leaf.v1" },
      ],
      nodes: ["join", "leaf", "middle", "rootB", "rootA"],
    });
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
    expect(existsSync(providerSentinel)).toBe(false);
    expect(existsSync(validatorSentinel)).toBe(false);

  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("PAR-001 rejects schema-2 execution before provider checks or run writes", async () => {
  const project = createInitializedProject("par-001 schema2 rejection control");
  configureGraphProject(project);
  const runsDirectory = path.join(project, ".nodulus", "runs");
  const savedRunsBefore = snapshotTree(runsDirectory);
  let availabilityChecks = 0;
  let providerCalls = 0;
  try {
    await expect(runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Inspect this graph." }],
    }, {
      isAvailable() {
        availabilityChecks += 1;
        throw new Error("Schema-2 preflight must reject before provider availability checks.");
      },
      async invoke() {
        providerCalls += 1;
        throw new Error("Schema-2 preflight must reject before provider invocation.");
      },
    })).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    expect(availabilityChecks).toBe(0);
    expect(providerCalls).toBe(0);
    expect(snapshotTree(runsDirectory)).toEqual(savedRunsBefore);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("PAR-001 retains schema-1 sequential workflow execution", async () => {
  const project = createInitializedProject("par-001 schema1 sequence control");
  configureSequenceProject(project);
  const responses = [
    sequenceSuccess("analysis", "findings", "finding.v1"),
    sequenceSuccess("implementation", "implementation", "implementation.v1"),
    sequenceSuccess("review", "review", "review.v1"),
  ];
  let calls = 0;
  try {
    const result = await runWorkflow({
      projectRoot: project,
      cwd: project,
      workflow: "example",
      sources: [{ kind: "inline", text: "Analyze the source and deliver a review." }],
    }, {
      async invoke() {
        const response = responses[calls];
        calls += 1;
        if (response === undefined) throw new Error("Unexpected schema-1 provider call.");
        return response;
      },
    });
    expect(result.status).toBe("success");
    expect(calls).toBe(3);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

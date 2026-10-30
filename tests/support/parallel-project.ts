import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readProjectJson, writeJson } from "./workflow-sequence.js";

export type ParallelWorkflowFixture = {
  schemaVersion: number;
  id: string;
  nodes: string[];
  execution: {
    kind: string;
    maxConcurrency: number;
    dependsOn: Record<string, string[]>;
    resources?: Record<string, string[]>;
  };
  outputs: Array<{ name: string; from: string; contract: string }>;
};

export function configureParallelProject(project: string): { providerSentinel: string; validatorSentinel: string } {
  const providerSentinel = path.join(project, "provider-was-invoked.txt");
  const validatorSentinel = path.join(project, "validator-was-invoked.txt");
  const fixtureDirectory = path.join(project, ".nodulus", "fixtures");
  const validatorDirectory = path.join(project, ".nodulus", "validators");
  mkdirSync(fixtureDirectory, { recursive: true });
  mkdirSync(validatorDirectory, { recursive: true });

  const providerPath = process.platform === "win32" ? path.join(fixtureDirectory, "provider.cmd") : path.join(fixtureDirectory, "provider.mjs");
  if (process.platform === "win32") {
    writeFileSync(providerPath, `@echo off\r\necho invoked > "${providerSentinel}"\r\nexit /b 97\r\n`, "utf8");
  } else {
    writeFileSync(providerPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(providerSentinel)}, "invoked");\nprocess.exit(97);\n`, "utf8");
    chmodSync(providerPath, 0o755);
  }
  const settings = JSON.parse(readFileSync(path.join(project, ".nodulus", "settings.json"), "utf8")) as Record<string, unknown>;
  const profiles = settings.providerProfiles as Record<string, Record<string, unknown>>;
  profiles.fixture = {
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

  writeJson(project, ".nodulus/contracts/report.v1.schema.json", {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1 } },
    additionalProperties: false,
  });
  const validatorPath = ".nodulus/validators/prepare.mjs";
  writeFileSync(
    path.join(project, validatorPath),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(validatorSentinel)}, "invoked");\nprocess.stdout.write('{"valid":true,"errors":[]}');\n`,
    "utf8",
  );

  writeJson(project, ".nodulus/workflows/example.json", {
    schemaVersion: 2,
    id: "example",
    nodes: ["join", "audit", "left", "right", "prepare"],
    execution: {
      kind: "dag",
      maxConcurrency: 2,
      dependsOn: {
        prepare: [],
        audit: [],
        left: ["prepare"],
        right: ["prepare"],
        join: ["left", "right"],
      },
      resources: { prepare: [], audit: [], left: [], right: [], join: [] },
    },
    outputs: [
      { name: "joined", from: "join.report", contract: "report.v1" },
      { name: "audit", from: "audit.report", contract: "report.v1" },
    ],
  });
  writeNode(project, "prepare", { request: { from: "request", contract: "request.v1" } }, validatorPath);
  writeNode(project, "audit", { request: { from: "request", contract: "request.v1" } });
  writeNode(project, "left", { report: { from: "prepare.report", contract: "report.v1" } });
  writeNode(project, "right", { report: { from: "prepare.report", contract: "report.v1" } });
  writeNode(project, "join", {
    left: { from: "left.report", contract: "report.v1" },
    right: { from: "right.report", contract: "report.v1" },
  });

  const runsDirectory = path.join(project, ".nodulus", "runs");
  mkdirSync(path.join(runsDirectory, "preexisting-run"), { recursive: true });
  writeFileSync(path.join(runsDirectory, "preexisting-run", "marker.json"), "{\"before\":true}\n", "utf8");
  return { providerSentinel, validatorSentinel };
}

export function readParallelWorkflow(project: string): ParallelWorkflowFixture {
  return readProjectJson(project, ".nodulus/workflows/example.json") as ParallelWorkflowFixture;
}

function writeNode(project: string, id: string, inputs: Record<string, unknown>, validator?: string): void {
  writeJson(project, `.nodulus/nodes/${id}.json`, {
    schemaVersion: 1,
    id,
    providerProfile: "fixture",
    instructions: [`.nodulus/instructions/${id}.md`],
    inputs,
    expectedOutputs: [{ name: "report", contract: "report.v1", ...(validator === undefined ? {} : { validator }) }],
  });
  writeFileSync(path.join(project, ".nodulus", "instructions", `${id}.md`), `Instructions for ${id}.\n`, "utf8");
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runProductionCli } from "../support/production-cli.js";

type ErrorEnvelope = {
  schemaVersion: number;
  status: string;
  runId: string | null;
  result: { code: unknown; message: unknown };
};

function expectMachineError(
  result: ReturnType<typeof runProductionCli>,
  messagePattern: RegExp,
): ErrorEnvelope {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  const output = result.stdout.trim();
  expect(output).not.toBe("");
  expect(() => JSON.parse(output)).not.toThrow();
  expect(result.stderr).not.toMatch(/^\s*at\s+/m);
  expect(result.stdout).not.toMatch(/stack trace/i);
  const envelope = JSON.parse(output) as ErrorEnvelope;
  expect(envelope).toMatchObject({ schemaVersion: 1, status: "error", runId: null });
  expect(typeof envelope.result.code).toBe("string");
  expect((envelope.result.code as string).trim().length).toBeGreaterThan(0);
  expect(typeof envelope.result.message).toBe("string");
  expect((envelope.result.message as string).trim().length).toBeGreaterThan(0);
  expect(envelope.result.message).toMatch(messagePattern);
  return envelope;
}

function createProject(): string {
  const project = mkdtempSync(path.join(tmpdir(), "nodulus-init-004-"));
  mkdirSync(path.join(project, ".nodulus"), { recursive: true });
  return project;
}

test("INIT-004 unknown arguments return one machine-readable error envelope", () => {
  const project = createProject();
  try {
    const result = runProductionCli(["doctor", "--json", "--project", project, "--unknown-option"]);
    expectMachineError(result, /unknown|option|argument/i);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("INIT-004 malformed settings return one machine-readable error envelope", () => {
  const project = createProject();
  try {
    writeFileSync(path.join(project, ".nodulus", "settings.json"), "{\n", "utf8");
    const result = runProductionCli(["doctor", "--json", "--project", project]);
    expectMachineError(result, /settings|json|parse/i);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("INIT-004 invalid settings shape returns one machine-readable error envelope", () => {
  const project = createProject();
  try {
    writeFileSync(
      path.join(project, ".nodulus", "settings.json"),
      `${JSON.stringify({ schemaVersion: 1, defaultWorkflow: "example", providerProfiles: [] })}\n`,
      "utf8",
    );
    const result = runProductionCli(["doctor", "--json", "--project", project]);
    expectMachineError(result, /settings|providerProfiles|shape/i);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

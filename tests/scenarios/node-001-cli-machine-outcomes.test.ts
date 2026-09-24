import { rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { createInitializedProject } from "../support/intake-project.js";
import { scriptedProvider, successResponse, validData } from "../support/node-execution.js";

test("NODE-001 production CLI returns one machine-readable success envelope", async () => {
  const project = createInitializedProject("node-001-cli-success");
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const code = await runCli(
      ["node", "nodulus", "run", "--project", project, "--workflow", "example", "--request", "Machine success request", "--json"],
      { writeOut: (text: string) => stdout.push(text), writeErr: (text: string) => stderr.push(text) },
      { provider: scriptedProvider(successResponse(validData)) },
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toMatchObject({
      schemaVersion: 1,
      status: "success",
      runId: expect.stringMatching(/\S/),
      result: { artifacts: [expect.objectContaining({ name: "example", data: validData })] },
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("NODE-005 production CLI returns needs_input and exit code 2 without terminal success", async () => {
  const project = createInitializedProject("node-005-cli-pause");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const raw = JSON.stringify({
    status: "needs_input",
    request: {
      id: "provider-request-id",
      questions: [{ id: "audience", message: "Who is the audience?" }],
      answerContract: { type: "object", properties: { audience: { type: "string" } }, required: ["audience"] },
    },
  });
  try {
    const code = await runCli(
      ["node", "nodulus", "run", "--project", project, "--workflow", "example", "--request", "Clarify this request", "--json"],
      { writeOut: (text: string) => stdout.push(text), writeErr: (text: string) => stderr.push(text) },
      { provider: scriptedProvider(raw) },
    );
    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toMatchObject({
      schemaVersion: 1,
      status: "needs_input",
      runId: expect.stringMatching(/\S/),
      result: { request: { questions: [{ id: "audience", message: "Who is the audience?" }] } },
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

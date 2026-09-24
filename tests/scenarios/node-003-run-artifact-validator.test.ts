import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import { createRunRequest, configureExpectedOutput, scriptedProvider, successResponse, writeValidator } from "../support/node-execution.js";
import { createInitializedProject } from "../support/intake-project.js";

const schema = {
  type: "object",
  properties: { message: { type: "string", minLength: 1 } },
  required: ["message"],
  additionalProperties: false,
};

const cases = [
  {
    name: "accepts schema-valid data when the real validator accepts",
    message: "accepted",
    script: `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const artifact=JSON.parse(input); process.stdout.write(JSON.stringify({valid:artifact.message==='accepted',errors:[]})); });`,
    expectedStatus: "success",
    expectedCode: undefined,
  },
  {
    name: "rejects schema-valid data when the real validator returns valid=false",
    message: "reject me",
    script: `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const artifact=JSON.parse(input); process.stdout.write(JSON.stringify({valid:artifact.message!=='reject me',errors:['business rule rejected message']})); });`,
    expectedStatus: "error",
    expectedCode: "ARTIFACT_REJECTED",
  },
  {
    name: "distinguishes malformed validator output",
    message: "anything",
    script: `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('not-json'));`,
    expectedStatus: "error",
    expectedCode: "VALIDATOR_INVALID_RESPONSE",
  },
  {
    name: "distinguishes validator nonzero exit",
    message: "anything",
    script: `process.stdin.resume(); process.stdin.on('end', () => process.exit(7));`,
    expectedStatus: "error",
    expectedCode: "VALIDATOR_EXECUTION_FAILED",
  },
  {
    name: "distinguishes validator timeout",
    message: "anything",
    script: "TIMEOUT_FIXTURE",
    expectedStatus: "error",
    expectedCode: "VALIDATOR_TIMEOUT",
  },
] as const;

test.each(cases)("NODE-003 $name", async ({ message, script, expectedStatus, expectedCode }) => {
  const project = createInitializedProject("node-003");
  const markerPath = path.join(project, "timeout-child-survived.marker");
  const validatorSource = script === "TIMEOUT_FIXTURE"
    ? `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(markerPath)}, 'alive'), 350); setInterval(() => {}, 1000);`
    : script;
  const validatorPath = writeValidator(project, "check.mjs", validatorSource);
  configureExpectedOutput(project, {
    name: "example",
    contract: "example.v1",
    schema,
    validator: validatorPath,
    validatorTimeoutMs: expectedCode === "VALIDATOR_TIMEOUT" ? 150 : 2500,
  });
  try {
    const result = await runWorkflow(
      createRunRequest(project),
      scriptedProvider(successResponse({ message })),
    );
    expect(result.status).toBe(expectedStatus);
    const attempt = path.join(project, ".nodulus", "runs", result.runId, "nodes", "example", "attempt-001");
    const validation = JSON.parse(readFileSync(path.join(attempt, "validation.json"), "utf8"));
    if (expectedCode) expect(validation.code).toBe(expectedCode);
    else expect(validation.valid).toBe(true);
    expect(JSON.parse(readFileSync(path.join(attempt, "invocation.json"), "utf8"))).toMatchObject({ validator: validatorPath });
    if (expectedCode === "VALIDATOR_TIMEOUT") {
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      expect(existsSync(markerPath)).toBe(false);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

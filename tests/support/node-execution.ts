import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IntakeRequest } from "../../src/application/intake.js";
import type { ProviderInvocation, ProviderPort } from "../../src/application/run-workflow.js";

export const validData = { message: "validated artifact" };

export function createRunRequest(projectRoot: string, text = "Review this request."): IntakeRequest {
  return {
    projectRoot,
    cwd: projectRoot,
    workflow: "example",
    sources: [{ kind: "inline", text }],
  };
}

export function successResponse(data: unknown = validData, artifactName = "example", contract = "example.v1"): string {
  return JSON.stringify({
    status: "success",
    artifacts: [{ name: artifactName, contract, data }],
  });
}

export function scriptedProvider(response: string | Error, onInvoke?: (invocation: ProviderInvocation) => void): ProviderPort {
  let calls = 0;
  return {
    async invoke(invocation) {
      calls += 1;
      if (calls > 1) throw new Error("Unexpected extra provider invocation.");
      onInvoke?.(invocation);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

export function configureExpectedOutput(
  project: string,
  options: { name: string; contract: string; schema: unknown; validator?: string; validatorTimeoutMs?: number },
): void {
  const nodePath = path.join(project, ".nodulus", "nodes", "example.json");
  const node = JSON.parse(readFileSync(nodePath, "utf8"));
  node.expectedOutputs = [{
    name: options.name,
    contract: options.contract,
    ...(options.validator ? { validator: options.validator } : {}),
    ...(options.validatorTimeoutMs ? { validatorTimeoutMs: options.validatorTimeoutMs } : {}),
  }];
  writeFileSync(nodePath, `${JSON.stringify(node, null, 2)}\n`, "utf8");
  const schemaPath = path.join(project, ".nodulus", "contracts", `${options.contract}.schema.json`);
  writeFileSync(schemaPath, `${JSON.stringify(options.schema, null, 2)}\n`, "utf8");
}

export function writeValidator(project: string, filename: string, source: string): string {
  const directory = path.join(project, ".nodulus", "validators");
  mkdirSync(directory, { recursive: true });
  const relative = `.nodulus/validators/${filename}`;
  writeFileSync(path.join(project, relative), source, "utf8");
  return relative;
}

export function validatorScript(verdict: { valid: boolean; errors: string[] }): string {
  return [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => input += chunk);",
    "process.stdin.on('end', () => {",
    "  const artifact = JSON.parse(input);",
    `  process.stdout.write(${JSON.stringify(JSON.stringify(verdict))});`,
    "});",
    "",
  ].join("\n");
}

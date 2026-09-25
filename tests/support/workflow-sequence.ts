import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IntakeRequest } from "../../src/application/intake.js";

export const sequenceNodes = ["analyze", "build", "review"] as const;

export function configureSequenceProject(project: string, nodeIds: readonly string[] = sequenceNodes): void {
  writeJson(project, ".nodulus/workflows/example.json", { schemaVersion: 1, id: "example", nodes: [...nodeIds] });
  writeJson(project, ".nodulus/contracts/request.v1.schema.json", { type: "string", minLength: 1 });
  const contracts = ["finding.v1", "implementation.v1", "review.v1"];
  for (const contract of contracts) {
    writeJson(project, `.nodulus/contracts/${contract}.schema.json`, {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1 } },
      additionalProperties: false,
    });
  }

  const nodeDefinitions = nodeIds.map((id, index) => {
    const prior = nodeIds[index - 1];
    const inputName = index === 0 ? "request" : index === 1 ? "findings" : "implementation";
    const source = index === 0 ? "request" : `${prior}.${index === 1 ? "findings" : "implementation"}`;
    const inputContract = index === 0 ? "request.v1" : index === 1 ? "finding.v1" : "implementation.v1";
    const outputName = index === 0 ? "findings" : index === 1 ? "implementation" : "review";
    const outputContract = contracts[index];
    return {
      schemaVersion: 1,
      id,
      providerProfile: "fixture",
      instructions: [`.nodulus/instructions/${id}.md`],
      inputs: { [inputName]: { from: source, contract: inputContract } },
      expectedOutputs: [{ name: outputName, contract: outputContract }],
    };
  });

  for (const node of nodeDefinitions) {
    writeJson(project, `.nodulus/nodes/${node.id}.json`, node);
    writeFileSync(path.join(project, ".nodulus", "instructions", `${node.id}.md`), `Instructions for ${node.id}.\n`, "utf8");
  }

  const settingsPath = path.join(project, ".nodulus", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.providerProfiles = {
    fixture: {
      enabled: true,
      executable: process.execPath,
      model: "captured-model",
      timeoutMs: 5000,
    },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function sequenceRunRequest(project: string): IntakeRequest {
  return {
    projectRoot: project,
    cwd: project,
    workflow: "example",
    sources: [{ kind: "inline", text: "Analyze the source and deliver a review." }],
  };
}

export function sequenceSuccess(output: string, name: string, contract: string): string {
  return JSON.stringify({ status: "success", artifacts: [{ name, contract, data: { text: output } }] });
}

export function setNodeInput(project: string, nodeId: string, inputName: string, mapping: unknown): void {
  const relative = `.nodulus/nodes/${nodeId}.json`;
  const node = JSON.parse(readFileSync(path.join(project, relative), "utf8"));
  node.inputs = { [inputName]: mapping };
  writeJson(project, relative, node);
}

export function setNodeInputs(project: string, nodeId: string, inputs: Record<string, unknown>): void {
  const relative = `.nodulus/nodes/${nodeId}.json`;
  const node = JSON.parse(readFileSync(path.join(project, relative), "utf8"));
  node.inputs = inputs;
  writeJson(project, relative, node);
}

export function readProjectJson(project: string, relative: string): any {
  return JSON.parse(readFileSync(path.join(project, relative), "utf8"));
}

export function writeJson(project: string, relative: string, value: unknown): void {
  writeFileSync(path.join(project, relative), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

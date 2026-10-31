import { createHash } from "node:crypto";
import { NodulusError } from "../core/shared/nodulus-error.js";
import type { GraphRunCheckpoint } from "../core/graph-state.js";
import type { IntakeStorage } from "../core/ports/intake-storage.js";
import { validateGraphDefinition } from "../core/workflow-graph.js";
import type { GraphResumeContext } from "../core/graph-resume-evidence.js";

export type CapturedGraphInputs = {
  schemaVersion: 2;
  workflow: string;
  request: string;
  callerInputs: Record<string, unknown>;
  instructions: Array<{ path: string; content: string }>;
};

export type CapturedGraphReference = { path: string; mode: "snapshot" | "workspace"; sha256: string };

export type CapturedGraphContext = {
  context: GraphResumeContext;
  inputs: CapturedGraphInputs;
  references: CapturedGraphReference[];
  definitionsText: string;
  inputsText: string;
  referencesText: string;
};

/** Read and verify only the immutable files captured with a graph run. */
export async function readCapturedGraphContext(
  projectRoot: string,
  runId: string,
  checkpoint: GraphRunCheckpoint,
  expectedEngineVersion: string,
  storage: IntakeStorage,
): Promise<CapturedGraphContext> {
  if (checkpoint.schemaVersion !== 2 || checkpoint.engineVersion !== expectedEngineVersion ||
      checkpoint.runId !== runId || typeof checkpoint.workflow !== "string" || checkpoint.workflow.length === 0 ||
      !isRecord(checkpoint.graph) || !isRecord(checkpoint.graph.callerInputs)) {
    throw invalid(`Graph '${runId}' checkpoint identity is incompatible with captured context.`);
  }

  let definitionsText: string;
  let inputsText: string;
  let referencesText: string;
  let contextValue: unknown;
  let inputsValue: unknown;
  let referencesValue: unknown;
  try {
    [definitionsText, inputsText, referencesText] = await Promise.all([
      storage.readRunFile(projectRoot, runId, "context/definitions.json"),
      storage.readRunFile(projectRoot, runId, "inputs.json"),
      storage.readRunFile(projectRoot, runId, "references.json"),
    ]);
    contextValue = JSON.parse(definitionsText) as unknown;
    inputsValue = JSON.parse(inputsText) as unknown;
    referencesValue = JSON.parse(referencesText) as unknown;
  } catch (error) {
    throw invalid(`Graph '${runId}' has unreadable captured context: ${messageOf(error)}`);
  }

  const contextRecord = isRecord(contextValue) ? contextValue : undefined;
  const workflowRecord = contextRecord && isRecord(contextRecord.workflow) ? contextRecord.workflow : undefined;
  const inputsRecord = isRecord(inputsValue) ? inputsValue : undefined;
  const referencesValid = Array.isArray(referencesValue) && referencesValue.every((reference) => isRecord(reference) &&
    typeof reference.path === "string" && (reference.mode === "workspace" || reference.mode === "snapshot") && isHash(reference.sha256));
  const validatorHashesValid = contextRecord && isRecord(contextRecord.validatorHashes) &&
    Object.values(contextRecord.validatorHashes).every(isHash);
  if (!contextRecord || !workflowRecord || !inputsRecord || !isRecord(inputsRecord.callerInputs) ||
      contextRecord.schemaVersion !== 2 || contextRecord.engineVersion !== expectedEngineVersion ||
      workflowRecord.schemaVersion !== 2 || workflowRecord.id !== checkpoint.workflow ||
      !Array.isArray(contextRecord.nodes) || !Array.isArray(workflowRecord.nodes) || !validatorHashesValid ||
      !isRecord(contextRecord.contracts) || !isRecord(contextRecord.providerProfiles) ||
      inputsRecord.schemaVersion !== 2 || inputsRecord.workflow !== workflowRecord.id || typeof inputsRecord.request !== "string" ||
      !Array.isArray(inputsRecord.instructions) || inputsRecord.instructions.some((instruction) => !isRecord(instruction) ||
        typeof instruction.path !== "string" || typeof instruction.content !== "string") || !referencesValid ||
      contextRecord.nodes.some((node) => !isRecord(node) || typeof node.id !== "string" || typeof node.providerProfile !== "string" ||
        !Array.isArray(node.expectedOutputs) || node.expectedOutputs.some((output) => !isRecord(output) ||
          typeof output.name !== "string" || typeof output.contract !== "string"))) {
    throw invalid(`Graph '${runId}' captured definitions, inputs, or references do not match its checkpoint.`);
  }

  const captured = checkpoint.graph.captured;
  if (!isRecord(captured) || captured.definitionsSha256 !== hash(definitionsText) ||
      captured.inputsSha256 !== hash(inputsText) || captured.referencesSha256 !== hash(referencesText)) {
    throw invalid(`Graph '${runId}' captured files do not match their saved hashes.`);
  }
  const context = contextValue as GraphResumeContext;
  const inputs = inputsValue as CapturedGraphInputs;
  const references = referencesValue as CapturedGraphReference[];
  let validatedWorkflow: GraphResumeContext["workflow"];
  try { validatedWorkflow = validateGraphDefinition(context.workflow as unknown as Record<string, unknown>, context.workflow.id).workflow; }
  catch (error) { throw invalid(`Graph '${runId}' captured definition is invalid: ${messageOf(error)}`); }
  if (!sameJson(validatedWorkflow, context.workflow) || context.nodes.length !== context.workflow.nodes.length ||
      new Set(context.nodes.map((node) => node.id)).size !== context.nodes.length ||
      context.workflow.nodes.some((nodeId) => !context.nodes.some((node) => node.id === nodeId))) {
    throw invalid(`Graph '${runId}' definitions do not match the captured validated workflow.`);
  }
  return { context, inputs, references, definitionsText, inputsText, referencesText };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string): NodulusError {
  return new NodulusError("RUN_STATE_INVALID", message);
}

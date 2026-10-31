import { NodulusError } from "./shared/nodulus-error.js";
import { resolveOutputReference, type OutputDeclaration } from "./workflow-mapping.js";

type JsonObject = Record<string, unknown>;
export type GraphOutputAlias = { name: string; from: string; contract: string };
export type GraphDefinition = {
  schemaVersion: 2;
  id: string;
  nodes: string[];
  inputs?: Record<string, { contract: string }>;
  execution: {
    kind: "dag";
    maxConcurrency: number;
    dependsOn: Record<string, string[]>;
    resources?: Record<string, string[]>;
  };
  outputs: GraphOutputAlias[];
};

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const workflowProperties = new Set(["schemaVersion", "id", "nodes", "inputs", "execution", "outputs"]);
const executionProperties = new Set(["kind", "maxConcurrency", "dependsOn", "resources"]);

/** Validate the strict, read-only graph definition and return each node's transitive ancestors. */
export function validateGraphDefinition(value: JsonObject, workflowId: string): {
  workflow: GraphDefinition;
  ancestors: Map<string, Set<string>>;
} {
  const fail = (message: string): never => { throw new NodulusError("CONFIGURATION_INVALID", message); };
  if (Object.keys(value).some((key) => !workflowProperties.has(key))) fail(`Workflow '${workflowId}' has an unknown schema-2 property.`);
  if (value.schemaVersion !== 2 || value.id !== workflowId || !Array.isArray(value.nodes) || value.nodes.length === 0 ||
      value.nodes.some((nodeId) => typeof nodeId !== "string" || !safeId.test(nodeId)) || new Set(value.nodes).size !== value.nodes.length) {
    fail(`Workflow '${workflowId}' has an invalid schema-2 ID or node list.`);
  }
  const inputs = validateCallerInputs(value.inputs, workflowId);
  if (!isRecord(value.execution)) fail(`Workflow '${workflowId}' has an invalid graph execution definition.`);
  const executionValue = value.execution as JsonObject;
  if (Object.keys(executionValue).some((key) => !executionProperties.has(key)) ||
      executionValue.kind !== "dag" || !Number.isSafeInteger(executionValue.maxConcurrency) || Number(executionValue.maxConcurrency) <= 0 ||
      !isRecord(executionValue.dependsOn)) {
    fail(`Workflow '${workflowId}' has an invalid graph execution definition.`);
  }
  const nodeIds = value.nodes as string[];
  const dependencyMap = executionValue.dependsOn as JsonObject;
  if (Object.keys(dependencyMap).length !== nodeIds.length || nodeIds.some((nodeId) => !Object.hasOwn(dependencyMap, nodeId)) ||
      Object.keys(dependencyMap).some((nodeId) => !nodeIds.includes(nodeId))) {
    fail(`Workflow '${workflowId}' must declare dependencies for every node and no others.`);
  }
  const dependsOn: Record<string, string[]> = {};
  for (const nodeId of nodeIds) {
    const predecessors = dependencyMap[nodeId];
    if (!Array.isArray(predecessors) || predecessors.some((predecessor) => typeof predecessor !== "string" || !nodeIds.includes(predecessor)) ||
        new Set(predecessors).size !== predecessors.length || predecessors.includes(nodeId)) {
      fail(`Workflow '${workflowId}' has invalid dependencies for node '${nodeId}'.`);
    }
    dependsOn[nodeId] = predecessors as string[];
  }
  const resources = validateResources(executionValue.resources, nodeIds, workflowId);
  const execution = {
    kind: "dag" as const,
    maxConcurrency: executionValue.maxConcurrency as number,
    dependsOn,
    ...(resources === undefined ? {} : { resources }),
  };
  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): Set<string> => {
    const cached = ancestors.get(nodeId);
    if (cached) return cached;
    if (visiting.has(nodeId)) fail(`Workflow '${workflowId}' contains a dependency cycle at node '${nodeId}'.`);
    visiting.add(nodeId);
    const result = new Set<string>();
    for (const predecessor of dependsOn[nodeId] ?? []) {
      result.add(predecessor);
      for (const ancestor of visit(predecessor)) result.add(ancestor);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    ancestors.set(nodeId, result);
    return result;
  };
  for (const nodeId of nodeIds) visit(nodeId);
  if (visited.size !== nodeIds.length) fail(`Workflow '${workflowId}' has an invalid graph.`);

  if (!Array.isArray(value.outputs) || value.outputs.length === 0) fail(`Workflow '${workflowId}' must declare at least one output alias.`);
  const outputValues = value.outputs as unknown[];
  const outputNames = new Set<string>();
  const outputs: GraphOutputAlias[] = outputValues.map((candidate: unknown) => {
    if (!isRecord(candidate)) fail(`Workflow '${workflowId}' has an invalid output alias.`);
    const alias = candidate as JsonObject;
    if (Object.keys(alias).some((key) => !["name", "from", "contract"].includes(key)) ||
        typeof alias.name !== "string" || !safeId.test(alias.name) || typeof alias.from !== "string" ||
        typeof alias.contract !== "string" || !safeId.test(alias.contract)) {
      fail(`Workflow '${workflowId}' has an invalid output alias.`);
    }
    if (outputNames.has(alias.name as string)) fail(`Workflow '${workflowId}' has duplicate output alias '${String(alias.name)}'.`);
    outputNames.add(alias.name as string);
    return { name: alias.name as string, from: alias.from as string, contract: alias.contract as string };
  });
  return {
    workflow: {
      schemaVersion: 2,
      id: workflowId,
      nodes: nodeIds,
      ...(inputs === undefined ? {} : { inputs }),
      execution,
      outputs,
    },
    ancestors,
  };
}

function validateCallerInputs(candidate: unknown, workflowId: string): Record<string, { contract: string }> | undefined {
  if (candidate === undefined) return undefined;
  if (!isRecord(candidate)) throw new NodulusError("CONFIGURATION_INVALID", `Workflow '${workflowId}' inputs must be an object.`);
  const inputs: Record<string, { contract: string }> = {};
  for (const [name, value] of Object.entries(candidate)) {
    if (!safeId.test(name) || !isRecord(value) || typeof value.contract !== "string" || !safeId.test(value.contract)) {
      throw new NodulusError("CONFIGURATION_INVALID", `Workflow '${workflowId}' has an invalid caller input declaration '${name}'.`);
    }
    if (Object.keys(value).some((key) => key !== "contract")) {
      throw new NodulusError("CONFIGURATION_INVALID", `Workflow '${workflowId}' caller input declaration '${name}' has an unknown property.`);
    }
    inputs[name] = { contract: value.contract };
  }
  return inputs;
}

/** Validate graph-wide alias sources after each declared node's outputs are loaded. */
export function validateGraphOutputs(
  workflow: GraphDefinition,
  declaredOutputs: OutputDeclaration[],
): void {
  for (const alias of workflow.outputs) {
    const resolution = resolveOutputReference(alias.from, declaredOutputs);
    if (resolution.status !== "resolved") {
      throw new NodulusError("CONFIGURATION_INVALID", `Workflow output '${alias.name}' has an ${resolution.status} source '${alias.from}'.`);
    }
    if (resolution.contract !== alias.contract) {
      throw new NodulusError("CONFIGURATION_INVALID", `Workflow output '${alias.name}' contract must match source '${alias.from}' contract '${resolution.contract}'.`);
    }
  }
}

function validateResources(candidate: unknown, nodeIds: string[], workflowId: string): Record<string, string[]> | undefined {
  if (candidate === undefined) return undefined;
  if (!isRecord(candidate) || Object.keys(candidate).some((nodeId) => !nodeIds.includes(nodeId))) {
    throw new NodulusError("CONFIGURATION_INVALID", `Workflow '${workflowId}' has an invalid resource map.`);
  }
  const resources: Record<string, string[]> = {};
  for (const [nodeId, value] of Object.entries(candidate)) {
    if (!Array.isArray(value) || value.some((key) => typeof key !== "string" || !safeId.test(key)) || new Set(value).size !== value.length) {
      throw new NodulusError("CONFIGURATION_INVALID", `Workflow '${workflowId}' has invalid resources for node '${nodeId}'.`);
    }
    resources[nodeId] = value as string[];
  }
  return resources;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { Ajv2020 } from "ajv/dist/2020.js";
import { NodulusError } from "./shared/nodulus-error.js";

export const feedbackRoutingSchema = {
  type: "object",
  required: ["schemaVersion", "regionId", "startNode", "decisionNode", "decisionOutput", "continuationNode", "routes", "reentrySafeNodes", "limits"],
  properties: {
    schemaVersion: { const: 1 },
    regionId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    startNode: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    decisionNode: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    decisionOutput: {
      type: "object", required: ["name", "contract"],
      properties: {
        name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
        contract: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      }, additionalProperties: false,
    },
    continuationNode: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    routes: { type: "object", minProperties: 1, propertyNames: { pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }, additionalProperties: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" } },
    reentrySafeNodes: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" } },
    limits: {
      type: "object", required: ["maxIterations", "maxProviderCalls", "maxElapsedMs"],
      properties: {
        maxIterations: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        maxProviderCalls: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        maxElapsedMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      }, additionalProperties: false,
    },
  }, additionalProperties: false,
} as const;

export type FeedbackRoutingDefinition = {
  schemaVersion: 1; regionId: string; startNode: string; decisionNode: string;
  decisionOutput: { name: string; contract: string }; continuationNode: string;
  routes: Record<string, string>; reentrySafeNodes: string[];
  limits: { maxIterations: number; maxProviderCalls: number; maxElapsedMs: number };
};

export type FeedbackOutputNode = { id: string; outputs: Array<{ name: string; contract: string }> };
export type FeedbackInputNode = { id: string; inputs: Record<string, unknown> };

/** Validate the author declaration against the fully resolved ordered workflow. */
export function validateFeedbackRouting(value: unknown, orderedNodes: FeedbackOutputNode[], loadedContracts: Record<string, unknown>): FeedbackRoutingDefinition {
  const schemaValid = new Ajv2020({ strict: false }).compile(feedbackRoutingSchema);
  if (!schemaValid(value)) fail(`Feedback routing definition is invalid: ${(schemaValid.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; " )}.`);
  const definition = value as FeedbackRoutingDefinition;
  const positions = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const start = positions.get(definition.startNode);
  const decision = positions.get(definition.decisionNode);
  if (start === undefined || decision === undefined || start > decision) fail("Feedback routing startNode and decisionNode must identify an ordered region with startNode at or before decisionNode.");
  const continuation = positions.get(definition.continuationNode);
  if (continuation !== decision + 1) fail("Feedback routing continuationNode must be the immediate next workflow node after decisionNode.");
  const region = orderedNodes.slice(start, decision + 1);
  const regionIds = new Set(region.map(({ id }) => id));
  const safe = new Set(definition.reentrySafeNodes);
  if (safe.size !== definition.reentrySafeNodes.length || definition.reentrySafeNodes.some((id) => !regionIds.has(id))) fail("Feedback routing reentrySafeNodes must be unique known nodes inside the region.");
  let continuationRoute = false;
  for (const [code, target] of Object.entries(definition.routes)) {
    if (target === definition.continuationNode) { continuationRoute = true; continue; }
    const targetIndex = positions.get(target);
    if (targetIndex === undefined || targetIndex < start || targetIndex > decision) fail(`Feedback route '${code}' target '${target}' must be a declared node inside the feedback region.`);
    for (const node of orderedNodes.slice(targetIndex, decision + 1)) {
      if (!safe.has(node.id)) fail(`Feedback route '${code}' requires node '${node.id}' to be listed in reentrySafeNodes.`);
    }
  }
  if (!continuationRoute) fail("At least one feedback route must target continuationNode.");
  const decisionNode = orderedNodes[decision];
  const matching = decisionNode?.outputs.filter((output) => output.name === definition.decisionOutput.name) ?? [];
  if (matching.length !== 1) fail(`Feedback decisionOutput '${definition.decisionOutput.name}' must resolve to exactly one output on decisionNode '${definition.decisionNode}'.`);
  if (matching[0]?.contract !== definition.decisionOutput.contract || !Object.hasOwn(loadedContracts, definition.decisionOutput.contract)) {
    fail(`Feedback decisionOutput contract '${definition.decisionOutput.contract}' must match the loaded contract declared on '${definition.decisionNode}.${definition.decisionOutput.name}'.`);
  }
  return definition;
}

/** Keep runtime-owned decision metadata out of author-authored node mappings. */
export function validateFeedbackRuntimeInputs(definition: FeedbackRoutingDefinition, nodes: FeedbackInputNode[]): void {
  const reserved = new Map<string, Set<string>>();
  const reserve = (nodeId: string, inputName: string): void => {
    const names = reserved.get(nodeId) ?? new Set<string>();
    names.add(inputName);
    reserved.set(nodeId, names);
  };
  reserve(definition.decisionNode, "artifactReferences");
  for (const target of Object.values(definition.routes)) {
    if (target !== definition.continuationNode) reserve(target, "feedback");
  }
  for (const node of nodes) {
    for (const inputName of reserved.get(node.id) ?? []) {
      if (Object.hasOwn(node.inputs, inputName)) fail("Node '" + node.id + "' input '" + inputName + "' is reserved for feedback runtime metadata.");
    }
  }
}

function fail(message: string): never { throw new NodulusError("CONFIGURATION_INVALID", message); }

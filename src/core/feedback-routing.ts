import { createHash } from "node:crypto";
import { resolveOutputReference } from "./workflow-mapping.js";
import type { FeedbackRoutingDefinition } from "./feedback-definition.js";

export type FeedbackRegionState = {
  iteration: number;
  generationHistory: Array<Record<string, unknown>>;
  invalidatedSuffixes: Array<Record<string, unknown>>;
  reusedPrefix: string[];
  eligibleNodes: string[];
  feedback?: Record<string, unknown>;
  providerCalls?: number;
  elapsedMs?: number;
  enteredAtMs?: number;
  deadlineAtMs?: number;
  completedAtMs?: number;
  uncertainCalls?: Array<{ callId: string; nodeId: string; attempt: number; operation: "invoke" | "repair_response"; launchStatus: "not_launched" | "launched" | "uncertain" }>;
};

export type FeedbackArtifactReference = {
  runId: string;
  nodeId: string;
  outputName: string;
  contract: string;
  iteration: number;
  generationId: string;
  sha256: string;
};

export type FeedbackOutputNode = {
  id: string;
  expectedOutputs: Array<{ name: string; contract: string }>;
  inputs?: Record<string, unknown>;
};

export type FeedbackReferencesResult =
  | { valid: true; references: FeedbackArtifactReference[] }
  | { valid: false; errors: string[] };

/** Resolve exactly the current accepted generations mapped into the decision node. */
export function feedbackArtifactReferences(
  runId: string,
  route: FeedbackRoutingDefinition,
  nodes: FeedbackOutputNode[],
  acceptedOutputs: Map<string, Map<string, { name: string; contract: string; data: unknown }>>,
  state: FeedbackRegionState,
): FeedbackReferencesResult {
  const start = nodes.findIndex(({ id }) => id === route.startNode);
  const end = nodes.findIndex(({ id }) => id === route.decisionNode);
  if (start < 0 || end < start) return { valid: false, errors: ["The configured feedback region is not present in the captured nodes."] };

  const mappedOutputs = new Set<string>();
  const earlierNodes = nodes.slice(0, end).map(({ id, expectedOutputs }) => ({
    nodeId: id,
    outputs: expectedOutputs,
  }));
  const decision = nodes[end];
  for (const mapping of Object.values(decision?.inputs ?? {})) {
    if (!isRecord(mapping) || typeof mapping.from !== "string") continue;
    const resolved = resolveOutputReference(mapping.from, earlierNodes);
    if (resolved.status !== "resolved") continue;
    const sourceIndex = nodes.findIndex(({ id }) => id === resolved.nodeId);
    if (sourceIndex >= 0 && sourceIndex < end) mappedOutputs.add(resolved.nodeId + "\u0000" + resolved.outputName);
  }

  const references: FeedbackArtifactReference[] = [];
  for (const node of nodes.slice(0, end)) {
    for (const declaration of node.expectedOutputs) {
      if (!mappedOutputs.has(node.id + "\u0000" + declaration.name)) continue;
      const artifact = acceptedOutputs.get(node.id)?.get(declaration.name);
      if (!artifact || artifact.contract !== declaration.contract) {
        return { valid: false, errors: ["Mapped feedback artifact " + node.id + "." + declaration.name + " is not currently accepted."] };
      }
      const digest = createHash("sha256").update(JSON.stringify(artifact.data), "utf8").digest("hex");
      const history = state.generationHistory
        .filter((entry) => entry.nodeId === node.id && entry.outputName === declaration.name && entry.contract === declaration.contract && entry.status === "accepted")
        .sort((left, right) => Number(left.iteration) - Number(right.iteration))
        .at(-1);
      if (
        !history
        || history.runId !== runId
        || !Number.isInteger(history.iteration)
        || typeof history.generationId !== "string"
        || history.generationId.length === 0
        || history.sha256 !== digest
      ) {
        return { valid: false, errors: ["Mapped feedback artifact " + node.id + "." + declaration.name + " has no matching accepted generation identity."] };
      }
      references.push({
        runId,
        nodeId: node.id,
        outputName: declaration.name,
        contract: declaration.contract,
        iteration: history.iteration as number,
        generationId: history.generationId,
        sha256: history.sha256 as string,
      });
    }
  }
  return { valid: true, references };
}

/** Reject any model-returned list that differs from the exact runtime references. */
export function validateFeedbackArtifactReferences(value: unknown, expected: FeedbackArtifactReference[]): string[] {
  if (!Array.isArray(value)) return ["The decision output must include an artifactRefs array."];
  if (value.length !== expected.length) return ["The decision artifactRefs list is missing or contains extra references."];
  const remaining = [...expected];
  for (const candidate of value) {
    if (!isRecord(candidate)) return ["The decision artifactRefs list contains a non-object reference."];
    const match = remaining.findIndex((reference) => sameReference(candidate, reference));
    if (match < 0) return ["The decision artifactRefs list contains a duplicate, stale, forged, or unmapped reference."];
    remaining.splice(match, 1);
  }
  if (remaining.length) return ["The decision artifactRefs list omits an expected mapped reference."];
  return [];
}

function sameReference(candidate: Record<string, unknown>, expected: FeedbackArtifactReference): boolean {
  const candidateKeys = Object.keys(candidate).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (candidateKeys.length !== expectedKeys.length || candidateKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return expectedKeys.every((key) => candidate[key] === expected[key as keyof FeedbackArtifactReference]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

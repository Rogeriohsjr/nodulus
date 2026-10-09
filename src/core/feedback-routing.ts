import { createHash } from "node:crypto";
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
};

/** Build stable, content-addressed references to the currently accepted region outputs. */
export function feedbackArtifactReferences(
  runId: string,
  route: FeedbackRoutingDefinition,
  nodes: Array<{ id: string; expectedOutputs: Array<{ name: string; contract: string }> }>,
  acceptedOutputs: Map<string, Map<string, { name: string; contract: string; data: unknown }>>,
  iteration: number,
  state: FeedbackRegionState,
): Array<Record<string, unknown>> {
  const start = nodes.findIndex(({ id }) => id === route.startNode);
  const end = nodes.findIndex(({ id }) => id === route.decisionNode);
  return nodes.slice(start, end).flatMap((node) => (acceptedOutputs.get(node.id) ? [...acceptedOutputs.get(node.id)!.values()] : []).map((artifact) => {
    const history = state.generationHistory.find((entry) => entry.nodeId === node.id && entry.outputName === artifact.name && entry.iteration === iteration);
    return { runId, nodeId: node.id, outputName: artifact.name, contract: artifact.contract, iteration, generationId: history?.generationId ?? "", sha256: createHash("sha256").update(JSON.stringify(artifact.data)).digest("hex") };
  }));
}

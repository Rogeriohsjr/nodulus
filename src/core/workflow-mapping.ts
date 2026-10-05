export type OutputDeclaration = {
  nodeId: string;
  outputs: Array<{ name: string; contract: string }>;
};

export type OutputReferenceResolution =
  | { status: "resolved"; nodeId: string; outputName: string; contract: string }
  | { status: "missing" }
  | { status: "ambiguous" };

export type InputMapping = { from: string; contract?: string };

/** Return the execution preflight diagnostic for an input mapping, if invalid. */
export function inputMappingError(
  nodeId: string,
  inputName: string,
  candidate: unknown,
  earlierNodes: OutputDeclaration[],
  callerInputs: Record<string, { contract: string }>,
): string | undefined {
  if (!isRecord(candidate) || typeof candidate.from !== "string") {
    return `Node '${nodeId}' input '${inputName}' must map from request or a prior node output.`;
  }
  if (candidate.from === "request") {
    if (candidate.contract !== undefined && candidate.contract !== "request.v1") {
      return `Node '${nodeId}' input '${inputName}' must declare request contract 'request.v1'.`;
    }
    return undefined;
  }
  if (candidate.from.startsWith("caller.")) {
    const callerName = candidate.from.slice("caller.".length);
    const declaration = callerInputs[callerName];
    if (!declaration) return `Node '${nodeId}' input '${inputName}' references undeclared caller input '${callerName}'.`;
    if (candidate.contract !== declaration.contract) {
      return `Node '${nodeId}' input '${inputName}' contract must match caller input '${callerName}' contract '${declaration.contract}'.`;
    }
    return undefined;
  }
  const resolution = resolveOutputReference(candidate.from, earlierNodes);
  if (resolution.status === "ambiguous") return `Node '${nodeId}' input '${inputName}' source '${candidate.from}' is ambiguous between declared prior outputs.`;
  if (resolution.status === "missing") return `Node '${nodeId}' input '${inputName}' has an invalid source '${candidate.from}'.`;
  if (candidate.contract !== resolution.contract) {
    return `Node '${nodeId}' input '${inputName}' contract must match source '${candidate.from}' contract '${resolution.contract}'.`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a source only when exactly one declared earlier node/output pair matches it. */
export function resolveOutputReference(source: string, earlierNodes: OutputDeclaration[]): OutputReferenceResolution {
  const matches: Array<{ nodeId: string; outputName: string; contract: string }> = [];
  for (const node of earlierNodes) {
    const prefix = `${node.nodeId}.`;
    if (!source.startsWith(prefix)) continue;
    const outputName = source.slice(prefix.length);
    const output = node.outputs.find((candidate) => candidate.name === outputName);
    if (output) matches.push({ nodeId: node.nodeId, outputName, contract: output.contract });
  }
  if (matches.length === 1) return { status: "resolved", ...matches[0] };
  return { status: matches.length === 0 ? "missing" : "ambiguous" };
}

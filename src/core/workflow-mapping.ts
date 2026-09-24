export type OutputDeclaration = {
  nodeId: string;
  outputs: Array<{ name: string; contract: string }>;
};

export type OutputReferenceResolution =
  | { status: "resolved"; nodeId: string; outputName: string; contract: string }
  | { status: "missing" }
  | { status: "ambiguous" };

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

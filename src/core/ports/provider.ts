export type ProviderInvocation = {
  runId: string;
  workflow: string;
  nodeId: string;
  prompt: string;
  /** Structured, destination-mapped inputs supplied to this node. */
  inputs: Record<string, unknown>;
  /** Profile options captured for this run, with credentials excluded. */
  providerProfile: Record<string, unknown>;
  /** Validated answers supplied after a node requested clarification. */
  answers?: Record<string, unknown>;
};

/** External provider boundary; implementations return untrusted raw response text. */
export interface ProviderPort {
  invoke(invocation: ProviderInvocation): Promise<string>;
  isAvailable?(profile: Record<string, unknown>): Promise<boolean> | boolean;
}

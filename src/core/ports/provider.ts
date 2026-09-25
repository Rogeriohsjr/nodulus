export type ProviderInvocation = {
  runId: string;
  /** One-based full provider invocation number for this node in the run. */
  attempt: number;
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

export type ProviderUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
};
export type ProviderCallMetric = { nodeId: string; attempt: number; usage: ProviderUsage | null; elapsedMs: number };

/** External provider boundary; implementations return untrusted raw response text. */
export interface ProviderPort {
  invoke(invocation: ProviderInvocation): Promise<string>;
  /** Safe correction call that cannot replay the provider's tool/action phase. */
  repairResponse?(
    invocation: ProviderInvocation,
    previousRawResponse: string,
    validationErrors: string[],
  ): Promise<string>;
  /** Trusted adapter telemetry for the immediately preceding invocation. */
  usageForLastCall?(): ProviderUsage | null;
  isAvailable?(profile: Record<string, unknown>): Promise<boolean> | boolean;
}

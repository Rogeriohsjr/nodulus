export type ProviderInvocation = {
  runId: string;
  workflow: string;
  nodeId: string;
  prompt: string;
};

/** External provider boundary; implementations return untrusted raw response text. */
export interface ProviderPort {
  invoke(invocation: ProviderInvocation): Promise<string>;
}

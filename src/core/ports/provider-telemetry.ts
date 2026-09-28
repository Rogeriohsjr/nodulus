export type ReportedCounters = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
};
export type ProviderTelemetry = {
  schemaVersion: 1;
  callId?: string;
  provider: string;
  cliVersion: string | null;
  reportedModel: string | null;
  reported: ReportedCounters;
  normalized: { inputTokens: number | null; outputTokens: number | null };
  coverage: "complete" | "partial" | "unavailable";
  stepCount: number;
  source: { eventType: string; recordIds: string[]; transportRef: string; parserVersion: 1 };
  semantics: { inputCache: "included" | "excluded" | "unknown"; outputReasoning: "included" | "excluded" | "unknown"; evidence: string | null };
  diagnostics: string[];
};

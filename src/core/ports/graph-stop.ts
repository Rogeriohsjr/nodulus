import { NodulusError } from "../shared/nodulus-error.js";

export type GraphStopReason = {
  source: "nodulus.graph";
  kind: "graph_stop";
  code: "GRAPH_CANCELLED";
  message: string;
};

export type GraphProfileTimeoutReason = {
  source: "nodulus.graph";
  kind: "profile_timeout";
  code: "PROVIDER_TIMEOUT";
  message: string;
};

export function createGraphStopReason(message: string): GraphStopReason {
  return { source: "nodulus.graph", kind: "graph_stop", code: "GRAPH_CANCELLED", message };
}

export function createGraphProfileTimeoutReason(message: string): GraphProfileTimeoutReason {
  return { source: "nodulus.graph", kind: "profile_timeout", code: "PROVIDER_TIMEOUT", message };
}

export function graphStopError(signal?: AbortSignal): NodulusError | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (typeof reason !== "object" || reason === null) return undefined;
  const candidate = reason as Record<string, unknown>;
  if (candidate.source !== "nodulus.graph" || candidate.kind !== "graph_stop" || candidate.code !== "GRAPH_CANCELLED" || typeof candidate.message !== "string") return undefined;
  return new NodulusError("GRAPH_CANCELLED", candidate.message);
}

export function graphProfileTimeoutError(signal?: AbortSignal): NodulusError | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (typeof reason !== "object" || reason === null) return undefined;
  const candidate = reason as Record<string, unknown>;
  if (candidate.source !== "nodulus.graph" || candidate.kind !== "profile_timeout" || candidate.code !== "PROVIDER_TIMEOUT" || typeof candidate.message !== "string") return undefined;
  return new NodulusError("PROVIDER_TIMEOUT", candidate.message);
}

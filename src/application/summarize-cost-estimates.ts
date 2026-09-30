import type { ProviderCallMetric } from "../core/ports/provider.js";
import { estimateProviderCost } from "../core/cost-estimate.js";
import type { CostEstimate, PricingSnapshot } from "../core/cost-estimate.js";

export type CostEstimateRecord = CostEstimate & { callId: string | null };
export type CostEstimateCoverage = {
  knownCalls: number;
  totalCalls: number;
  knownSubtotal: number;
  total: number | null;
};

export function summarizeCostEstimates(
  calls: ProviderCallMetric[],
  totalCalls: number,
  snapshot: PricingSnapshot | null,
): { estimates?: CostEstimateRecord[]; coverage?: CostEstimateCoverage; diagnostics: string[] } {
  if (snapshot === null) return { diagnostics: [] };
  const diagnostics: string[] = [];
  const estimates = calls.map((call) => {
    const estimate = estimateProviderCost(call.telemetry ?? null, snapshot);
    const prefix = call.callId ? `Call ${call.callId}: ` : "Call with unknown id: ";
    diagnostics.push(...estimate.diagnostics.map((diagnostic) => `${prefix}${diagnostic}`));
    return { ...estimate, callId: call.callId ?? null };
  });
  const known = estimates.flatMap((estimate) =>
    typeof estimate.usd === "number" && Number.isFinite(estimate.usd) && estimate.usd >= 0
      ? [estimate.usd]
      : [],
  );
  const knownSubtotal = known.reduce((sum, usd) => sum + usd, 0);
  return {
    estimates,
    coverage: {
      knownCalls: known.length,
      totalCalls,
      knownSubtotal,
      total: totalCalls > 0 && known.length === totalCalls ? knownSubtotal : null,
    },
    diagnostics,
  };
}

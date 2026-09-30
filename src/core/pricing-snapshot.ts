import { createHash } from "node:crypto";
import { NodulusError } from "./shared/nodulus-error.js";
import type { PricingRate, PricingSnapshot } from "./cost-estimate.js";

export type PricingPolicy = {
  mode: "api" | "local" | "subscription";
  rateCard: string;
  hypotheticalApiEquivalent: boolean;
};

const validModes = new Set(["api", "local", "subscription"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidMode(value: unknown): value is PricingPolicy["mode"] {
  return typeof value === "string" && validModes.has(value);
}

function parseRate(value: unknown, index: number): PricingRate {
  if (!isRecord(value)) throw invalid(`pricing rates[${index}] must be an object.`);
  const { id, provider, reportedModel, inputPerMillion, cacheReadPerMillion, outputPerMillion } = value;
  if (typeof id !== "string" || id.trim() === "") throw invalid(`pricing rates[${index}].id must be a nonempty string.`);
  if (typeof provider !== "string" || provider.trim() === "") throw invalid(`pricing rates[${index}].provider must be a nonempty string.`);
  if (typeof reportedModel !== "string" || reportedModel.trim() === "") throw invalid(`pricing rates[${index}].reportedModel must be a nonempty string.`);
  if (!isRate(inputPerMillion)) throw invalid(`pricing rates[${index}].inputPerMillion must be finite and nonnegative.`);
  if (cacheReadPerMillion !== null && !isRate(cacheReadPerMillion)) throw invalid(`pricing rates[${index}].cacheReadPerMillion must be null or finite and nonnegative.`);
  if (!isRate(outputPerMillion)) throw invalid(`pricing rates[${index}].outputPerMillion must be finite and nonnegative.`);
  return { id, provider, reportedModel, inputPerMillion, cacheReadPerMillion, outputPerMillion };
}

function parseRates(value: unknown): PricingRate[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid("pricing rates must be a nonempty array.");
  const rates = value.map(parseRate);
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const rate of rates) {
    if (ids.has(rate.id)) throw invalid(`pricing rate id '${rate.id}' is duplicated.`);
    ids.add(rate.id);
    const pair = `${rate.provider}\u0000${rate.reportedModel}`;
    if (pairs.has(pair)) throw invalid(`pricing provider/model pair '${rate.provider}/${rate.reportedModel}' is duplicated.`);
    pairs.add(pair);
  }
  return rates;
}

export function parsePricingPolicy(value: unknown): PricingPolicy | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new NodulusError("INVALID_SETTINGS", "pricing policy must be an object.");
  if (!isValidMode(value.mode)) throw new NodulusError("INVALID_SETTINGS", "pricing mode must be api, local, or subscription.");
  if (typeof value.rateCard !== "string" || value.rateCard.trim() === "") throw new NodulusError("INVALID_SETTINGS", "pricing rateCard must be a nonempty string.");
  if (value.hypotheticalApiEquivalent !== undefined && typeof value.hypotheticalApiEquivalent !== "boolean") {
    throw new NodulusError("INVALID_SETTINGS", "pricing hypotheticalApiEquivalent must be a boolean.");
  }
  return {
    mode: value.mode,
    rateCard: value.rateCard,
    hypotheticalApiEquivalent: value.hypotheticalApiEquivalent ?? false,
  };
}

export function createPricingSnapshot(policy: PricingPolicy, rawRateCard: string): PricingSnapshot {
  return {
    schemaVersion: 1,
    hash: createHash("sha256").update(rawRateCard, "utf8").digest("hex"),
    rawRateCard,
    mode: policy.mode,
    hypotheticalApiEquivalent: policy.hypotheticalApiEquivalent,
    rates: parseRateCard(rawRateCard),
  };
}

export function parsePricingSnapshot(contents: string): PricingSnapshot {
  const parsed = parseJson(contents, "pricing snapshot");
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) throw invalid("pricing snapshot must be a schemaVersion 1 object.");
  if (typeof parsed.hash !== "string" || !/^[0-9a-f]{64}$/.test(parsed.hash)) throw invalid("pricing snapshot hash must be 64 lowercase hexadecimal characters.");
  if (typeof parsed.rawRateCard !== "string") throw invalid("pricing snapshot rawRateCard must be a string.");
  const recomputedHash = createHash("sha256").update(parsed.rawRateCard, "utf8").digest("hex");
  if (recomputedHash !== parsed.hash) throw invalid("pricing snapshot hash does not match its captured rate card.");
  if (!isValidMode(parsed.mode)) throw invalid("pricing snapshot mode must be api, local, or subscription.");
  if (typeof parsed.hypotheticalApiEquivalent !== "boolean") throw invalid("pricing snapshot hypotheticalApiEquivalent must be a boolean.");
  const rates = parseRates(parsed.rates);
  if (JSON.stringify(rates) !== JSON.stringify(parseRateCard(parsed.rawRateCard))) {
    throw invalid("pricing snapshot rates do not match its captured rate card.");
  }
  return {
    schemaVersion: 1,
    hash: parsed.hash,
    rawRateCard: parsed.rawRateCard,
    mode: parsed.mode,
    hypotheticalApiEquivalent: parsed.hypotheticalApiEquivalent,
    rates,
  };
}

function parseRateCard(contents: string): PricingRate[] {
  const parsed = parseJson(contents, "pricing rate card");
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) throw invalid("pricing rate card must be a schemaVersion 1 object.");
  return parseRates(parsed.rates);
}

function parseJson(contents: string, description: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw invalid(`${description} contains invalid JSON: ${detail}`);
  }
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function invalid(message: string): NodulusError {
  return new NodulusError("CONFIGURATION_INVALID", message);
}

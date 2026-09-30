# OBS-010 reproducible cost estimates

## Configuration

Cost estimation is opt-in through `.nodulus/settings.json`:

```json
{
  "observability": {
    "pricing": {
      "mode": "api",
      "rateCard": ".nodulus/pricing.json",
      "hypotheticalApiEquivalent": false
    }
  }
}
```

The external rate card has `schemaVersion: 1` and a nonempty `rates` array. Each rate has a unique `id`, an exact `provider` and `reportedModel`, finite nonnegative `inputPerMillion` and `outputPerMillion` values, and a `cacheReadPerMillion` value that is either finite and nonnegative or `null`. Prices are USD per million tokens.

## Snapshot and resume

Nodulus validates pricing before inference. It records a SHA-256 of the exact UTF-8 rate-card text and a second SHA-256 over the captured schema version, policy fields, rate-card path, and raw content. The run's `pricing.json` contains those digests, the captured text, validated rates, and policy. Resume and status use that file. On read, Nodulus recomputes both digests and validates that the stored rates equal the captured text. Changing or deleting the external rate card after intake does not change the run's estimates; changing valid-looking stored rates or policy without updating the captured content is rejected.

## Status interpretation

A rate matches only complete telemetry with nonempty adapter evidence and the exact provider and provider-reported model. Adapter evidence is the versioned source reference saved by the normalizer; Nodulus never substitutes the requested model. Missing or incompatible models, counters, semantics, evidence, rates, or cache prices produce `null` estimates with diagnostics.

Normalized input/output counts are inclusive. Cache-read tokens are subtracted from normalized input and billed at the cache rate, independent of whether the provider's raw input counter included them before normalization. Normalized output is billed once; reasoning is not added again. A positive cache-write bucket stays unknown because this policy has no cache-write rate. Provider-reported cost and Nodulus estimates remain separate.

JSON status exposes `metrics.estimates` and `metrics.estimateCoverage`. Text status prints `Reported cost USD` and `Estimated cost USD` separately. A missing pricing policy preserves the existing status shape. A corrupt captured snapshot adds diagnostics without hiding reported usage.

API mode produces an estimate, not an invoice. Local and subscription modes remain unknown unless `hypotheticalApiEquivalent` is explicitly true; such results are labeled hypothetical.

## Validation evidence

The initial implementation was `274d68b`. After independent-review counterexamples, a sequential build followed by two focused scenario files passed ten tests on Windows Node 24.15.0. The scenarios cover:

- the exact USD 0.0022 result for 1,000 input, 200 inclusive cache, and 100 output tokens at rates of 2/1/4 per million;
- real Codex/OpenCode normalized telemetry and source-reference evidence, reasoning no-double-counting, unknown inputs, included/excluded cache writes without a rate, duplicate matches, and numeric overflow;
- a frozen snapshot across fresh-process resume after the external rate card changes;
- invalid policy and negative rates rejected before inference;
- absent pricing compatibility, valid-shape snapshot tampering, corrupt snapshot diagnostics, JSON and text status, and separate provider-reported zero cost.

Local Qwen generated the pricing snapshot/parser and summary drafts. The calculator needed a bounded supervisor roadblock repair after both Qwen attempts changed or misread the frozen telemetry types. The supervisor wrote coordinator wiring and corrected type narrowing. Local Qwen evidence review `aa88fed4-e28c-4fbf-a6f3-55836136cb92` returned `ACCEPT` from the supplied contract and results. A separate bounded source review of the actual calculator and snapshot modules, `c4bd0ac6-2051-4f62-8c1e-9aa28f301119`, also returned `ACCEPT`. Neither review executed tests; coordinator wiring remained outside the bounded Qwen source review and goes to independent Sol review.

## Limitations

Estimates do not include electricity, subscription allocation, discounts, tiers, taxes, or invoice reconciliation. No hosted or live billing proof, release, merge, or publish is claimed.

The hashes are internal consistency checks, not signatures or proof against an attacker who can rewrite the complete run directory.

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

Nodulus validates pricing before inference. It hashes the exact UTF-8 rate-card text with SHA-256 and writes the validated rates, policy, and hash to the run's immutable `pricing.json`. Resume and status use that captured file. Changing or deleting the external rate card after intake does not change the run's estimates.

## Status interpretation

A rate matches only verified, complete telemetry with the exact provider and provider-reported model. Nodulus never substitutes the requested model. Missing or incompatible models, counters, semantics, evidence, rates, or cache prices produce `null` estimates with diagnostics.

With inclusive-cache semantics, cache-read tokens are subtracted from normalized input and billed at the cache rate. Normalized output is billed once; reasoning is not added again. Provider-reported cost and Nodulus estimates remain separate.

JSON status exposes `metrics.estimates` and `metrics.estimateCoverage`. Text status prints `Reported cost USD` and `Estimated cost USD` separately. A missing pricing policy preserves the existing status shape. A corrupt captured snapshot adds diagnostics without hiding reported usage.

API mode produces an estimate, not an invoice. Local and subscription modes remain unknown unless `hypotheticalApiEquivalent` is explicitly true; such results are labeled hypothetical.

## Validation evidence

At commit `274d68b`, a sequential build followed by two focused scenario files passed seven tests on Windows Node 24.15.0. The scenarios cover:

- the exact USD 0.0022 result for 1,000 input, 200 inclusive cache, and 100 output tokens at rates of 2/1/4 per million;
- reasoning no-double-counting, unknown inputs, duplicate matches, and numeric overflow;
- a frozen snapshot across fresh-process resume after the external rate card changes;
- invalid policy and negative rates rejected before inference;
- absent pricing compatibility, corrupt snapshot diagnostics, JSON and text status, and separate provider-reported zero cost.

Local Qwen generated the pricing snapshot/parser and summary drafts. The calculator needed a bounded supervisor roadblock repair after both Qwen attempts changed or misread the frozen telemetry types. The supervisor wrote coordinator wiring and corrected type narrowing. Local Qwen evidence review `aa88fed4-e28c-4fbf-a6f3-55836136cb92` returned `ACCEPT` from the supplied contract and results. A separate bounded source review of the actual calculator and snapshot modules, `c4bd0ac6-2051-4f62-8c1e-9aa28f301119`, also returned `ACCEPT`. Neither review executed tests; coordinator wiring remained outside the bounded Qwen source review and goes to independent Sol review.

## Limitations

Estimates do not include electricity, subscription allocation, discounts, tiers, taxes, or invoice reconciliation. No hosted or live billing proof, release, merge, or publish is claimed.

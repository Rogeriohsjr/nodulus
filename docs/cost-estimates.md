# Reproducible cost estimates

Nodulus can calculate an optional estimate from provider telemetry and a project-owned rate card. Estimates remain separate from provider-reported cost and are never presented as invoices.

Add a pricing policy to `.nodulus/settings.json`:

```json
{
  "schemaVersion": 1,
  "defaultWorkflow": "example",
  "providerProfiles": {},
  "observability": {
    "pricing": {
      "mode": "api",
      "rateCard": ".nodulus/pricing.json"
    }
  }
}
```

The rate card uses USD per million tokens and matches the provider-reported model exactly:

```json
{
  "schemaVersion": 1,
  "rates": [
    {
      "id": "example-opencode-model",
      "provider": "opencode",
      "reportedModel": "example-model",
      "inputPerMillion": 2,
      "cacheReadPerMillion": 1,
      "outputPerMillion": 4
    }
  ]
}
```

Nodulus validates the policy and rate card before inference. At intake it captures the policy, raw rate-card content, parsed rates, and consistency hashes in `.nodulus/runs/<run-id>/pricing.json`. Resume and status use that snapshot even if the project rate card later changes.

`nodulus status <run-id> --json` exposes `metrics.estimates` and `metrics.estimateCoverage`. Text status labels provider-reported and estimated USD separately. Missing model or rate matches, incomplete counters, unsupported cache-write tokens, incompatible semantics, invalid snapshots, and numeric overflow return an unknown estimate with a diagnostic rather than assuming zero.

For local or subscription-backed inference, estimates remain unknown by default. Set `hypotheticalApiEquivalent` to `true` only when you deliberately want an API-equivalent comparison:

```json
{
  "mode": "local",
  "rateCard": ".nodulus/pricing.json",
  "hypotheticalApiEquivalent": true
}
```

The hashes detect inconsistent or partially edited snapshots; they are not signatures. Estimates exclude electricity, subscription allocation, discounts, tiers, taxes, and billing reconciliation.

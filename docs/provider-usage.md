# Provider usage

Use a release containing OBS-003–005 or build this branch. Each launched built-in inference call writes `.nodulus/runs/<run-id>/calls/<call-id>/telemetry.json` beside its request, stdin and transport records. `nodulus status <run-id> --json` exposes `metrics.calls[].telemetry`; the legacy `usage` projection remains null when all its fields are unknown. Parsing reads the original captured response and makes no extra inference call.

## Provider rules

- **Codex 0.144.4:** terminal `turn.completed.usage` only. Input already includes cached tokens and output already includes reasoning; normalized totals do not add them again. Provider cost is unknown.
- **Cursor:** optional camelCase usage on the terminal JSON result. Missing fields remain null. Cache/reasoning inclusion is unverified, so normalized input/output remain null even with reported counts.
- **OpenCode 1.18.32:** sum unique `step_finish` parts by `(sessionID, part.id)`; ignore assistant totals. Reported input excludes cache read/write and output excludes reasoning. Normalization adds those buckets once. A missing required bucket leaves the affected total null.

Other CLI versions retain recognized reported counters but leave normalization unknown. The exact-version evidence is recorded in `semantics.evidence`.

## Coverage and unknowns

`reported` preserves nullable input, output, cache-read, cache-write, reasoning and USD counters. Missing values never become zero; numeric strings are not coerced. Explicit provider zero survives. `reportedModel` may be null and is separate from `request.json`'s requested model.

`complete` means the relevant record sequence is complete, not that every optional counter is known. `partial` retains observed reported subtotals; conflicts and missing completion invalidate normalized totals. `unavailable` means no recognized usage records. Diagnostics and source event/record IDs link measurements to the saved transport. CLI version is on the telemetry object.

## Limits

OBS-006–012's broader failure isolation, resume accounting, coverage views and pricing remain pending. Live usage proof here covers Windows OpenCode/Ollama; Codex/Cursor use offline process fixtures. Provider USD is not a verified invoice or an estimate from a Nodulus rate card. Local Ollama zero does not mean hardware or electricity is free.

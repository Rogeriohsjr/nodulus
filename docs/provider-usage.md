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

OBS-006/007 failure-capture and validity cases and OBS-008/009 resume aggregation have local fixture coverage. The optional OBS-010 rate-card path produces reproducible estimates from a captured run snapshot; see the [cost-estimate guide](cost-estimates.md). OBS-011 covers installed-archive CLI/status and public invoke-only/legacy provider compatibility. OBS-012 has one authorized Windows OpenCode/Ollama result through a freshly installed local archive; all Codex/Cursor and non-Windows live cells remain pending. Provider USD is not a verified invoice. Local Ollama zero does not mean hardware or electricity is free.

## Optional reproducible estimates

Set `observability.pricing` in `.nodulus/settings.json` with `mode`, a project-relative `rateCard`, and optional `hypotheticalApiEquivalent`. Nodulus validates and hashes the rate card before inference, saves `pricing.json` in the run, and uses that snapshot for resume and status. JSON status exposes `metrics.estimates` and `metrics.estimateCoverage`; text status keeps reported and estimated USD on separate lines. Missing or incompatible evidence stays null with diagnostics. API estimates are not invoices, and local/subscription usage remains unknown unless an explicitly hypothetical API equivalent is requested.

## Launch and interrupted-call evidence

`metrics.calls[].launched` is true after completed built-in process capture, false when a built-in readiness check prevented inference, and null when certainty is unavailable (including custom providers without the optional hook). A captured process failure can still report launched true; it does not imply artifact success.

Status also returns `callEvidence`, correlated to valid UUID call-start events. Matching request/transport records distinguish completed capture, incomplete evidence, explicitly not launched, and unavailable capture. A process killed after saving its request has incomplete evidence and unknown launch certainty if no metric or transport resolves it. Status reads existing files without inference or automatic recovery. The run checkpoint remains authoritative. Invalid capture JSON or mismatched identity produces a diagnostic rather than a fabricated record.

Timeout, nonzero exit and output-limit cases preserve whatever bounded output was captured and mark telemetry partial. Invalid counters/cost fields remain null with diagnostics; valid raw fields survive and valid artifacts are not retried just to obtain usage. A failed optional telemetry write does not discard the accepted artifact.

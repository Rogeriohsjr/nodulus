# Research: obtain measurements from the provider boundary

Research checked on 2026-09-25. Source pages and development branches can change. Record the installed CLI version and the protocol revision behind each future fixture. No live inference was performed for this research.

## Verified repository baseline

Reviewed main `1519183`, including these existing modules:

| Existing module | Current behavior and gap |
| --- | --- |
| `src/core/execute-workflow.ts` | Saves invocation metadata, a base prompt, raw response, validation results and per-call elapsed metrics. Events describe transitions but generally lack timestamps. The base prompt is not always the exact provider stdin. |
| `src/core/ports/provider.ts` | Has optional `usageForLastCall()` and nullable input/output/cache-read/USD fields. No provenance, coverage or stable call identity in metrics. |
| `src/adapters/providers/default-provider-port.ts` | Captures provider transport output. All three concrete adapters currently return null usage. Codex/OpenCode add transport instructions; OpenCode repair has its own prompt and directory. |
| `src/adapters/providers/process-runner.ts` | Real bounded child processes with timeout/cancellation and bounded output. Existing capture is returned at process completion; this is not a continuously flushed trace. |
| `src/application/resume-workflow.ts` | Status reads checkpoint, events and metrics. A total stays null if any call lacks that field. Malformed metrics currently fall back to an empty list, hiding missing evidence. |

The intended timestamp/usage language in architecture.md is broader than these current capabilities. This folder defines the remaining work; it does not certify that it already exists.

## Provider findings

### Codex

`codex exec --json` emits JSONL events. Official documentation shows `turn.completed.usage` with `input_tokens`, `cached_input_tokens`, `output_tokens`, and `reasoning_output_tokens`. Parse structured usage, separately from the final artifact text. Missing version-dependent fields remain null. [Official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

API-key usage and subscription/credit usage have different billing contexts. A token count is not an account's remaining percentage, and API-equivalent USD is not proof of a subscription charge. Do not hardcode today's model prices or infer cheaper subscription usage solely from a model's size. [Official pricing and usage explanation](https://learn.chatgpt.com/docs/pricing).

### Cursor

The documented `json` format gives one terminal result with response text, duration and session/request identifiers. Its documented example does not promise a usage object. `stream-json` exposes additional events, including model information; changing output format would need separate response-selection regression coverage. [Official output formats](https://cursor.com/docs/cli/reference/output-format).

A previous Windows smoke observation in this task, using Cursor `2026.09.23-86fc751`, included optional camelCase `usage.inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. Treat this as an observed version-specific extension, not a stable guarantee. Create a sanitized fixture with provenance before implementation; missing usage must remain supported. Do not switch formats merely to assume usage will appear.

### OpenCode with Ollama or another backend

OpenCode documents `run --format json`, session export, and statistics. The CLI's aggregate statistics cover sessions; they are unsuitable as a before/after counter for one Nodulus call when other work may run concurrently. [Official CLI documentation](https://dev.opencode.ai/docs/cli/).

The upstream v1 schema exposes step-finish identifiers, a cost field, and input/output/reasoning/cache-read/cache-write counters. Assistant records also contain counters. Choose one accounting level; summing both would duplicate usage. [Upstream v1 session schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/session.ts).

The existing adapter's Windows proof used OpenCode `1.18.32`. The linked development schema is research evidence, not proof of that installed version's complete event coverage or billing accuracy. Pin a versioned fixture before implementing its parser. Preserve missing terminal usage as incomplete; a final artifact alone does not prove all internal model calls were metered.

## Decisions for this slice

1. Collect structured provider telemetry from the same bounded process invocation that does the work. Never ask the LLM to calculate its tokens or estimate usage from prompt character count.
2. Keep Nodulus call identity separate from provider session, message and internal-step IDs. The orchestration call can contain multiple provider model steps.
3. Preserve reported counters with their semantics and provenance. Normalize only verified relationships; cache/reasoning may be subsets or separate buckets depending on protocol.
4. Distinguish provider-reported cost, Nodulus-estimated cost, and actual billing. A reported zero from a local model is not a measurement of electricity, hardware or subscription overhead.
5. Keep evidence local. No account-wide dashboard scraping, private CLI database reading, new credentials, telemetry SaaS dependency or network price lookup in the run path.
6. Use nullable measurements plus completeness diagnostics. Unsupported telemetry must not invalidate a valid work artifact or trigger another provider call.

## Explicitly deferred

Account billing reconciliation, subscription credits/remaining allowance, live dashboards, OpenTelemetry export, full provider tool-event visualization, network rate-card refresh, GPU/electricity estimates, and session-export recovery are later slices. Session-export recovery would require an explicit session ID, installed-version command verification, message/call attribution and deduplication; it must never rerun inference. None is required for this plan's first implementation.

Boundary logs record what Nodulus sends to and receives from the CLI. They cannot claim to capture hidden provider system prompts, server-side transformations, every internal file read, or unreported tool/model calls.

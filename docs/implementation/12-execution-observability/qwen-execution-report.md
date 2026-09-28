# Local Qwen completion report: OBS-001 and OBS-002

Date: 2026-09-28. Base: `42397bc`; implementation branch: `codex/observability-qwen`. This supersedes the earlier [packet experiment](packets/report.md), which stopped without implementing OBS-001. The user explicitly authorized continuing to completion, model/OpenCode tuning and coordinator roadblock fixes. No release was published.

## Outcome and attribution

OBS-001 and OBS-002 are implemented, tested and accepted after focused GPT-5.6 Sol review. Qwen was invoked through Nodulus and OpenCode on this machine, not through a hosted Qwen or GPT builder endpoint. Qwen generated the first test drafts, prelaunch fixture, capture helper, event helper and corrections. The coordinator fixed invented helper/import names, fixture setup, mismatched edits and integration/type issues, wired production calls/events, added review regressions and ran checks. This was **supervised Qwen-assisted delivery, not autonomous Qwen completion**.

Nodulus now captures effective stdin and safe call metadata before inference for Codex, Cursor and OpenCode, retains bounded transport evidence and links raw output, validation and accepted results. New events have UTC timestamps and per-run sequence numbers. Invoke/repair calls have separate IDs and parent links; intake/resume follow the same timeline rules. These changes apply to workflows generally and contain no Qwen/task-specific branches. Usage parsing, cost estimation and richer status views remain OBS-003 onward.

## Local setup and what changed

- Windows, Node 24.15.0, OpenCode 1.18.32, Ollama 0.32.15; RTX 5070 Ti 16 GB, 64 GB system RAM.
- Started from installed Qwen 3.5 9B. Repeated empty/malformed/wrong-envelope or incorrect-code output did not improve enough with more prose or a 32K-context alias.
- Reused the already installed `qwen2.5-coder:14b` weights as `qwen-nodulus-coder:latest`, with context 16384, temperature 0.2 and output cap 8192. No model download. Local `/api/ps` confirmed 14.8B Q4_K_M, context 16384 and 10,388,735,261 bytes in VRAM. This is a machine-specific measured choice, not a universal model recommendation.
- OpenCode provider endpoint: `http://127.0.0.1:11434/v1`. Final configuration enables only `ollama`; both `model` and `small_model` use the local alias. Build/response agents deny every tool for these artifact-only assignments.
- Enabled JSON-object mode via model/agent options. The final calls used the normal OpenCode executable; an earlier local diagnostic wrapper stripped only whole valid JSON Markdown fences while retaining original NDJSON. That wrapper was not shipped as product behavior.
- Kept each assignment small: one file or a narrowly specified correction, actual source and helper signatures, explicit full outcome example. Requests did not rely on tool-denied agents reading repository files.

The configuration follows [OpenCode agent options](https://opencode.ai/docs/agents/), [AI SDK OpenAI-compatible provider options](https://ai-sdk.dev/providers/openai-compatible-providers) and [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility). JSON mode improved syntax in this run; it did not establish code correctness.

## Observations and disposition

| Observed failure | Response | Result |
| --- | --- | --- |
| Read/plan/prose without a reliable edit in earlier experiment | Generate a file artifact with all required context and no tools | Inspectable drafts, but still needed integration |
| Fences or wrong top-level keys | JSON-object mode and complete outcome example | Final review returned a valid artifact in one call |
| Invented test helpers and wrong fixture paths | Supply exact signatures and independently execute tests | Harness failures excluded from RED evidence |
| Whole-file content wrapped in Markdown inside valid JSON | Preserve raw artifact; inspect exact diff and explicitly remove outer source fence | Two result/invocation refs integrated; recorded as coordinator correction |
| Test failure from new event fields in old exact-shape assertions | Preserve old asserted values and add timestamp/sequence expectations | Existing request-intake tests pass with additive metadata |
| Resume writer omitted timestamp/sequence | Add regression, observe RED, use shared event writer | Resume sequence regression passes |
| Sol found missing accepted-result refs, mapped-artifact coverage and false successful call completion | Add failing assertions for missing refs/non-string responses, add real mapped-artifact coverage, fix tracing | Sol accepted the revised checkpoint |

Schema success is not implementation success. The run store retained invalid responses, rejected reviews and repair attempts; we did not rewrite raw artifacts to conceal mistakes. The repository-specific [artifact workflow](../../../examples/qwen-artifact-workflow/README.md) and [task-packet skill](../../../.agents/skills/nodulus-task-packets/SKILL.md) preserve this distinction. Applying code remains supervised; no automatic apply command was shipped.

## Measured execution and usage

The sanitized [run ledger](qwen-run-ledger.json) records 20 Nodulus runs: 34 provider invocations including repairs, 35 unique reported model step-finish parts, 129,604 reported input tokens and 27,491 reported output tokens. Twelve runs reached schema-valid success; that count includes drafts requiring correction and is **not** a count of accepted implementations. Sum of recorded provider elapsed times: 689.081 seconds; this is not total elapsed project time or pure GPU time.

Counters were extracted from retained OpenCode `step_finish` records and deduplicated by `(sessionID, part.id)`, using the old provider transport tree once rather than double-counting the new call transport copies. Assistant/session totals were not added. These are reported counters, not normalized billing or verified cache semantics. Nodulus `metrics.json` still stores `usage: null`; automatic parsing is future OBS-005. No dollar charge is inferred from local execution. Electricity/hardware and Codex coordinator/GPT-5.6 Sol account usage are not available here.

Representative evidence:

| Run ID | Purpose and result |
| --- | --- |
| `2acf4188-b26e-4a53-8a24-aff920833a72` | Capture-helper draft generated by Qwen; coordinator integrated |
| `ff0591aa-bbf6-4604-9ea6-46b5b78159de` | Event-helper draft generated by Qwen; coordinator corrected interfaces/serialization |
| `9f9c0912-65dc-4e7f-95be-dc3377aea585` | First review failed its envelope, with two bounded repairs; all three new call records and 16 sequenced events retained |
| `fce131da-c6b6-4ed8-9846-aaa1b54dd330` | Result/invocation-ref correction; artifact passed schema but source fence required explicit coordinator normalization |
| `c8744fe6-d71e-4d5f-bee1-148d8435f1b7` | Final focused local Qwen review accepted capture/event helper code; one invocation, six sequenced events, linked accepted result |

The final review ran `node dist/bin.js run --workflow qwen-review --request-file .nodulus/requests/obs001-002-qwen-review-final.md --json` against the newly built code. Its call ID was `487008ed-df81-4516-b5e0-2844baad6c06`; request/transport/invocation/result refs resolve in the local run. Raw prompts, transcripts and setup files remain in this worktree's `.nodulus/`, outside the committed diff. Live proof is Windows OpenCode/Ollama only; offline fixtures cover all three adapters.

## Generic Nodulus improvements

Delivered in this slice:

1. Effective request records before inference, making adapter suffixes and repair feedback inspectable.
2. Stable call IDs and response/validation/result links, including separate repair attempts.
3. Timestamped sequenced events across intake, execution and resume, with monotonic elapsed durations.
4. Safe prelaunch persistence failure and accurate tracing of invalid custom-provider return types.

Prioritized future work, not implemented here:

1. Complete OBS-003–009: call-scoped usage extraction, deduplication/coverage, failure diagnostics and status summaries. Manual transcript accounting was necessary in this experiment.
2. A generic reviewed-change artifact applicator with explicit path allowlists, stale-base hashes, atomic application and receipts. The coordinator currently supplies this boundary; a JSON Schema alone cannot prove a safe/correct edit.
3. Separate envelope validation from code/review acceptance gates. Reject fenced source and require actual fixed test evidence; a valid `changes_required` review must not imply delivery success.
4. Provider/context/output budgets with explicit per-workflow total limits and observed internal-step counts. A timeout or OpenCode step setting alone is not a usage budget.
5. Small resumable work packets with deterministic context preparation and stable test hashes, so a rejected packet does not force another broad repository-reading session.

Keep Ollama aliases, source paths and test commands in repository workflows; keep capture, correlation, validation and future budgeting generic in Nodulus. Increasing instructions indefinitely was not the successful intervention: local model/configuration tuning, bounded artifacts, executable evidence and focused independent review were all needed.

## Acceptance

`npm run check` passed on Windows: lint, typecheck, 41 scenario files / 164 tests and 7 archive/install tests. Focused OBS/prov007 check passed 29 tests. Example definitions passed through real application intake/storage/contract validation with an external provider fixture (no live inference). GPT-5.6 Sol accepted the revised implementation; its review did not run tests or call models. See [evidence](evidence.md) for exact RED/GREEN and hosted results.

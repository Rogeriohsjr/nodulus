# Local Qwen execution report: OBS-001–005

Date: 2026-09-28. Base: `42397bc`; implementation branch: `codex/observability-qwen`. This supersedes the earlier [packet experiment](packets/report.md), which stopped without implementing OBS-001. The user explicitly authorized continuing to completion, model/OpenCode tuning and coordinator roadblock fixes. No release was published.

The first sections retain the historical checkpoint A record. The dated checkpoint B continuation below supersedes its pending-usage statements. See [hiccup history](qwen-hiccups.md) for the incident chronology.

## Checkpoint A: outcome and attribution

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

## Checkpoint B continuation: OBS-003, OBS-004, OBS-005

Date: 2026-09-28; base `9cca96b`, branch `codex/provider-usage-qwen`, stacked on the OBS-001/002 branch. **Implemented and locally accepted after GPT-5.6 Sol review.** The current [provider guide](../../provider-usage.md) describes saved records and conservative normalization. OBS-006–012 remain pending; basic malformed-counter/partial guards do not constitute their full acceptance matrix.

Qwen generated test/parser drafts, a small counter-summing helper, the three documentation-node JSON definitions, and two documentation drafts through Nodulus → OpenCode → localhost Ollama. The coordinator corrected harness APIs, omitted assertions, protocol field owners, null handling, identities, version semantics and unknown guards; supplied the shared telemetry contract, parser composition, persistence/core integration, added negative regressions, and corrected documentation. Most production drafts were either rejected or edited before acceptance. **This was still supervised development, with substantial coordinator implementation—not an unattended Qwen SDLC.** No GPT builder subprocess was used; coordinator and Sol account usage remain outside the local ledger.

### Evidence and usage

- Meaningful RED: OBS-003 at 11:09:10 EDT and OBS-004 at 11:10:27 had missing telemetry after successful fixture inference; all five initial provider assertions failed at 11:13:24. Invalid imports/async callbacks were harness failures and are excluded.
- Initial five GREEN plus lint/typecheck at 11:25:57; expanded 16 cases GREEN at 11:27:28. A later real two-node readiness-failure regression proves the second call cannot inherit the first call's usage. Its initial wrong fixture path/error-code expectation was corrected as test setup, not product RED.
- DEV-001 sequence RED at 11:32:07: missing `dev-document` and review continued when that step should reject. Seven cases GREEN at 11:34:47 cover ordering, both review input mappings, explicit rejection, empty documentation and the final quality gate. A coordinator initially used the wrong validator stdin shape; corrected to artifact data, without claiming that as behavioral RED.
- The first full suite caught a real compatibility regression: unavailable legacy `usage` changed from null to an all-null object. Core now preserves null while retaining the telemetry diagnostic record; the existing assertions were unchanged. Twelve focused compatibility/Codex tests passed at 11:38:38.
- Final `npm run check`: lint/typecheck, **44 files / 183 scenario tests** at 11:40:18 and **7 archive/install tests** at 11:40:34, Windows Node 24.15.0. Hosted platform evidence is recorded separately in [evidence](evidence.md).
- GPT-5.6 Sol inspected checkpoint B and accepted it with no blocker. Qwen's focused review `40e8cb8e-9812-459a-819d-72ce5fcaef3e` returned accept; it saw supplied code/check evidence, did not independently execute tests, and cannot certify all-suite results on its own.

The [checkpoint B ledger](qwen-phase-b-ledger.json) records **19 runs, 23 provider calls including repairs, 24 unique step-finish parts, 71,688 reported input tokens and 20,838 reported output tokens**, with 593.333 seconds summed call elapsed time. It supplements, rather than replaces, the earlier 20-run ledger. These are captured provider counters, not billable account totals or total engineering time. Local vendor-reported zero does not price electricity/hardware. No cloud Qwen or GPT builder endpoint was used.

The last three runs used the newly built telemetry implementation. For documentation run `0d671e32-f1b7-4d5a-b828-64666a367a81`, call `2e40f115-445a-4bc4-b70f-3520c3f3763b` saved reported and normalized input 1596/output 629, one step, complete record coverage, cost 0, reportedModel null and a resolving transport reference. Automatic counters were independently matched against raw unique step parts. This is live Windows OpenCode/Ollama proof; Codex/Cursor remain offline-fixture proof for this slice. Old runs were not backfilled.

### Documentation in the flow

The tool-writing example now runs tests → test review → implementation → **Qwen documentation** → Qwen review → GPT-5.6 Sol review/quality gate. Both reviewers receive documentation. A deterministic validator rejects missing/empty/out-of-repository documentation paths; it does not prove content is new or correct. The full six-node tool-writing flow was fixture-tested, not run unattended live here.

The tool-denied artifact example has a separate `qwen-document` node for supervised dispatch after implementation. Its two live runs produced valid artifacts, but the first generalized version-specific normalization and the second invented a required reported model and “cursor/bucket normalization.” The coordinator corrected these before saving [the guide](../../provider-usage.md). This demonstrates why documentation requires the same evidence review as code.

### Improvement scenarios, history and acceptance

This catalog gives the motivating scenario and disposition for the earlier improvement suggestions as well as new findings. Product proposals apply to any provider/workflow; Qwen aliases, repository paths and fixed test commands stay in repository examples/skills.

| ID / disposition | Observed scenario and history | Change and why it helps | Acceptance scenario |
| --- | --- | --- | --- |
| IMP-01 delivered A | Base prompts omitted adapter suffixes and repair feedback; tracing a rejected envelope required joining unrelated files. | Persist effective stdin before inference with call IDs and refs. This identifies exactly what each boundary received. | A fixture reads its own prelaunch record; stdin matches byte-for-byte and accepted result/validation refs resolve. |
| IMP-02 delivered A | Resume events lacked timestamps/sequences, and non-string custom output appeared successful in logs. | Shared timeline writer plus accurate call failure records reconstruct order across processes. | Pause/resume produces increasing sequence/time; invalid custom return is logged as failed and blocks successors. |
| IMP-03 delivered B; C–D pending | Both experiments required manually counting OpenCode parts; duplicate assistant totals could inflate results. | Call-keyed parsers, identity dedup and nullable semantics automate measurement without extra inference. Broader failed/resumed aggregate coverage is still pending. | Fixture A+B+duplicate yields 300 input/60 output, then live raw parts equal saved call telemetry; later OBS-008/009 must verify resume/unknown subtotals. |
| IMP-04 proposed generic applicator | Schema-valid source drafts contained fences, incorrect replacements or stale assumptions. Coordinator still checked/applied every change. | Allowlisted paths, base hashes, atomic application and receipts establish a deterministic edit boundary. This prevents silent stale/out-of-scope edits; it does not make code correct. | A stale hash, escaped path or failed multi-file write leaves the checkout unchanged and records rejection; valid changes produce an auditable receipt. |
| IMP-05 partly delivered in examples | JSON-valid parser drafts used wrong protocol owners/null→zero; a docs draft misstated normalization. | Separate envelope validation from compile/test and factual review gates. Existing final quality gate and new docs existence gate help, but artifact application still needs a generic executable acceptance gate. | Valid JSON with wrong behavior fails fixed tests; a schema-valid changes_required review stops delivery; accurate source+docs+checks advances. |
| IMP-06 proposed workflow budget | `04b` needed two response repairs (three calls, 144.8 seconds) before the bad source could even be inspected. Per-call limits did not bound the whole assignment. | Count all calls/repairs/internal steps against a captured per-workflow budget and stop before a new call exceeds policy. This contains repeated failure cost. | With budget 2, a primary plus repair consumes both; no third inference launches, and the stop reason and spent usage persist. |
| IMP-07 partly delivered in packet skill | Early tests invented helper/import names and combined parser drafts mixed validation, protocol extraction and normalization. The narrow sum helper was usable with two small corrections. | Supply exact signatures and one literal protocol record; split responsibilities into resumable packets. Deterministic context preparation and automatic stable-hash receipts remain proposals. | A packet can be resumed with the same allowed paths/test hash and exact failure, without a broad repository-reading call; fixed tests still guard semantics. |
| IMP-08 delivered in documentation node | 9B returned both content and edits, violating oneOf and consuming two repairs; source was still wrong after schema success. | Select one output representation per node. The new documentation contract uses full content only, reducing envelope ambiguity. | A content-only document succeeds; an edits key is rejected; no duplicate representation is accepted. This does not promise fewer model mistakes in every run. |
| IMP-09 delivered wiring; factual acceptance supervised | Docs previously lived outside the development sequence; two live doc drafts made unsupported claims. | Add documentation after implementation and feed it to both reviews. Supply actual evidence and require reviewers to check claims. | Empty/missing docs stop before review; reviewers reject a nonempty document that contradicts the tested version rules. The latter remains a review responsibility, not a semantic validator. |
| IMP-10 proposed evaluation harness | 9B failed larger tasks; 14B produced usable small drafts but also wrong protocols. The second 9B trial still failed despite reasoning disabled. | Benchmark identical bounded packets across models/configurations, recording accepted-without-edit rate, repairs, tokens and latency. This separates capability evidence from model-size assumptions. | Repeated runs on fixed source/tests yield comparable receipts; changing model alone is never recorded as success without unchanged checks passing. |

The packet skill's four-primary-call default is a starting experiment budget, not what this three-story completion used. We deliberately continued after model/config changes under the user's completion authorization, for 19 total bounded dispatches. This exception and the extra manual work must be visible when assessing cost or autonomy.

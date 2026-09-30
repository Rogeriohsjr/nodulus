# Checkpoint C: reusable planning and one OBS-007 pilot

Date: 2026-09-29. Base: `4cf11ec`, Windows, Node 24.15, OpenCode 1.18.32. This report supplements the [earlier execution report](../12-execution-observability/qwen-execution-report.md) and [hiccup history](../12-execution-observability/qwen-hiccups.md); it does not rewrite their conclusions.

## Outcome and attribution

The reusable `task-plan` workflow classifies ready/split/blocked tasks and validates repository, dependency, file/symbol, test/check and documentation ownership. `nodulus-task` prepares bounded context, requires explicit reviewed-test hashes and observed RED, and selects packets. The execution validators apply one allowed unchanged file, run fixed checks and preserve receipts. Documentation-only packets use a separate path. This is a supervised workflow example and packaged helper, not a new core scheduler or sandbox.

Local Qwen planned OBS007A, generated its production change, updated documentation after a rejected draft, and accepted the final review. The production change isolates optional `telemetry.json` write failures: a valid artifact and token counters survive, a diagnostic remains in in-memory/call metrics, and inference is not repeated. The parent OBS-007 and OBS-006/008–012 remain incomplete.

The coordinator wrote the reusable infrastructure, most integration/regression tests, configuration and reports. Qwen's plan-test draft required corrections; its validator draft was rejected and replaced. Its OBS007A test draft needed coordinator harness/type corrections after one Qwen correction (remove duplicate assignment to a const, annotate parsed control data and handle nullable metrics). Qwen wrote the production try/catch; the coordinator removed the unused catch binding after lint. A coordinator-created remaining-phase workflow completed docs/review without replaying accepted code; a trailing blank line in the accepted Markdown was normalized before commit. These are substantial interventions: **this run does not establish unattended development**.

## Locality and measured usage

Both OpenCode model roles used `ollama/qwen-nodulus-coder:latest`, the installed Qwen2.5-coder 14B alias, at `http://127.0.0.1:11434/v1`. Only Ollama was enabled and model tools were denied. No cloud builder fallback or model download was used. The alias was retained; this run did not compare 9B with 14B.

The [C ledger](qwen-phase-c-ledger.json) records **10 runs, 14 provider calls, 2 response repairs, 42,896 reported input tokens and 8,081 reported output tokens**, with **242.615 seconds** summed provider-call elapsed time. Independently deduplicated raw transports contained 15 unique step-finish parts with the same token totals. These are local inference counters, not Astra/Sol account usage or engineering time. Provider-reported zero cost excludes hardware/electricity. Coordinator and reviewer usage was not measured by Nodulus.

The first empty artifact consumed two repairs; subsequent artifact-only assignments disabled automatic response repair. Three additional supervised correction runs covered plan tests, OBS007A tests and docs/review recovery. A tiny probe verified JSON output but did not count as implementation. The initial four-call packet experiment allowance was exceeded under the user's broader completion/supervision authorization; the actual ledger is retained rather than implying compliance with that initial target.

## Execution sequence

| Packet | Observed result | Disposition |
| --- | --- | --- |
| 01 + repairs | Empty result, repair exhaustion | Rejected; disabled repair capability for the experiment |
| 01a | Tiny exact JSON probe passed | Readiness only; never applied |
| 01b / 01c | Plan test drafts used wrong field ownership, then partial correction | Coordinator corrected nested fields and unused data; observed six behavioral failures before validator implementation |
| 02 | Schema-valid validator draft invented a different input structure and did not implement stdin validation | Rejected entirely; coordinator built deterministic validator |
| 03 / 03b | OBS007A test draft then correction retained duplicate assignment and type issues | Coordinator repaired harness, inspected assertions, observed actual missing-behavior RED |
| 04 | Planner returned valid ready/OBS007A packet | Accepted first attempt with exact context hash |
| 05 code | Qwen full-file change applied; frozen scenario passed | Source accepted by fixed behavioral check; broader lint caught unused catch binding |
| 05 docs | Wrong outcome envelope, malformed JSON | Stopped before documentation acceptance and review; raw response retained |
| 06 | Literal wrapper + concise scope request produced valid docs and accept review | Docs applied and checks passed; accepted dependency receipt saved |

The frozen OBS007A test SHA-256 remained `4abb49976a55114a7d0dfc3798c4b40db9883b5fc5c867346b90686ba47d7aa5` from approval through completion. The local completion receipt is `.nodulus/task-completed/9eb5705adfd8af2e99150d822590bcf748e72def652001e9fce0336081a7c0b9/OBS007A.json`. Its execution ID is `3f2939c5-ce8b-4bae-8378-396d6cd1f473`. Raw prompts/responses remain under the run IDs in the ledger; they are not committed with private workstation paths/context.

## What changed from checkpoint B

B covered three provider parsing stories and used 19 runs / 23 calls / 92,526 reported input+output tokens. C covered infrastructure plus one narrow runtime behavior and used 10 runs / 14 calls / 50,977 tokens. The workloads differ, so this is **not an efficiency benchmark** or proof that planning caused the reduction.

The concrete improvement is the evidence boundary: Qwen's implementation artifact now went through an actual allowlisted apply/check validator, tests stayed frozen, and a failed documentation envelope blocked the next node. The previous workflow relied on coordinator application and checks. Manual recovery, rejected test/validator drafts and code-quality cleanup remain. The detailed packet worked well for the tiny runtime change, but richer specifications alone did not make the validator generation reliable.

## Improvements with motivating scenarios

| Improvement / current state | Observed scenario | Why it helps / acceptance needed |
| --- | --- | --- |
| IMP-04 partial: one-file applicator shipped | A valid artifact could otherwise overwrite stale files or escape its assignment | Allowed paths, two base-hash checks, atomic single-file replacement and receipts now reject those cases. Multi-file transactions remain unimplemented; do not claim the earlier multi-file acceptance case passed. |
| IMP-05 partial: executable gates shipped | Qwen's source passed its behavior test but failed lint; a docs envelope was invalid | Fixed checks and frozen hashes stop incorrect advancement. Configure lint/typecheck along with behavior checks before dispatch. A model accept is still not independent quality proof. |
| IMP-07 partial: reusable planner/context shipped | Qwen invented nested fields and an unrelated validator interface | Captured source, exact contract, trusted check IDs, dependency receipts and small packets reduce guessing. Remaining-phase recovery is still supervised. |
| IMP-06 still proposed: workflow budget | First empty result launched two useless repairs | A generic budget should count initial calls, repair calls and internal steps before launch. Current timeout/disabled repairs are limited substitutes. Test that no third call launches after a two-call budget. |
| IMP-11 proposed: phase-aware recovery | Code passed but docs failed, and replaying code would be unsafe | Persist accepted artifacts/check identities and resume only the rejected phase after bounded correction. Test docs failure → docs/review recovery with zero additional code inference/application. This run used a local supervisor-created recovery definition. |
| IMP-12 proposed: stronger independent test approval | A RED substring could come from an unreviewed or weak test | Exact reviewed-test hash is now required; future approval artifacts should bind reviewer, task/context and assertion evidence. Test mismatched hash/changed definition and retain actual RED stdout. The current hash argument is explicit operator approval, not signed attestation. |

Product proposals should remain provider-neutral. Qwen aliases, manifest paths, OBS007A checks and the corrective request belong to repository configuration. Next work should apply the planner to one remaining OBS-006/007 behavior, with lint/typecheck in its manifest and an explicit per-packet call allowance. Do not broaden to all remaining OBS stories until the remaining-phase recovery and intervention rates are understood.

## Verification

See [evidence](evidence.md) for precise RED/GREEN, package and review results. Hosted checks are separate from Windows live-local-provider proof. Qwen review consumed supplied artifacts/check evidence and did not execute checks itself.

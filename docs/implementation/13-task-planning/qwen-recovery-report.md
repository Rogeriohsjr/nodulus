# Phase D: recovery benefit and local-Qwen limits

Date: 2026-09-29 (EDT). Base: integration branch `e3441c7`. Work branch: `codex/phase-recovery`, targeting `codex/workflow-integration`. No main merge or publication is part of this experiment.

## Result

The planning report's **IMP-11 phase-aware recovery** is implemented in the packaged task helpers. A controlled live run demonstrated one accepted code inference/application, an injected documentation rejection, then successful documentation/review recovery without repeating code. The original test stayed unchanged and passed. This proves the bounded recovery behavior, not unattended development.

Qwen needed substantial supervisor intervention to implement the improvement. More detailed prompts and smaller files did not make the builder reliable in this run. The useful performance gain is removal of hand-authored remaining-phase workflow definitions and avoidance of repeated accepted code. We did not establish a statistical latency or token reduction against an identical baseline.

The next small packet, **OBS006A**, adds a real OpenCode-process nonzero-exit regression. Existing production behavior already retains reported usage, labels coverage partial, preserves exit/transport evidence, leaves normalized totals unknown and avoids inference during repeated status reads. This was characterization, not fabricated RED/GREEN or a new production fix. Parent OBS-006 remains open.

## Model locality and usage

Both OpenCode roles used `ollama/qwen-nodulus-coder:latest` at `http://127.0.0.1:11434/v1`, with only Ollama enabled and tools denied. The installed alias is the existing Qwen2.5-Coder 14B setup; this run did not switch models. OpenCode was 1.18.32 and Node 24.15.0. Ollama's installed updater changed 0.32.15 to 0.35.0 while the initially unavailable endpoint came online; the coordinator did not issue an install command. This version change is a comparison confounder.

The [sanitized ledger](qwen-phase-d-ledger.json) records 18 runs, 19 actual local inference calls and one deliberately injected boundary call. There were zero automatic response-repair calls. Totals: **59,925 reported input tokens, 15,187 output tokens**; normalized input including reported cache reads was **67,155**. Summed captured provider-call time was **430.198 seconds**. Provider-reported cost was $0; electricity and separate coordinator/Sol account usage are excluded and were not measurable here. Raw `step_finish` input/output counters were independently deduplicated by session/part identity and matched saved telemetry for every real call.

This exceeded the skill's default four-primary-call experiment budget. After the first combined packet failed twice, the supervisor explicitly changed scope to three micro-responsibilities to complete the authorized task. The extra calls and manual fixes are a cost of the experiment, not evidence of improved builder efficiency. No cloud builder fallback was used; GPT-5.6 Sol performed focused review.

## Packet history and attribution

| Packet | Observed result | Disposition |
| --- | --- | --- |
| 01 / 01b planner | Both used `NEW function.` instead of the required `NEW:` marker | Raw plans preserved. Supervisor corrected the marker and added lint/typecheck IDs; selection revalidated the reviewed plan. Planner was not autonomously accepted. |
| 02 / 02b recovery tests | First returned an unusable error; second invented paths and omitted the initial workflow | Rejected. Supervisor authored the real workflow/process harness; all nine initial assertions failed for missing recovery behavior. |
| 03 / 03b combined implementation | Both applied runtime drafts failed all nine cases and lint; neither persisted accepted artifacts or generated a usable workflow | Rejected drafts preserved. Supervisor restored only this task-owned source and split responsibilities. |
| 04 persistence | Malformed JSON; acceptance data outside the successful branch and not persisted | Rejected. Supervisor implemented accepted-phase persistence. |
| 05 / 05b verifier | Invalid array equality, wrong receipt owners/paths and missing verification; correction still referenced an undefined variable | Rejected. Supervisor wrote the verifier against the frozen requirements. |
| 06 / 06b generator | Correction improved the draft but three positive scenarios still failed | Qwen draft applied with a receipt. Supervisor fixed conditional docs-only inputs, caller contract declaration, empty-file hashing, erroneous documentation input, directory creation and lint's unbound-method finding. |
| Live exercise | Actual Qwen code, generated-recovery docs and review all accepted | One code call/application; injected invalid docs result was the controlled trigger. Frozen assertion passed after recovery. |
| 07 / 07b OBS006A | Invented telemetry fields; correction introduced a contradictory zero-call assertion | Supervisor corrected metric ownership, null assertions and contradictory count. Test passed against existing production code. |
| 08 / 08b documentation | First claimed source tests were mocked and misstated recovery outcome; correction used literal placeholder artifact names | Both rejected as delivered. Supervisor wrote the factual implementation note and updated public guidance. |
| 09 Qwen review | Accepted integrated code/docs without findings | Advisory model review only; no claim that the model ran checks. |
| Sol review | Found setup omitted two new helper dependencies | Supervisor added installed-archive RED, fixed both copy/preflight lists, and added three recovery negatives. Final re-review/check evidence follows below. |

All artifact-only dispatches reported unchanged allowed-file scope. The two task-implement attempts changed only their assigned runtime file through validators. Original recovery assertions remained frozen through Qwen implementation attempts; three supervisor-authored negative cases were added afterward for check failure, check mutation and phase order. Raw requests/responses and receipts remain locally under `.nodulus/phase-d` and `.nodulus/runs`; they are not committed. The ledger supplies run IDs without publishing workstation paths or transcripts.

## Measured recovery result

| Observation | Phase C baseline | Phase D evidence |
| --- | --- | --- |
| Remaining-phase definition | Supervisor constructed a local finishing workflow | One deterministic preparation command generated nodes/mappings/inputs |
| Accepted code replay | Avoided by manual intervention | Generated workflow has no code node; live and offline tests observed one code inference/application overall |
| Integrity before continuing | Supervised inspection | Frozen files, accepted artifact/check hashes, trusted rechecks and post-check hashes verified |
| Builder autonomy | Substantial intervention | Still substantial intervention; no improvement established |

Live initial run: `08215bd3-80f8-42aa-82cf-57c7c49db067`. Recovery: `c4434ecf-e0bc-4a2d-a67f-344dd1b17e02`. Actual provider nodes were `packet-code`, `recovery-docs`, `recovery-review`; `packet-docs` was intercepted once with `{}`. The fixture assertion failed as `41 !== 42` before Qwen changed the source and passed afterward. There was one accepted source replacement and no test edit. The initial harness had a supervisor import-path typo before inference; it was fixed and was not counted as behavioral RED.

## Improvements worth pursuing next

| Priority / status | Motivating scenario | Why it helps and how to judge it |
| --- | --- | --- |
| Delivered: phase-aware recovery | Phase C needed a hand-built workflow after accepted code and failed docs | Generated remaining nodes replace that manual work. Keep the one-code-call/application and stale-evidence regression tests. This is helper-level delivery, not generic core resume. |
| Next: bounded local capability evaluation (existing IMP-10) | Even a small verifier and exact field instructions produced incorrect drafts | Run identical tiny packets against the current alias and another already-installed local configuration, with one correction maximum and unchanged assertions. Compare accepted-without-edit rate, tokens and elapsed time. Change model/config only if the measured result improves. Do not keep expanding prompts without a comparison. |
| Next: deterministic planner preflight / clearer schema guidance | Two planner calls repeated the same `NEW:` syntax violation | Give one literal valid new-symbol example before inference; test whether the planner passes schema/script validation without supervisor rewriting. If repeated, make the rule structured rather than relying on punctuation in prose. This is proposed, not implemented. |
| Preserve: installed setup acceptance | Source fixtures copied every helper, masking setup's missing dependencies | The real archive test now checks the complete installed helper set and loads recovery in a fresh process. This catches distribution omissions before delivery. |
| Defer: generic budgets and stronger automatic test approval | Calls remained manually bounded, and weak generated tests required rejection | These can help later, but neither fixes demonstrated basic code-generation errors. This run adds no global budget, signed approval, scheduler or concurrency support. |

The earlier observability report used **IMP-11** for a packaging-gate lesson; the planning report reused it for recovery. References here explicitly qualify “planning IMP-11” to retain history without pretending those were the same change.

## Acceptance and remaining work

- Recovery: observed nine-case behavioral RED; initial GREEN nine, expanded GREEN twelve, then a thirteenth aliased-entry regression. Includes docs-only/review-only mappings, stale files, tampered artifacts/checks, legacy rejection, one-preparation bound, check failures/mutations and bad phase order.
- Package: installed archive reproduced `setup must install recovery.mjs: expected false to be true` before the setup fix. Final full validation is recorded below.
- OBS006A: one real process regression passes; no production modification or new RED claimed. Timeout, truncated output, output-limit, readiness/crash evidence and other parent requirements remain pending.
- Limits: local trusted state, one execution per dedicated checkout, no crash-atomic multi-file generation, no automatic multi-packet scheduler, no whole-workflow token budget.
- Final local gate: npm run check passed lint, strict typecheck, 235 runtime scenarios and all 8 installed-package tests on Windows (2026-09-29, package phase 21:17 EDT), after shipped documentation and setup changes. GPT-5.6 Sol final delta review: ACCEPT; the setup blocker is resolved. Qwen review: accept, advisory only. Hosted results are separate evidence on the delivery PR and are not inferred from local GREEN.

### Hosted portability follow-up

The first [PR #15 CI run](https://github.com/Rogeriohsjr/nodulus/actions/runs/36654529901) passed Ubuntu but exposed a coordinator-written entry-point bug on macOS: Node canonicalizes the symlinked temporary path, while the direct-invocation guard compared the unresolved argv path. Recovery silently exited without preparing files. A real Windows junction reproduced the same missing-input assertion before the fix. Comparing the real entry path now makes that scenario pass; confinement checks for task file targets remain unchanged. This is a portability correction, not a flaky-test rerun or relaxed assertion. The final current-head checks are attached to [PR #15](https://github.com/Rogeriohsjr/nodulus/pull/15); publication remains out of scope.

Post-portability-fix local acceptance: npm run check passed lint/typecheck, 236 runtime scenarios and 8 installed-package tests (package phase 21:23 EDT). GPT-5.6 Sol accepted the canonical-entry-path delta. Windows and Ubuntu passed the initial hosted run; the follow-up current-head matrix remains the hosted delivery gate.

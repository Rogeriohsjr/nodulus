# Phase E: small local-model comparison

Date: 2026-09-29. User scope: install the requested model, benchmark small tasks, and document the missing reviewer-to-developer loop. **No product source, product tests, existing workflow defaults or model-generated benchmark code were manually changed.** New repository files are documentation/evidence only.

## Installation and configuration

Installed the exact `qwen3.8:27b-q4_K_M` tag from the [official Ollama library](https://ollama.com/library/qwen3.8/tags), digest prefix `25b843619e94`. Local metadata reports 27.3B parameters and Q4_K_M quantization. The machine has an RTX 5070 Ti with 16,303 MiB VRAM and approximately 61.6 GiB usable system RAM.

Created separate benchmark aliases without replacing existing aliases or global workflow settings:

| Alias | Base |
| --- | --- |
| `nodulus-bench-qwen25-14b-8k:latest` | `qwen2.5-coder:14b` |
| `nodulus-bench-qwen38-27b-8k:latest` | `qwen3.8:27b-q4_K_M` |

Both used context 8,192, generation cap 4,096, temperature 0.1 and seed 42. OpenCode's build step allowance was four for the valid comparison. Tools were denied, response format was JSON-object, automatic Nodulus response repair was disabled, and each packet allowed at most one explicit correction after its real checks failed. Thinking was not forced off.

Every model and small-model role pointed to the same local alias for that project. Only Ollama was enabled, at `http://127.0.0.1:11434/v1`. The observed software was Ollama 0.35.0, OpenCode 1.18.32 and the existing globally installed Nodulus CLI 2.1.0-dev.5. The latter predates the new packaged task helpers; it was not upgraded during this experiment. Artifact application used the existing unchanged single-file applicator from source revision `52b03ef`.

During candidate inference, Ollama reported 17,506,930,519 loaded bytes, 13,767,142,275 bytes in VRAM, and context 8,192. This is partial GPU residency, not an all-VRAM run. Latency includes model loading, CLI startup and other runtime overhead; this experiment does not isolate their contributions. [OpenCode's provider guide](https://opencode.ai/docs/providers) documents the local Ollama endpoint configuration.

## Fixed tasks and results

The two models received byte-identical prompts and tests in separate temporary projects. All four baseline fixtures produced assertion failures before inference. Models could return only one complete `source.mjs` artifact. Accepted JSON was applied without edits, then executed against the frozen Node tests. Tests, product file hashes, rejected outputs and receipts were checked after each call.

| Task | Qwen2.5-Coder 14B | Qwen3.8 27B |
| --- | --- | --- |
| Strict numeric aggregation: invalid/unknown values, safe integers, overflow, immutability; 15 assertions | Passed first attempt, 9.527 s | Passed first attempt, 93.252 s |
| Exact ordered phase selection: runtime/docs-only mappings, invalid states and immutability; 14 assertions | Failed initial and one correction; final 10/14 assertions passed; 76.742 s combined | Passed first attempt, 174.816 s |
| Accepted packets without correction | 1/2 | 2/2 |
| Valid-trial Nodulus invocations | 3 | 2 |
| Reported input / output tokens | 5,062 / 695 | 2,313 / 2,486 |

The 14B correction still rejected the valid documentation-only prefix and accepted empty/completed prefixes that the specification required it to reject. Its code was retained as failed; no supervisor repair made it pass. The 27B source passed all 29 assertions and inspection found no test-specific bypasses. The complete requests, tests, final code, hashes, run IDs and counters are in the [sanitized ledger](qwen-phase-e-ledger.json).

**Decision:** use the 27B alias for the next small, strongly tested local builder pilot. This sample favors its correctness over the existing 14B model, while showing substantially higher observed latency. It is only two tasks with one run each, in a fixed order. It does not establish general superiority, statistical reliability, performance on larger repository edits, or autonomous development capability. A later timing experiment should separate cold/warm runs and evaluate documented thinking settings under unchanged tests.

## Hiccup, budget and attribution

The first setup mistakenly limited OpenCode to one step. Its maximum-step instruction caused the baseline to emit error responses such as `Maximum steps reached`. The supervisor stopped only the benchmark's own process tree, preserved the evidence, restored the previously working four-step allowance for both models, and reran from fresh projects. This was a **benchmark configuration intervention**, not a model-code correction. The exact prompts/tests and Ollama parameters did not change.

That discarded setup trial completed five Nodulus invocations and interrupted one. Its completed calls reported 9,325 input / 273 output tokens and took 95.639 seconds combined. The interrupted invocation's complete usage is unavailable, not zero. It is excluded from the model-quality comparison but included as experiment overhead in the ledger.

The valid trial completed five invocations: 7,375 input / 3,181 output tokens, 354.337 seconds combined, no automatic response repairs. Counters were independently deduplicated from saved OpenCode `step_finish` parts by session/part identity. These are reported workflow-step counters, not proof of every CLI-internal metadata request. Reported reasoning tokens were zero; that does not prove the thinking-capable model did no reasoning. Provider-reported dollar cost was zero. Electricity and this separate Codex coordination conversation are not included.

No GPT builder fallback or manual model-code fixes were used. The supervisor supplied the identical benchmark specification/tests, configured the harness, inspected artifacts, applied unchanged artifacts through the existing applicator, and measured the results. The benchmark driver supplied one bounded executable-check correction for the failed 14B task. That driver is a disposable evaluation harness, **not an implemented Nodulus reviewer-feedback loop**.

## Review-loop status and next step

Current task workflows stop on `changes_required`; the phase-recovery feature can continue documentation/review but does not reopen accepted implementation. A valid review requesting code changes does not automatically send findings back to the developer. Response-envelope repair is a different feature.

The [review/rework implementation plan](review-rework-plan.md) defines the intended bounded loop, durable iteration records, frozen-test checks, refreshed documentation, exhaustion behavior and eight executable scenarios. All implementation boxes remain unchecked. The user selected documentation only for this run; no correction-loop runtime was implemented.

Next, assign one narrow review-to-developer scenario to the new local model, after explicit implementation authorization. Require the actual workflow to perform the revision with unchanged tests and without coordinator coding before claiming progress toward autonomy. Keep the larger OBS stories on hold until that result is measured.

## Evidence and boundaries

- [x] Exact requested model downloaded and loaded locally with verified 8K context.
- [x] Two identical tasks, four meaningful starting RED fixtures, real installed CLI/provider runs and real file/check execution.
- [x] Candidate passed all assertions without manual source edits; original product file hashes and benchmark test hashes remained unchanged.
- [x] Invalid setup trial, rejected baseline output and unavailable interrupted usage disclosed.
- [x] Review-loop design documented separately from implemented behavior.
- [ ] Reviewer-to-developer loop implemented or live-validated.
- [ ] Larger tasks, repeated statistical samples or general autonomous development demonstrated.

Raw local evidence is retained under `.nodulus/phase-e` in the integration worktree and the temporary benchmark roots recorded in its local manifest. No model binaries, private workstation paths, raw transcripts or generated product edits are committed. New documentation and the sanitized ledger are the only repository changes from this run.

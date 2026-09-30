# OBS completion run: phase G

2026-09-29. Continues after the bounded review-loop checkpoint in [phase F](../13-task-planning/qwen-review-loop-report.md), commit 1f5ddba / PR #16. That checkpoint passed 244 scenarios, 9 package tests, GPT-5.6 Sol review and hosted Windows/macOS/Linux validation. This report tracks later OBS work separately; unfinished scenarios are not claimed complete.

## Packet evidence so far

| Packet | Local model/configuration | Outcome |
| --- | --- | --- |
| OBS006 timeout/truncation combined | Qwen2.5-Coder 14B, 8K, thinking none | Invalid envelope and incorrect fixture APIs; rejected before application. |
| OBS006 timeout correction | Same | Returned three files outside the one-file packet. Supervisor retained only the test, set timeout inside its temporary fixture, removed a nonportable exit-code assumption and clarified its name. Real timeout characterization passed. No runtime RED is claimed. |
| OBS006 truncated terminal line | Qwen3.8 27B Q4_K_M, 8K, thinking none | First test passed behavior but omitted the inference-count assertion and failed unused-variable lint. One correction added the assertion; corrected draft passed unchanged. 67.195s primary / 61.315s correction. |
| OBS007 malformed counters | Qwen3.8 27B, 8K, thinking none | Draft used .await, wrong envelope/diagnostic fields and invented a fallback log path; rejected without application. |
| OBS007 correction experiment | Qwen3.8 27B, 8K, low thinking, 4096 output ceiling | 212.351s; corrected draft passed six real CLI cases and lint unchanged. Invalid input counters include negative, fractional, unsafe integer, string, object and boolean. Valid raw output counters survived; valid artifacts were not retried. |
| OBS006 readiness/interruption | Qwen3.8 27B, 12K, low thinking | In progress through installed nodulus-task loop: developer, documentation, Qwen review, at most one review correction. Supervisor authored real-process safety regressions and the small port/application integration scaffold. Test hash frozen before inference. |

The timeout and truncation cases characterize existing capture behavior. Existing OBS001 prelaunch file obstruction, OBS003 stale-second-call isolation and OBS007A optional telemetry write failure are reused as evidence rather than duplicated. New meaningful RED: readiness metrics lacked launched, and fresh-process status after an actual killed workflow lacked callEvidence. After integration scaffolding, both tests still fail against the empty status reader. Import or fixture errors are not RED.

## What changed in the experiment

Low thinking had previously consumed its budget on a complex controller. Retesting it on a single small fixture correction produced usable code at roughly five times the primary no-thinking latency. This is a useful measured tradeoff, not a claim of universal quality improvement. A separate loopback-only proxy on 127.0.0.1:11436 forwards to local Ollama 11434 and forces low thinking. The earlier no-thinking proxy uses 11435. Both remain temporary experiment helpers; neither is required by Nodulus. All node and small_model choices remain local Qwen, with title generation and automatic compaction disabled and tools denied.

For the status-reader packet, 12K context gives room for the actual frozen process test, storage interface, current source and review feedback. It reuses installed weights. The model may propose only one application module; repository-specific checks are caller-owned and run by the generic controller. The supervisor's integration is explicitly separate from Qwen's assigned reader implementation.

## Improvement scenario and acceptance measure

- A syntactically valid local model artifact can still call nonexistent APIs. Provide an actual neighboring test, run the same CLI entry point and freeze assertions. Measure accepted drafts without integration edits, not envelope success. The low-thinking invalid-counter correction is one successful sample; the timeout packet required supervisor edits.
- A one-node usage budget can include hidden title or compaction calls. Keep observed provider-request counts alongside Nodulus boundary calls. Profile settings reduce overhead in the measured artifact-only workflow; do not disable useful behavior globally for interactive users.
- A process may be killed after request persistence and before transport finalization. Status must preserve uncertainty and inspect existing evidence without relaunching inference. The new real-process test targets that gap; automatic recovery remains outside this packet.

## Delivery status

Checkpoint D (OBS008/009) is locally and independently accepted. Checkpoint E (OBS010) is implemented with focused local validation and awaits independent review. OBS011/012 remain pending. No release or registry publish. Exact run IDs/raw transcripts remain under the local .nodulus/phase-f experiment ledger and its referenced temporary project run stores.

## Checkpoint C accepted results

Full checkpoint C `npm run check` passed on Windows: lint, typecheck, 260 scenario tests and 9 installed-package tests. OBS006 covers nonzero exit, timeout, truncated terminal JSON, 2 MiB output cap, readiness not-launched evidence and a controlled killed workflow inspected from a fresh process. OBS007 covers six malformed token cases, valid zero/fractional and invalid cost values, prior-call isolation, prelaunch persistence failure and optional telemetry-write isolation. Later D/E evidence is recorded below.

The status-reader primary low-thinking run (5ae960a2-01a9-45b6-b224-4b110ee4dc34) stopped after 332.369 seconds without final text: reported input3564/output4096, partial coverage. A separate bounded no-thinking correction produced a draft in a 124.707-second controller attempt (Nodulus run b0e61e7f-f7eb-48cf-b223-4c537b296a0a). My harness had put npm-pack array metadata in package.json, preventing the check script from importing its dependency. Renaming it to archive-metadata.json fixed that supervisor mistake. The exact fixed check should have been preflighted before dispatch; checking a similar command was insufficient.

The subsequent real tests found the draft used type instead of the persisted event key. After the model correction limit, the supervisor submitted a corrected artifact (event key plus unused-type removal) through runPhase, which applied it with current-base hashes and reran the unchanged tests. Existing remaining-phase recovery then ran Qwen documentation and review in 113.352 seconds (55b0bf92-0269-404e-ac41-fccd5740f877). Qwen accepted, but the supervisor corrected contradictory documentation afterward. This is a supervised completion; original controller error journals and raw artifacts were retained. No failing run was reset to appear successful.

Output-limit characterization passed unchanged from Qwen. The cost fixture primary passed five behavior tests but failed typed lint for awaiting synchronous cleanup. Its correction was byte-for-byte unchanged; the supervisor removed that await and unnecessary double casts, and added the requested normalized-counter assertions. These corrections are not autonomous Qwen successes.

### Additional improvement scenarios

- Run the exact caller-owned check command before dispatch. Here a similar manual RED command worked while the actual workflow check encountered the supervisors invalid package.json. Using the normal prepare/select sequence and preflighting exact commands avoids spending local inference on a broken harness. The experimental runner constructed reviewed state directly; it did not exercise planner selection.
- Include one literal persisted event payload whenever source types are unknown. The reader packet described an event but did not include a concrete event-key sample; Qwen guessed type. A short real JSON record would remove that ambiguity without expanding the assignment. Tests caught it.
- Detect unchanged corrections before another quality run. A correction artifact that hashes identically to its rejected input cannot fix its lint defect; label it unchanged and stop at the budget.
- Route a failed executable check into a separately bounded revision only after distinguishing environment failures from source failures. The current loop stops safely, which required operator recovery here. Automatically asking a code node to repair an invalid ancestor package.json would be the wrong action. This remains proposed; no unbounded retries were added.
- Keep factual review after the documentation node. Qwen accepted a contradictory description of unavailable evidence; a schema-valid Markdown artifact still needs source comparison. The final Sol checkpoint covers corrected wording.

### Phase G artifact-call ledger

Envelope success is distinct from code acceptance. Raw records are local; IDs below locate the immutable attempts.

| Packet | Run ID | Seconds | Envelope status |
| --- | --- | --- | --- |
| obs006-boundaries | d41845d7-0669-4f73-adcb-d689567e9f63 | 17.151 | error |
| obs006-output-limit | 737b92c0-18cd-4809-9d8f-cc9c91f0818c | 68.244 | success |
| obs006-timeout-corrected | 372d45a0-e84d-4908-9bbe-743cb47b5ff7 | 16.650 | error |
| obs006-truncated-corrected | 704b9e26-24c8-47a9-b82b-77d818665a77 | 61.315 | success |
| obs006-truncated | f25eb732-187a-4645-8ccb-b8aa2de2074f | 67.195 | success |
| obs007-cost-corrected | 6811280a-eee5-4127-a1e8-0795a6be35e0 | 63.916 | success |
| obs007-cost | ab0ae532-d181-49d0-a6d0-bdd0e9235cb1 | 62.210 | success |
| obs007-invalid-corrected | 953fefdc-29d3-4e40-a55c-199a0946bfcb | 212.351 | success |
| obs007-invalid | b92ded16-6338-4a0e-8ffe-651b13caf61f | 40.554 | success |

GPT-5.6 Sol accepted the stable checkpoint after one documentation-only correction: the lifecycle guide now distinguishes its read-only reader from provider/core integration and real-process tests. No source changes followed the 260-scenario/9-package full gate. Review was independent source inspection, not a second test execution.

## Checkpoint D completion

OBS-008 characterizes a five-call invoke/repair/resume sequence with unique call IDs and no replay or recount. OBS-009 adds nullable field coverage, origin and provider/model/node groups, corrupt/legacy diagnostics, and read-only JSON/text status. Independent review found conflicting duplicate IDs, unmatched started calls omitted from group denominators, and shallow telemetry validation; exact regressions were added before the final ACCEPT at `e3ee261`. Hosted run `36672162478` passed Windows, macOS, and Linux; publish was skipped.

The macOS run exposed a supervisor-authored packet error: the fixture compared unresolved `/var` with canonical `/private/var`. The strict path check now compares `realpathSync` values. This was not a Qwen defect. The local-Qwen 12K correction helper also requested a 900-second timeout, but Nodulus clamps invocation timeout to 600 seconds; the call ended at 602.342 seconds with no final text. At the measured throughput, a requested 8192-token output could not reliably finish inside that clamp. Later packets used smaller no-thinking outputs rather than repeating that infeasible profile.

## Checkpoint E implementation checkpoint

At `274d68b`, OBS-010 captures a validated rate card and SHA-256 hash before inference, reuses the run snapshot after fresh-process resume, calculates only from complete verified provider/model telemetry, and keeps provider-reported cost separate. Missing or incompatible evidence stays unknown. Local and subscription estimates require an explicit hypothetical flag. Sequential build plus two focused scenario files passed seven tests; lint and typecheck passed. Independent review was still pending when this documentation checkpoint was written.

Local-Qwen production attribution is intentionally granular:

- Snapshot/parser run `f94a2eba-787a-4f94-8ccf-ec73f4fe41e8` supplied the core validation/hash structure; the supervisor corrected type narrowing and duplicated validation structure before integration.
- Summary primary `0c0bc399-f826-44e2-810e-e9dfed0cb34c` and correction `ccd89baf-83ef-4ab0-8a9d-e7249a10fdf7` supplied the aggregation structure; the correction still accessed a nonexistent `result.estimate`, so the supervisor made the bounded roadblock repair.
- Calculator primary `d627741e-afae-47f5-b16b-465abfb5335b` and correction `eba00865-0ec4-4d03-a622-65f31a8f213c` both changed or misread the frozen telemetry/public types. After those bounded attempts, the supervisor implemented the narrow repair from the generated structure and exact scenario contract.
- The supervisor wrote settings/intake/status/CLI coordinator wiring. Earlier supervisor-written material pricing logic was quarantined under ignored experiment evidence and removed from product files before the production packets ran; Qwen review did not retroactively change its authorship.
- Local-Qwen evidence review `aa88fed4-e28c-4fbf-a6f3-55836136cb92` returned ACCEPT from supplied behavior/results. Bounded source review `c4bd0ac6-2051-4f62-8c1e-9aa28f301119` received the actual calculator and snapshot source and returned ACCEPT; coordinator wiring was explicitly out of its scope. Neither review executed tests. Documentation run `58cb349f-586c-498f-a10e-33a3e3326281` produced the cost guide; the supervisor removed a claim that missing configuration was rejected because absence is intentionally compatible.

The first post-wiring provenance command ran beside typecheck without rebuilding `dist`; its child fixture imports `dist`, so the missing snapshot result was stale-artifact evidence and is excluded from RED/GREEN. Subsequent validation always built first and invoked the CLI tests sequentially.

### Checkpoint E improvement scenarios

- Put public contracts in a frozen reference module and assign the model only the implementation body. Whole-file replacement let both calculator attempts mutate types despite explicit prose. Acceptance is a compile check that proves exported types and signature are unchanged before behavior runs.
- Size packets from observed throughput and the hard invocation clamp. An output ceiling that cannot complete before the effective timeout is a configuration error, not an unqualified model failure.
- Build before any child fixture that imports `dist`, in the same sequential check command. A source-only typecheck does not refresh the installed/runtime artifact.
- Supply the original request, rejected draft, exact interface, and executable error in every correction. The earlier fixture correction omitted prior context and failed for that reason; later self-contained corrections were inspectable even when their source was rejected.

### Checkpoint E independent-review correction

Independent review of `e3ee261..922c736` supplied three counterexamples that the local-Qwen source review and synthetic calculator tests missed. Production adapter evidence is a versioned source URL, not the fixture string `verified`; OpenCode's normalizer makes input/output inclusive even though its raw counters exclude cache/reasoning; and a syntactically valid persisted snapshot could change rates while retaining the hash of discarded external text.

The corrected calculator accepts nonempty adapter evidence, prices disjoint buckets from normalized inclusive totals, and returns unknown when excluded-cache telemetry reports cache writes without a supported write rate. Exact Codex/OpenCode normalizer regressions protect those contracts. Pricing snapshots now retain the exact raw rate card, recompute its SHA-256 on read, and require the stored normalized rates to equal that captured content. A valid-shape rate mutation with the old hash is rejected. These are scenario improvements: future source review packets must include actual adapter-produced objects and valid adversarial persistence examples, not only hand-built nominal objects and broken JSON.

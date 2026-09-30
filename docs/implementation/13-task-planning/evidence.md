# Planning pilot evidence

Date: 2026-09-29. Windows worktree, Node 24.15. Real files/child processes and production `runWorkflow`/CLI entry points; only external inference replaced in offline scenarios.

| Scope | RED observed | GREEN / limitation |
| --- | --- | --- |
| PLAN-001 | 08:32:19 EDT: permissive validator accepted six invalid plans; expected error received success | 08:34:23: all seven passed with deterministic validator |
| APPLY-001/002 | 08:35:08: stub apply/check refused valid operation; expected true received false | 08:36:02: seven passed with real apply/check. Missing receipt errors in other stub cases are not behavioral RED evidence |
| Review regressions | 08:49:14: two-target/test-doc overlap plans accepted; mismatched dependency receipt did not throw | 08:49:55: three regressions and seven execution cases passed |
| OBS007A | 08:48:43: real fixture creates directory at telemetry.json; successful inference returned CLI exit 1, expected 0 | 08:53:56: one scenario passed; artifact, one inference, reported counters and diagnostic verified. Test frozen unchanged |
| PKG-008 | 08:56:52: actual archive built with original HEAD package manifest lacked nodulus-task shim | Proposed package manifest adds executable/helper/assets. RED was a regression check against original metadata after scaffolding, not claimed as the chronological first edit |
| Composition coverage | No fabricated RED for existing pieces composed into workflows | 08:57:04: 37 tests across seven files passed; valid/split/blocked/cycles/crossrepo/exceptions, real CLI hash approval/active/stale selection, docs-only execution, apply/check/review rejection |

Commands: `node node_modules/vitest/vitest.mjs run` with the corresponding `plan-001`, `plan-002`, `task-002` through `task-005`, and `obs-007-telemetry-write-isolation` scenario files. Package regression: `node node_modules/vitest/vitest.mjs run tests/scenarios/pkg-001-installed-archive.test.ts -t PKG-008`.

Lint and typecheck passed after the live Qwen change's unused catch binding was removed. Templates, docs and behavior-preserving lint cleanup use the explicit non-TDD exceptions in [testing policy](../../testing.md); runtime validation/application and telemetry isolation have recorded behavioral RED. Additional composition/CLI regression coverage was added without claiming new RED for already working behavior.

GPT-5.6 Sol initially rejected missing reviewed-test identity, weak dependency identity, executor/plan cardinality mismatch and missing documentation-only flow; all four were corrected with targeted coverage. The unfinished-execution guard was also moved before checks. Final review, complete check and hosted results are recorded below when observed.

Live local runs are detailed in [the report](qwen-planning-pilot-report.md) and [ledger](qwen-phase-c-ledger.json). Planner success alone is not semantic correctness. Local accepted receipts do not certify strong review or whole-parent-story completion.

Post-RED mutation regression: 08:59:26 EDT, two real test commands changed the approved test/source and selection incorrectly returned 0 (expected 1). After rehashing all captured files before saving state, 08:59:36 all eight selection cases passed.

## Final local acceptance

- GPT-5.6 Sol: ACCEPT after focused re-review of the post-RED hash guard; previous contract/identity findings resolved.
- `npm run check`: PASS on the final code/packaged-doc state, 2026-09-29 09:01 EDT: lint, typecheck, 222 scenario tests in 51 files, then 8 actual archive/installation/upgrade tests. PKG-008 verifies the installed shim, bundled hidden workflow assets, helper modules, local provider config and idempotent setup.
- First full attempt: one pre-existing NODE-003 timeout fixture saw its delayed marker despite timeout under concurrent load. The isolated five-case file passed; the unchanged full command then passed. No timeout assertion or production termination logic was weakened. This is an observed intermittent failure, not a proven root cause.
- No public npm release or merge performed. Hosted CI evidence remains separate: see [PR #13 checks](https://github.com/Rogeriohsjr/nodulus/pull/13/checks) for the exact head revision. The PR is stacked on #12.

## Phase D follow-up

Planning IMP-11 adds accepted evidence persistence and deterministic remaining-phase recovery; thirteen source scenarios pass. A controlled localhost-Qwen exercise succeeds with one code inference/application and unchanged test. OBS006A adds one passing nonzero-exit characterization case against existing production behavior. The [new report](qwen-recovery-report.md) and [ledger](qwen-phase-d-ledger.json) record exact run IDs, usage, rejected drafts and supervisor contributions. Final package/hosted checks are recorded in that report.

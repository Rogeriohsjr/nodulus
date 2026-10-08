# INS evidence

## Baseline and boundaries

- Base: `c1bf2d3642539591d3db259b8ccb6ec76aecdfe6` (`feat: add execution observability and supervised task workflows (#18)`); isolated branch `codex/r6-inspection-export`.
- Environment: Windows, Node 24.15.0, npm 11.12.1. `npm ci` passed. The original `C:\workspace\nodulus` checkout and its unrelated changes were left untouched.
- All scenario fixtures use real temporary project/run files. Provider and validator boundaries use sentinel scripts and are asserted absent for inspection, export and replay.
- The source-tree package version is 1.0.0. No public package release, merge or production provider call is claimed.

## Scenario evidence

| ID | RED evidence | GREEN evidence | Independent review | State |
| --- | --- | --- | --- | --- |
| INS-001 | Sol-accepted test checkpoint had 7 behavioral failures (unknown/forward source, contract mismatches, unused declaration, sandbox default); later malformed node/profile cases produced 3 more behavioral failures | `tests/scenarios/ins-001-inspect-workflow.test.ts`: 15/15; uses runtime Ajv definition schemas and shared mapping rules | Final Sol review confirmed schema parity, provider validation and mapping behavior; no remaining finding | Locally accepted |
| INS-002 | Missing public `inspectRun` API was accepted as behavioral RED by Sol; follow-up cases exposed unsafe paused-call advice and contradictory/mispointed validation evidence | `tests/scenarios/ins-002-inspect-run.test.ts`: 1/1; tests cover four saved states, attempts/calls, pending IDs, safe actions, corrupt validation references and immutable reads | Sol ACCEPT after the two read-only safety corrections | Locally accepted |
| INS-003 | Missing export API was the initial RED. Reverting redaction exposed schema/profile leaks; the final saved-run fixture reproduced private `code`, `event`, and `operation` strings verbatim before the fix | `tests/scenarios/ins-003-export-run.test.ts`: 1/1; private marker fields map to generic redaction labels, known event/operation/code values remain stable; includes deterministic output, profile/schema redaction, metadata, CLI and byte-hash immutability | Sol first found a private code leak, then found event/operation strings still escaped. After the second targeted fix, Sol accepted the narrow re-check; the preceding review found no other R6 blocker | Locally accepted |
| INS-004 | Sol-reviewed RED first failed at missing API; fixture corrections aligned it with persisted `response.raw.txt`, `expectedOutputs`, run checkpoint and event formats | `tests/scenarios/ins-004-replay-run.test.ts`: 1/1; valid/invalid/unknown candidates, schema/engine drift, provider/validator sentinels and run-tree hashes | Final Sol review confirmed captured-schema replay and no provider or executable validator invocation; no remaining finding | Locally accepted |
| INS-005 | `tests/scenarios/ins-005-damaged-evidence.test.ts` first failed because a corrupt checkpoint escaped as `RUN_NOT_FOUND` | 1/1; unavailable checkpoint, malformed event/response diagnostics, legacy engine drift and immutable reads | Not separately reviewed | Local GREEN |
| INS-006 | Package test extension covers existing installed archive behavior plus R6 entry points | `npm run test:package`: 10/10 installed-archive scenarios, including all four CLI commands and API imports from the installed package | Package behavior independently executes the actual packed tarball; final full Sol review covered the R6 inspection, export and replay changes | Local GREEN |

## Quality gate and regression recovery

- At base PR head `6884e0e`, the first final Sol review independently found two blockers: a saved `code` value leaked through export, and a Windows validator descendant survived the reported timeout. Corrections were test-first and kept source edits after relevant RED.
- INS-003 correction 1: build passed; focused `npx vitest run tests/scenarios/ins-003-export-run.test.ts` failed because exported `timeline[4].code` contained `PRIVATE_EVENT_CODE_sensitive`. After adding a code allowlist and generic fallback, the focused scenario passed 1/1. Sol then found raw `event` and `operation` strings also escaped.
- INS-003 correction 2: the same focused scenario failed with `PRIVATE_EVENT_TYPE_sensitive` and `PRIVATE_OPERATION_sensitive` present in exported JSON. Closed allowlists now preserve known values and replace unknown values with generic markers. The scenario passed 1/1; final Sol narrow re-check accepted it.
- NODE-003 correction: build passed; the strengthened timeout scenario failed at the descendant PID liveness assertion (`expected false`, received `true`) while the run returned `VALIDATOR_TIMEOUT`. Windows now waits for `taskkill /t /f` to close before resolving the validator result. The focused scenario passed 5/5 on Windows, including descendant termination and delayed-marker absence. macOS/Linux were not run locally.
- Sol independently ran build, lint, typecheck and focused INS-001/003/004/NODE-003 tests (4 files / 22 tests) on the first correction checkpoint. The final narrow INS-003 review ran its scenario 1/1 and accepted the event/operation/code allowlists.
- After these corrections and the final Nodulus run ID/evidence documentation edits, `npm run check` passed on Windows on 2026-10-05: lint and typecheck passed; all 72 scenario files / 300 tests passed; the installed archive suite passed 10/10. `git diff --check` passed (Git emitted only the expected LF-to-CRLF normalization notices).
- No test timeout or assertion was weakened. Fixture cleanup terminates only the known child PID created by the test.

## Nodulus execution records

- Run `767dbd6f-67f9-43a3-9a28-784eb887e1ac` is an actual successful Nodulus readiness workflow using the configured Codex CLI 0.156.1 and requested `gpt-6-luna`; provider telemetry did not report the model name.
- Run `7d35012b-e122-4266-8696-4a8d65bba12d` records the R6 INS-001 implementation node succeeding under requested `gpt-6-luna`. Its later documentation node returned `RESPONSE_REPAIR_UNAVAILABLE`; the run remains a failed workflow and is not used as evidence that documentation passed.
- Run `febcd7ec-5709-4616-8970-eb958d22c80a` records the earlier INS-001 implementation/documentation pass. Its Luna reviewer node failed before running tests because Vitest could not create an SSR temp directory (observed EPERM); this was setup failure, not behavioral evidence.
- Run `724f66ee-5153-4283-90bd-609413a3f2a3` is a requested `gpt-5.6-sol` review workflow that failed before producing a response. Codex CLI 0.156.1 exited 1 during Windows PowerShell shell-snapshot startup, after emitting only startup warnings. It is preserved as a setup failure and does not count as review.
- Run `0b4ca749-57a9-4bb6-935b-b0f0b82b7ac0` completed successfully through the public exported `runWorkflow` API with real Nodulus intake/storage, schema validation and checkpoints. `r6-final-documentation`, `r6-final-checks`, and `r6-final-sol-review` all appear in `completedNodes` and have successful validation records.
- The documentation node validated three nonempty repository Markdown files. The quality node used `.nodulus/validators/dev-quality.mjs`, which ran the fixed `npm run check`; it passed lint, typecheck, 72 scenario files / 300 tests, and installed-package tests 10/10. Its saved validation record is `runs/0b4ca749-57a9-4bb6-935b-b0f0b82b7ac0/nodes/r6-final-checks/attempt-001/validation.json`.
- The review node contains the independent `gpt-6-sol` medium report and acceptance artifact at `runs/0b4ca749-57a9-4bb6-935b-b0f0b82b7ac0/nodes/r6-final-sol-review/attempt-001/result.json`. The existing Sol reviewer independently reviewed the final source/tests; the supervisor supplied that result through the authorized ProviderPort handoff. All three run metrics say `launched: false`, with null usage: this was not a new provider invocation or a claim that Codex CLI succeeded.
- Run `724f66ee-5153-4283-90bd-609413a3f2a3` remains the earlier requested `gpt-5.6-sol` CLI attempt that exited 1 during Windows PowerShell shell-snapshot startup. It is preserved as setup failure and is separate from the successful, supervised API handoff above.
- These run records and local Nodulus configuration remain in the isolated worktree's untracked `.nodulus/` folder and are excluded from the PR.

## Remaining proof

- Source commit `a083f8a` passed both push and pull-request workflows: Ubuntu, macOS and Windows validation passed in runs `37273136452` and `37273142756`; PR title validation passed in `37273154876`. The workflow's publish-main jobs were skipped as expected for this open PR. Fresh CI checks each evidence-only follow-up commit; the attached PR reports its current terminal status. No merge or release is in scope.

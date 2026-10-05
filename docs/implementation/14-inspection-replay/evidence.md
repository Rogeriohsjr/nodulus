# INS evidence

## Baseline and boundaries

- Base: `c1bf2d3642539591d3db259b8ccb6ec76aecdfe6` (`feat: add execution observability and supervised task workflows (#18)`); isolated branch `codex/r6-inspection-export`.
- Environment: Windows, Node 24.15.0, npm 11.12.1. `npm ci` passed. The original `C:\workspace\nodulus` checkout and its unrelated changes were left untouched.
- All scenario fixtures use real temporary project/run files. Provider and validator boundaries use sentinel scripts and are asserted absent for inspection, export and replay.
- The source-tree package version is 1.0.0. No public package release, merge or production provider call is claimed.

## Scenario evidence

| ID | RED evidence | GREEN evidence | Independent review | State |
| --- | --- | --- | --- | --- |
| INS-001 | Sol-accepted test checkpoint had 7 behavioral failures (unknown/forward source, contract mismatches, unused declaration, sandbox default); later malformed node/profile cases produced 3 more behavioral failures | `tests/scenarios/ins-001-inspect-workflow.test.ts`: 15/15; build, lint, typecheck and diff check passed | Sol reviewed the mapping/profile implementation and requested exact Ajv schema parity; that was implemented, but final review of the schema-parity correction is pending | Local GREEN |
| INS-002 | Missing public `inspectRun` API was accepted as behavioral RED by Sol; follow-up cases exposed unsafe paused-call advice and contradictory/mispointed validation evidence | `tests/scenarios/ins-002-inspect-run.test.ts`: 1/1; tests cover four saved states, attempts/calls, pending IDs, safe actions, corrupt validation references and immutable reads | Sol ACCEPT after the two read-only safety corrections | Locally accepted |
| INS-003 | Missing export API was the initial RED. Added schema-annotation/private-value and profile-name cases; reverting the corresponding redaction briefly exposed each leak | `tests/scenarios/ins-003-export-run.test.ts`: 1/1; deterministic output, contract summaries, profile-name/model/capability redaction, metadata, CLI and byte-hash immutability | Sol found profile/schema leaks; fixes now have direct regression coverage. Final independent review is pending after removing node-level profile names | Local GREEN |
| INS-004 | Sol-reviewed RED first failed at missing API; fixture corrections aligned it with persisted `response.raw.txt`, `expectedOutputs`, run checkpoint and event formats | `tests/scenarios/ins-004-replay-run.test.ts`: 1/1; valid/invalid/unknown candidates, schema/engine drift, provider/validator sentinels and run-tree hashes | Final GREEN review is pending | Local GREEN |
| INS-005 | `tests/scenarios/ins-005-damaged-evidence.test.ts` first failed because a corrupt checkpoint escaped as `RUN_NOT_FOUND` | 1/1; unavailable checkpoint, malformed event/response diagnostics, legacy engine drift and immutable reads | Not separately reviewed | Local GREEN |
| INS-006 | Package test extension covers existing installed archive behavior plus R6 entry points | `npm run test:package`: 10/10 installed-archive scenarios, including all four CLI commands and API imports from the installed package | Package behavior independently executes the actual packed tarball; final cross-slice Sol review remains pending | Local GREEN |

## Quality gate and regression recovery

- Final local gate on 2026-10-05: `npm run check` passed. Lint and typecheck passed; `npm run test:scenarios` passed 72 files / 300 tests; `npm run test:package` passed 10/10 actual archive-installation tests. `git diff --check` passed (Git reported expected LF-to-CRLF normalization notices for edited files).
- The first `npm run check` found one failure in existing `NODE-003 distinguishes validator timeout`: the timed-out child wrote its marker after the timeout. The isolated file reproduced 1 failure / 5 cases. The timeout path now directly terminates the Windows child before requesting process-tree cleanup; isolated `tests/scenarios/node-003-run-artifact-validator.test.ts` then passed 5/5, followed by the final full gate above.
- No test timeout or assertion was weakened. The other 299 tests in the first full attempt passed.

## Nodulus execution records

- Run `767dbd6f-67f9-43a3-9a28-784eb887e1ac` is an actual successful Nodulus readiness workflow using the configured Codex CLI 0.156.1 and requested `gpt-6-luna`; provider telemetry did not report the model name.
- Run `7d35012b-e122-4266-8696-4a8d65bba12d` records the R6 INS-001 implementation node succeeding under requested `gpt-6-luna`. Its later documentation node returned `RESPONSE_REPAIR_UNAVAILABLE`; the run remains a failed workflow and is not used as evidence that documentation passed.
- Run `febcd7ec-5709-4616-8970-eb958d22c80a` records the earlier INS-001 implementation/documentation pass. Its Luna reviewer node failed before running tests because Vitest could not create an SSR temp directory (observed EPERM); this was setup failure, not behavioral evidence.
- Run `724f66ee-5153-4283-90bd-609413a3f2a3` is a requested `gpt-5.6-sol` review workflow that failed before producing a response. Codex CLI 0.156.1 exited 1 during Windows PowerShell shell-snapshot startup, after emitting only startup warnings. It is preserved as a setup failure and does not count as review.
- These run records and local Nodulus configuration remain in the isolated worktree's untracked `.nodulus/` folder and are excluded from the PR.

## Remaining proof

- Obtain final independent review for INS-001 schema parity, INS-003 redaction, and INS-004 replay, then update any evidence/checklist changes from that review.
- Hosted CI is pending until the PR is pushed. No merge or release is in scope.

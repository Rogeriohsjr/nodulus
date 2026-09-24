# Evidence: 06-repair-recovery

Status: accepted locally on Windows after independent Sol review. The recorded commands below describe the evidence at this stage; hosted and live-provider proof are separate.

## Environment

- Revision / working diff: folder06 implementation checkpoint in working tree; no commit
- OS/runtime: Windows; local Node/npm runtime
- Owner/date: builder / 2026-09-24

## Scenario evidence

| Scenario | Test file | RED command / meaningful failure | GREEN | Notes / remaining proof |
| --- | --- | --- | --- | --- |
| SAFE-001 | `tests/scenarios/safe-001-response-only-repair.test.ts` | `npx vitest run tests/scenarios/safe-001-response-only-repair.test.ts tests/scenarios/safe-004-concurrent-resume-lock.test.ts` RED: malformed response, valid envelope with wrong contract, and semantic validator rejection ended with `error`. | `npx vitest run tests/scenarios/safe-001-response-only-repair.test.ts` passed (3 tests). | A real initialized project and provider boundary double verify exact prior raw text and saved validation errors; repair is a separate operation, with one initial action and no duplicate action. Output contract/schema errors and semantic validator rejection are correctable; execution/transport failures remain runtime failures. Each response and validation is retained under its own attempt directory. |
| SAFE-002 | `tests/scenarios/safe-002-repair-budget-and-capability.test.ts` | RED: exhausted budget and unavailable repair both returned `INVALID_NODE_RESPONSE`. | Focused SAFE suite passed all 3 SAFE-002 cases. | Allows two response-only repairs after one initial call; persists each attempt and returns actionable `REPAIR_EXHAUSTED`. Both capability/method mismatch directions return `RESPONSE_REPAIR_UNAVAILABLE`, with one full invoke, zero repairs, and no successor. |
| SAFE-003 | `tests/scenarios/safe-003-provider-and-validator-process-failures.test.ts` | RED: AbortSignal cancellation returned no `cancelled` result after waiting through the timeout. | Focused SAFE suite passed all 5 SAFE-003 cases. | Timeout, nonzero, malformed validator output, provider crash and cancellation pass. Timeout fixture records its process ID and confirms exit within a bounded wait. Cancellation uses the production validator adapter, real process tree, AbortSignal and bounded handshakes; Windows uses `taskkill /T`, POSIX uses a detached process group. |

Hosted follow-up: Ubuntu push job `107684222606` failed the cancellation test's immediate `kill(pid, 0)` assertion after the validator process exited. The immediate check could race descendant signal delivery; Linux zombies can also answer signal 0 despite being unable to execute. The test now uses its existing bounded exit wait and treats `/proc/<pid>/stat` state `Z` as terminated on Linux. Only `ENOENT`/`ESRCH` from the `/proc` read or `ESRCH` from signal 0 mean exited; `EPERM` and other probe errors conservatively mean alive. A still-running descendant beyond the bound remains a failure. On Windows, the focused SAFE-003 file passes 5/5 after this test-only correction. POSIX hosted rerun is pending; this local Windows result does not verify Linux process-tree cleanup.
| SAFE-004 | `tests/scenarios/safe-004-concurrent-resume-lock.test.ts` | `npx vitest run tests/scenarios/safe-001-response-only-repair.test.ts tests/scenarios/safe-004-concurrent-resume-lock.test.ts` RED: competing real resume returned `RUN_NOT_PAUSED`; stale-lock contender two returned `RUN_LOCKED` after contender one replaced/deleted the stale lock instead of both refusing recovery. | `npx vitest run tests/scenarios/safe-004-concurrent-resume-lock.test.ts` passed (2 tests). | Local storage creates an exclusive per-run lock and token-checks release. Live owners return `RUN_LOCKED`. A stale lock is preserved and both contenders return `RUN_RECOVERY_REQUIRED`; manual inspection/removal is required before retry, avoiding automatic takeover of uncertain work. Tests verify owner completion, one build with accepted answer, successor execution, and stale-lock no-mutation across two real processes. |
| SAFE-005 | `tests/scenarios/safe-005-checkpoint-events-and-usage-metrics.test.ts` | RED: status omitted events after a trailing partial JSONL record. | Focused SAFE suite passed. | Status leaves checkpoint authoritative, returns complete JSONL events and flags a partial tail. Provider usage is adapter-reported; unavailable token/cache/cost values stay null. Totals are null when any call component is unknown, and elapsed time is measured locally. No price estimates are invented. |
| SAFE-006 | `tests/scenarios/safe-006-crash-retains-accepted-work.test.ts` | RED: fresh resume after killing a blocked active-node process returned `RUN_NOT_PAUSED`, not `RUN_RECOVERY_REQUIRED`. | Focused SAFE suite passed. | Completed first-node artifacts survive. Invocation intent is persisted before external work. After process death, stale lock and running checkpoint produce explicit recovery-required; no second-node provider call is replayed. |

## Accumulated validation

- `npm run typecheck` passed.
- `npm run build` passed.
- Focused SAFE suite: 15 tests passed across all 6 files.
- `npm run test:scenarios`: 84 tests passed across 31 files.
- Package, hosted, and live-provider checks: not run.

## Handoff

- Changed: application/core repair and recovery behavior, local exclusive locking, process-tree cancellation, event/status inspection and usage metrics; six SAFE scenario files, one blocking resume-process fixture and support helpers.
- Contracts: `repairResponse(invocation, previousRawResponse, validationErrors)` is separate from full invocation and capped at two calls; it requires saved `responseRepair` capability and adapter support. An interrupted running checkpoint or stale lock is not automatically replayed/reclaimed; stale locks require explicit manual inspection/removal. Metrics expose adapter-reported usage, locally measured elapsed time and null unknowns. Status ignores an incomplete trailing JSONL record while leaving the checkpoint authoritative.
- Accepted after independent Sol review and 5 focused correction tests passed. Builder full suite passed 84 tests, focused SAFE 15 tests, build/typecheck/diff passed. Folder 07 is next.

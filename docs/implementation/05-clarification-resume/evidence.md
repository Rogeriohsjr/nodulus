# Evidence: 05-clarification-resume

Checkpoint history: counts and remaining work below describe this slice at acceptance time. See the [current implementation status](../README.md) and [hosted validation](../09-ci-release/evidence.md#final-code-checkpoint-verification) for later completion.

Status: accepted locally on Windows after independent Sol review. The recorded commands below describe the evidence at this stage; hosted and live-provider proof are separate.

## Environment

- Revision / working diff: folder05 implementation in working tree; no commit
- OS/runtime: Windows, local Node/npm runtime
- Owner/date: builder / 2026-09-24

## Scenario evidence

| Scenario | Test file | RED evidence | GREEN evidence | Limits |
| --- | --- | --- | --- | --- |
| ASK-001 | `tests/scenarios/ask-001-request-missing-caller-input.test.ts` | Initial RED: expected CLI exit 2, got 1 instead of a persisted `needs_input` result. | `npx vitest run tests/scenarios/ask-001-request-missing-caller-input.test.ts` passed. | Real project, compiled CLI, caller-CWD input file; verifies request persistence and no provider call. |
| ASK-002 | `tests/scenarios/ask-002-resume-paused-workflow-fresh-process.test.ts` | Initial RED: initial result was `error`, expected `needs_input`. | Focused ASK suite passed; fresh-process test verifies two clarifications, unique request IDs, captured context, and no completed-node replay. | Uses a local `.mjs` fixture executable, not a live provider. |
| ASK-003 | `tests/scenarios/ask-003-invalid-answers-preserve-pause.test.ts` | Initial RED: expected `PENDING_REQUEST_MISMATCH` / `ANSWERS_INVALID`, got `RESUME_NOT_IMPLEMENTED`. | 3 cases passed. | Compares checkpoint, pending request, dynamic answer path and directory, events, and full provider call log. |
| ASK-004 | `tests/scenarios/ask-004-status-pending-run.test.ts` | Initial RED: status/resume exited 1 rather than expected status 0 / resume exit 2; replay case initially errored before pausing. | 3 cases passed. | Compiled CLI status, production CLI parser resume, consumed-ID replay, and terminal replay; compares accepted answers and complete provider call log. |
| ASK-005 | `tests/scenarios/ask-005-captured-context-guards.test.ts` | Focused RED: 4 cases expected guard-specific errors, received `RESUME_NOT_IMPLEMENTED`. | 4 cases passed. | Uses persisted pending ID; compares checkpoint, pending request, answer files, events, and provider log before/after each guard. |

## Accumulated validation

- `npm run typecheck` passed.
- `npm run build` passed.
- Focused ASK suite: 12 passed across ASK001–005.
- `npm run test:scenarios`: 69 passed across 25 files.
- Package, hosted, and live-provider checks: not run.

## Handoff

- Changed: caller-input/workflow schema, pause/resume/status application APIs, CLI options, persisted context guards, fixture support, fresh-process driver, and ASK001–005 tests.
- Contract: workflow inputs declare `inputs: { name: { contract: "..." } }`; node mappings use `from: "caller.<name>"`; CLI values come from `--inputs-file`. Resume accepts run ID, pending request ID, and answers object. Captured provider profiles exclude credentials; executable availability is checked when the provider port supports it.
- Accepted: independent GPT-6 Sol review passed all 12 ASK tests and found no folder 05 blocker. Builder full suite passed 69 tests; typecheck/build passed. Folder 06 is next.

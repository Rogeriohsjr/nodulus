# Evidence

## Planning checkpoint

- Status: documentation-only plan; no runtime source, tests, fixtures, package code, or acceptance state changed.
- Source prerequisite: refreshed `origin/main` at `0d5941d975dc3142fc8f2f4b5fddcb4d8a63be54`, including merged feedback routing, and created `codex/parallel-fork-join` from the clean checkout. The planning diff now contains six files in this folder, including the coordinator review, plus the implementation-index link.
- Contract basis: current architecture documents ordered workflows and explicitly places parallel nodes outside v1. The schema-2 DAG design here is a proposal pending P0 review.
- Verification: required repository guidance, scenario skill and named inspection/fixture sources read. Initial-draft coordinator checks passed: nine local Markdown links resolved and `git diff --check` exited 0. The corrected-plan PowerShell check inspected all five Markdown files, resolved nine local links, and found zero broken links and zero files with trailing whitespace. The source/test scope check lists only the five planning files and implementation-index link.
- Review: Luna wrote the plan and completed one focused correction after Sol `CHANGES_REQUIRED`. Sol then returned `ACCEPT` for that documentation-only revision. The coordinator subsequently performed a separate review against the actual scheduler, storage, event, resume and provider code and found further gaps. The coordinator's findings and direct plan corrections are recorded in [coordinator-review.md](coordinator-review.md). Sol's earlier acceptance does not cover these later coordinator edits and is not product acceptance.
- Coordinator document verification after those corrections: six Markdown files, fourteen local links, zero broken links and zero files with trailing whitespace. Runtime scenarios and `npm run check` were not run for this documentation-only review; no runtime behavior changed.
- RED/GREEN: not applicable; docs and skill metadata are an explicit non-TDD exception in `docs/testing.md`. No behavioral RED or runtime proof is claimed.
- Runtime, package, hosted, and live-provider evidence: none for this proposed feature.

## Scenario evidence (pending)

| Scenario | Test and exact command | RED evidence | GREEN evidence | Review | Status |
| --- | --- | --- | --- | --- | --- |
| PAR-001 | `npm run build`; `npx --no-install vitest run tests/scenarios/par-001-graph-inspection.test.ts` | Coordinator and Sol observed 1 relevant failure / 2 passing controls | 3/3 passed independently by builder, coordinator and Sol | Sol RED/GREEN ACCEPT; coordinator accepted | Local scenario accepted; P1 negative matrices pending |
| PAR-002 | `npm run build`; `npx --no-install vitest run tests/scenarios/par-002-graph-structure.test.ts` | No new RED; existing grammar characterized | 11/11 by builder/Sol; P01+P02 14/14 by coordinator | Sol and coordinator ACCEPT | Local structural coverage accepted |
| PAR-003 | `npx --no-install vitest run tests/scenarios/par-003-graph-mappings.test.ts` | Coordinator/Sol reproduced 2 failed / 8 passed | 10/10; coordinator P01–P03 24/24 | Sol RED/GREEN ACCEPT; coordinator accepted | Local mapping scenario accepted |
| PAR-004 | `npx --no-install vitest run tests/scenarios/par-004-graph-strict-definition.test.ts` | Coordinator/Sol reproduced 2 failed / 18 passed | 20/20; coordinator P01–P04 44/44 | Sol RED/GREEN ACCEPT; coordinator accepted | Local strict-definition scenario accepted |
| PAR-010–016 | Not assigned | None | None | Pending | Not started |
| PAR-020–025 | Not assigned | None | None | Pending | Not started |
| PAR-030–036 | Not assigned | None | None | Pending | Not started |
| PAR-040–044 | Not assigned | None | None | Pending | Not started |

## P01 test checkpoint

Luna wrote `tests/scenarios/par-001-graph-inspection.test.ts`. Initial tooling failures were setup only: missing local TypeScript/Vitest, sandboxed `npm ci` EPERM, and a stopped unresolved npx command. The coordinator verified the dependency directory was absent and installed the locked dependencies with the appropriate permissions: Node 24.15.0, npm 11.15.0; `npm ci --no-audit --no-fund` exited 0 and installed 350 packages.

Before recording RED, the coordinator inspected the actual test and found an invalid positive fixture (leaf mapped a non-ancestor) and an unexercised compatibility control behind the positive assertion. Luna corrected the dependency and split the schema-2 rejection into its own test, asserting both readiness and invocation counters stay zero. The corrected frozen SHA-256 is `DC1D8359483CF48C3BC1B5A0D04C9080F3C8B381009C58FF691176AD5F9D2872`.

The coordinator then independently ran `npm run build` (exit 0) and `npx --no-install vitest run tests/scenarios/par-001-graph-inspection.test.ts` (exit 1: one failed, two passed). The positive scenario failed `PAR-001 must inspect a valid schema-2 graph`: current inspection returned `CONFIGURATION_INVALID` because the version-1 definition schema rejects graph properties. The separate schema-2 no-probe/no-write rejection and version-1 execution controls passed. This was the first behavioral RED, before production edits. Sol independently reproduced it with the frozen hash and accepted the test. A default-sandbox Sol run timed out in fixture initialization and remains setup history, not RED; the scoped permission-correct rerun produced the intended 1/2 result.

## P01 implementation checkpoint

Luna added `src/core/workflow-graph.ts` and integrated two-pass graph inspection into `src/core/inspect-workflow.ts`, without changing the version-1 intake/executor or the frozen test. Build and typecheck passed. A lint template-expression finding was corrected; stalled default-sandbox commands are not passing evidence. The coordinator independently ran the focused test (3/3 pass), lint (exit 0) and typecheck (exit 0), then verified final source/test hashes. Sol read the actual two-source diff and new file, independently reran the three tests successfully, and accepted the bounded GREEN checkpoint. The coordinator inspected the implementation and accepted PAR-001, while explicitly retaining strict nested caller-input and inherited caller-name gaps for PAR-003/004 test-first corrections.

Frozen source hashes: graph `9F2C94EACF7C6CDC96A1332956CA4581EA4B779359D87C652AF9D8BE6BF8BEEC`; inspection `FAC6C590BC63B9AE06844B92BF642AC878D4A700EC615271A95098E3EBF1B3D2`; test `DC1D8359483CF48C3BC1B5A0D04C9080F3C8B381009C58FF691176AD5F9D2872`. The full phase quality/package gate has not yet run and P1 is not accepted. P02 structural negative tests are assigned next; no graph execution, hosted graph proof or live-provider proof is claimed.

## P02 structural characterization

Luna added the real shared parallel-project fixture and eleven structural tests: one valid control plus duplicate nodes, unknown/self/duplicate edges, missing/extra dependency entries, cycle, duplicate alias, missing alias source and mismatched alias contract. Build and the focused eleven-test suite passed. These cases characterized already-implemented grammar; no RED was manufactured. The coordinator read both actual files and independently ran P01+P02 together (14/14 pass, frozen P01 hash unchanged). Sol independently read the files, verified their hashes and reran all eleven tests successfully, then accepted the bounded coverage. The coordinator accepted PAR-002; mapping/strict-field gaps and the full P1 gate remain pending.

Frozen P02 test hash `0688E4D70645789721E75DA8E624F21852DC8EB769652A29CC5F42BA04BC7FE1`; helper `6E3C727A021404E14DA35B89E70F2BD6901577F69860C4203DF9A27A6CD59990`. No production or P01 changes were made in this packet.

## P03 mapping correction

The coordinator inspected the first test draft, reproduced the version-1 inherited caller-name failure and required the omitted graph variant before test acceptance. The corrected frozen test (`8B3ADE67EAD81B4CA6A17FF0CAB6EA91DD751950F96433FA41AE148483109414`) produced two relevant failures and eight passing controls, independently reproduced by coordinator and Sol. Graph inspection accepted an undeclared `caller.constructor` without a contract; version-1 run intake created a run and returned `INPUT_CONTRACT_INVALID` instead of rejecting configuration before writes. Luna changed only the shared mapping helper to use `Object.hasOwn` before reading a caller declaration. Root read the actual diff and independently ran all 24 P01–P03 tests; Sol independently reproduced ten-test GREEN and accepted. No caller name is blacklisted. The source hash is `4BB42D3BBF4E64F51B78C839942DFB35FE3DA906D9FA877FE8D0263346C7616D`.

## P04 strict-definition correction and P1 acceptance

The frozen strict-definition test (`522C3152127C77DDDEE869DA4E18BE32795DB665F13AC2AC63441210CD78F0B8`) produced two relevant failures and eighteen controls. Root and Sol independently confirmed inspection accepted extra properties in a caller declaration and a graph input mapping. Luna added strict caller-declaration validation with a precise type and graph-only mapping-property validation, preserving the malformed-input diagnostic and the version-1 path. All twenty tests then passed; the coordinator read the final graph module and full source diffs and independently ran all 44 P1 tests. Sol independently reviewed final source and reran the twenty strict-definition cases successfully. Final graph hash is `0D81B93318DC1C9DDF279629903881C07AF96196E9466FD9D4DB810B23DED062`, inspection hash `2F9D275215313E8795353DB49B398F98E582A8216933CCF8F4991EAEC26A39DE`; earlier frozen test/helper hashes are unchanged.

The coordinator ran `npm run check` on the frozen P1 implementation with the required permissions for real local subprocess fixtures: exit 0, lint/typecheck/build passed, 95 runtime files / 522 tests passed, and 17 installed-package tests passed. Log: `.nodulus/checkpoints/parallel-phase1/npm-check.log` (ignored local evidence). After a final wording correction aligning the guide's prose with its audit dependency, `npm run test:package` passed 17/17 again; log `.nodulus/checkpoints/parallel-phase1/final-docs-package.log`. Documentation was independently reviewed by the coordinator. P1 is accepted locally; its hosted PR checks are separate. P2 execution and later scenarios remain unimplemented, and no live-provider compatibility is claimed.

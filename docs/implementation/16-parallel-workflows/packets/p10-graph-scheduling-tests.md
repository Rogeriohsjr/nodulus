# P10: real bounded graph scheduling

Prerequisite: P1 locally accepted at `7eb74bd` with 522 runtime and 17 package tests; Phase 1 PR #32 targets planning #31. Read the frozen runtime contract before writing. This packet covers the first executable PAR-010/011 subset; remaining P2 scenarios are not completed by it.

## Ownership and production paths

Luna owns new `tests/scenarios/par-010-graph-scheduling.test.ts`, `tests/support/graph-process-provider.ts` and `tests/fixtures/par-graph-provider.mjs`. Existing P01–P03 tests may change only the planned staging assertions: inspection capability false becomes true, and P01's valid-schema-2 rejection control becomes an invalid/cyclic schema-2 no-probe/no-write control. Preserve all other assertions, fixtures and earlier negative cases. Record the explicit hash/requirement transition. No production edits in the test packet.

Use public `runWorkflow`/`inspectWorkflow`, real temporary initialized files and the existing parallel helper. For scheduling cases, create three independent root nodes with request inputs, report.v1 artifacts, explicit empty resource arrays and ordered result aliases. The process-provider boundary launches the actual new Node fixture through the real process runner, forwarding the invocation signal. It must reject unexpected calls, save per-node started/finished markers outside the run store, and return raw valid outcomes. The child fixture reads its request on stdin, writes its started marker, waits for an explicit release file, emits its known report, and exits. Use bounded watchdogs and guaranteed cleanup. No internal storage/process mocks, no live provider CLI, and no elapsed-time speed threshold as concurrency evidence.

## Cases

1. With concurrency 2 and three ready independent roots, two fixture children must report started before either is released. Hold them, then release in a different order, admit the third only after a slot frees, and finish successfully. Track active calls and saved node start/acceptance evidence to assert the configured limit was never exceeded. Verify schema-2 checkpoint states and separate attempt/call files, and exact declared result aliases rather than last-finisher output.
2. With concurrency 1, release each started child before the next starts; the same finite workflow succeeds without overlap. Use barriers/peak counts and saved state, not duration comparisons.
3. A dependency chain starts its successor only after the predecessor is accepted in the saved checkpoint; the successor receives exact mapped report data. A request source listed later in node declaration order remains legal.

A whole new test may use an outer 30-second bound, a 10-second fixture watchdog and shorter controlled release steps, all declared before first RED. These bounds are cleanup/failure guards, not timing acceptance thresholds; do not increase them to obtain GREEN.

## RED gate

Run the fixture syntax check, build, lint and typecheck, then `npx --no-install vitest run tests/scenarios/par-010-graph-scheduling.test.ts tests/scenarios/par-001-graph-inspection.test.ts tests/scenarios/par-002-graph-structure.test.ts tests/scenarios/par-003-graph-mappings.test.ts` with the verified fixture permissions. Unsupported schema-2 execution and the old false capability are intended feature failures; a missing helper, import or fixture timeout is setup, not RED. Make run rejection observable immediately so unsupported execution cannot hang while the harness waits for a started marker. Capture the persisted checkpoint and mapped-input snapshot at invocation entry, before launching the child, so successor acceptance ordering cannot race the assertion. Cleanup releases barriers and awaits tracked provider operations before removing temporary files, even when the workflow settles early. Return actual counts, precise failures, hashes and allowed-file scope. Stop for Sol and coordinator review before implementation.

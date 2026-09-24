# Evidence: 03-node-outcomes

Status: accepted locally on Windows after independent GPT-6 Sol review.

## Scope and evidence

- Added one-node execution behind `runWorkflow` and the production `runCli` route. Tests inject only the provider boundary; project definitions, contract schemas, Markdown, run storage, and validator scripts are real temporary-project files.
- Package-owned success, needs_input, and error schemas validate provider outcomes. Runtime owns run/request IDs. Schema validation and all configured validators finish before accepted artifacts are written. Raw response, validation, invocation, attempt result, events, and terminal/pause state are persisted.
- Validators run as bounded Node child processes with artifact JSON on stdin and `{valid:boolean,errors:string[]}` on stdout. Timeout, nonzero exit, malformed verdict, rejection, and successful verdict are distinguished. The intentional timeout fixture uses 150ms; ordinary fixtures use 2.5s and verify delayed child work does not run after timeout.
- RED command: `npx vitest run tests/scenarios/node-001-accept-validated-output.test.ts tests/scenarios/node-001-cli-machine-outcomes.test.ts tests/scenarios/node-002-reject-invalid-output.test.ts tests/scenarios/node-003-run-artifact-validator.test.ts tests/scenarios/node-004-review-false-is-valid.test.ts tests/scenarios/node-005-error-and-clarification.test.ts tests/scenarios/node-006-protect-system-contracts-and-metadata.test.ts`. Before implementation, 7 files / 22 tests ran: 20 application cases reached `NODE_EXECUTION_NOT_IMPLEMENTED`; the two CLI cases reached production parsing/composition but returned exit 1 instead of expected success 0 / pause 2. No harness/import failures.
- First implementation run: 17/22 passed; five NODE-003 cases exposed a missing validator path in the invocation record. After recording it, focused run passed 7 files / 22 tests.
- Persistence-order regression: the new real-filesystem test creates a regular file where the artifacts directory should be created. Before correction it failed because `run.json` already reported `success`. The implementation now persists accepted attempt records and artifacts before the success checkpoint, then writes terminal `result.json` last. Focused regression passed 2/2 tests.
- GREEN verification before the persistence-order regression: `npm run build` passed; `npm run typecheck` passed; `npm run test:scenarios` passed 16 files / 43 tests. After the correction, build/typecheck passed again, focused NODE-001 passed 2/2 tests, and `npm run test:scenarios` passed 16 files / 44 tests; `git diff --check` passed. A plain `npm test` script is not defined; `test:scenarios` is the repository test command.
- No live provider, vendor adapter, repair/replay, multi-node graph, or resume behavior was exercised or added.

## Handoff

Sol independently passed the original full 43-test suite, identified the persistence-order regression, then accepted its correction after independently passing both NODE-001 cases. Builder post-correction full suite passed 44 tests. Folder 03 accepted; folder 04 is next. Hosted cross-platform and live provider proof remain later work.

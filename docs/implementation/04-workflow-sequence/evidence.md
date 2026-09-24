# Evidence: 04-workflow-sequence

Status: implementation GREEN checkpoint; awaiting independent review.

## Environment and contract

- Baseline revision: `d53ddfb`; Windows; Node v24.15.0; npm 11.12.1.
- Mapping shape is `inputs.<name> = {from: 'request' | '<prior-node>.<output>', contract: '<contract-id>'}`. Prior-output inputs require a contract matching the source declaration. A request mapping defaults to the built-in `request.v1` string contract.
- Provider invocations now carry structured mapped `inputs` and the run-captured, credential-filtered `providerProfile`; the prompt contains only that node's instructions and mapped data. An empty `inputs` object stays empty. The test helper explicitly declares the request mapping for earlier 03 scenarios that expect request text.
- RED command: `npx vitest run tests/scenarios/flow-001-map-artifacts-through-workflow.test.ts tests/scenarios/flow-002-stop-downstream-execution.test.ts tests/scenarios/flow-003-reject-invalid-wiring.test.ts tests/scenarios/flow-004-capture-shared-profile.test.ts`.
- Before implementation, focused run had 4 files / 10 cases: FLOW-001, three FLOW-002 variants, FLOW-004, and FLOW-003 declared-contract mismatch failed behaviorally. The other four FLOW-003 variants (duplicate IDs, forward reference, cycle, missing output) already failed preflight with zero calls and no run; retained as honest existing coverage. FLOW-001 stopped with `WORKFLOW_SEQUENCE_REQUIRED` before its provider-boundary prompt assertions could execute.

## Scenario evidence

| Scenario | RED evidence | GREEN evidence | Remaining proof |
| --- | --- | --- | --- |
| FLOW-001 | Multi-node workflow returned `WORKFLOW_SEQUENCE_REQUIRED`; provider was not called. | Three-node run passes; each invocation has only its declared input and captured profile, each prompt includes only node-local instructions/mapped values, accepted artifact/checkpoint exists before successor call, and final review artifact persists. | Provider fixtures only; live adapter behavior belongs to later slice. |
| FLOW-002 | All three middle-node outcomes stopped before the first provider call in the single-node executor. | Invalid artifact, provider error, and needs_input each stop after the middle node; no review attempt exists and analyze artifact remains accepted. | No additional proof for this slice. |
| FLOW-003 | Duplicate ID, forward reference, cycle, and missing output already passed preflight. Contract mismatch was accepted and created a run. | All five cases reject before provider calls/run creation; contract compatibility is checked against declarations. | JSON Schema subtype inference is intentionally not attempted. |
| FLOW-004 | Multi-node executor rejected before any provider invocation. | Two shared-profile nodes retain the first run's captured settings through a mid-run settings edit; a new run sees the updated model/timeout options. | No live provider or cross-platform run. |

## Follow-up regression evidence

- Review found empty node inputs were implicitly populated with caller request text. The real three-node regression failed with actual `{request: "Analyze the source and deliver a review."}` versus expected `{}`. Removing that fallback makes the review invocation and prompt omit caller and predecessor data when no inputs are declared.
- Review found dotted node/output names were parsed with a greedy regular expression. A real `analyze.findings.v1` reference failed intake even though the prior node declared output `findings.v1`. Source resolution now matches complete declared node/output pairs; an additional ambiguity fixture (node `alpha`, output `beta.gamma`, and node `alpha.beta`, output `gamma`) rejects before run creation.

## Validation

- Focused GREEN command above: 4 files / 13 tests passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run test:scenarios` passed 20 files / 57 tests, including accumulated folders 00–03.
- `git diff --check` passed.
- All fixture projects, schemas, Markdown instructions, and saved artifacts are real temporary files. Only provider inference is scripted. No external provider, vendor adapter, repair, pause resume, or later folder behavior was added.

## Handoff

Accepted after Sol verified both corrections and independently passed 9 focused cases. Builder full suite passed 57 tests; typecheck/build/diff checks passed. Folder 05 is next. Hosted platform and live provider proof remain pending.

Final acceptance: 2026-09-24, Windows, Luna builder and independent GPT-6 Sol reviewer.

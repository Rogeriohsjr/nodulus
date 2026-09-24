# 03-node-outcomes: Execute one node and validate its outcome

**Status:** not started. **Prerequisite:** 02-request-intake. **Method:** TDD.

A caller gets either validated artifacts, a structured clarification, or a reliable error.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### NODE-001: Accept validated output

Given a one-node workflow and provider returning valid success, when run executes, then actual Markdown/schema inputs reach the provider and validated artifacts, attempt records, terminal result, and success envelope are saved.

- [ ] NODE-001 acceptance verified and evidence recorded.

### NODE-002: Reject invalid output

Given malformed JSON, an invalid outcome, missing/duplicate output, or wrong artifact field type, when validation runs, then no output is accepted and validation errors are saved. Repair is added in 06.

- [ ] NODE-002 acceptance verified and evidence recorded.

### NODE-003: Execute artifact checks

Given schema-valid data and a configured .mjs validator, when checks run, then the real script receives the artifact and its accept/reject decision controls acceptance.

- [ ] NODE-003 acceptance verified and evidence recorded.

### NODE-004: Distinguish review content from runtime outcome

Given a review schema allowing pass=false, when a valid review arrives, then it is accepted unless an explicit business validator rejects it.

- [ ] NODE-004 acceptance verified and evidence recorded.

### NODE-005: Normalize failure and clarification

Given a provider error or needs_input response, when the node finishes, then the system outcome is validated and saved; needs_input is a persisted pause with exit 2, not a terminal result.json.

- [ ] NODE-005 acceptance verified and evidence recorded.

### NODE-006: Protect system contracts

Given a project attempting to override success/needs_input/error contracts or a model inventing trusted run metadata, when it executes, then system validation/metadata ownership cannot be bypassed.

- [ ] NODE-006 acceptance verified and evidence recorded.

## Implementation guidance

Implement package-owned outcome schemas, artifact validation, invocation capture, accepted-output storage, and single-node orchestration. Define validator protocol: JSON artifact on stdin, JSON {valid:boolean,errors:string[]} on stdout, exit 0 for a well-formed verdict. Nonzero exit, malformed verdict or timeout is validator execution failure, distinct from valid:false. Scripts run under configured bounded timeout.
Use actual validator fixtures for accept, reject, malformed response, nonzero exit and timeout. A needs_input outcome creates the minimum pause checkpoint now; answer handling is 05. All external raw responses remain untrusted until validated.

## Developer sequence

- [ ] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [ ] Run it before implementation; record the relevant RED assertion.
- [ ] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [ ] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [ ] NODE variants exercise real Ajv and real validation processes.
- [ ] No rejected output enters accepted artifacts.
- [ ] Persisted state and machine output agree for all three outcomes.
- [ ] Run available accumulated checks and record limitations.
- [ ] Review public contracts/docs; update evidence and only then mark this folder complete in the index.


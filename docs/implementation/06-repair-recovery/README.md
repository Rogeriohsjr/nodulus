# 06-repair-recovery: Repair responses and recover safely

**Status:** not started. **Prerequisite:** 05-clarification-resume. **Method:** TDD.

Failures are bounded, inspectable, and cannot silently duplicate work.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### SAFE-001: Repair a malformed response

Given invalid output followed by a corrected response, when correction runs, then it receives exact errors and prior response, succeeds within budget, and retains both attempts without replaying tool actions.

- [ ] SAFE-001 acceptance verified and evidence recorded.

### SAFE-002: Exhaust or refuse repair

Given three invalid responses or a provider without response-only repair capability, when correction cannot continue, then runtime emits an actionable error and later nodes never start.

- [ ] SAFE-002 acceptance verified and evidence recorded.

### SAFE-003: Handle process and validator failures

Given timeout, cancellation, nonzero exit, or malformed validator response, when execution stops, then child processes are cleaned up, diagnostics saved, and runtime returns error even without a model-generated artifact.

- [ ] SAFE-003 acceptance verified and evidence recorded.

### SAFE-004: Protect concurrent and interrupted runs

Given two processes trying to resume the same run, then one owns the lock; given interruption around a state write, then the checkpoint is valid old/new state or an explicit recovery error, never silently replayed uncertain work.

- [ ] SAFE-004 acceptance verified and evidence recorded.

### SAFE-005: Inspect logs and usage honestly

Given attempts with known and unavailable usage plus a partial trailing JSONL line, when status inspects the run, then complete events remain readable, checkpoint remains authoritative, and unknown metrics are null.

- [ ] SAFE-005 acceptance verified and evidence recorded.

### SAFE-006: Retain accepted work after a crash

Given a completed first node and an interrupted second node with possible side effects, when inspected/resumed, then first-node artifacts survive and second-node actions are not automatically repeated.

- [ ] SAFE-006 acceptance verified and evidence recorded.

## Implementation guidance

Add bounded response-only repair, runtime-owned error creation, locks and crash recovery checks, timeout/cancellation, and metrics aggregation. Persist attempt intent before invocation. If response-only repair is unavailable, fail clearly without retrying full execution.
Test crash windows using a real child process with an explicit signal/file handshake. Test lock contention with two processes. Stale lock recovery must verify ownership/liveness and uncertainty; do not blindly remove locks. Make read-only status available even for interrupted runs.

## Developer sequence

- [ ] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [ ] Run it before implementation; record the relevant RED assertion.
- [ ] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [ ] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [ ] Prove attempt limits and no full-action replay through captured requests.
- [ ] Execute real subprocess cancellation and locking tests.
- [ ] Separate known usage from estimates; record absence of live cost accuracy proof.
- [ ] Run available accumulated checks and record limitations.
- [ ] Review public contracts/docs; update evidence and only then mark this folder complete in the index.


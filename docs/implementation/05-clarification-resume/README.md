# 05-clarification-resume: Pause, answer, and resume

**Status:** not started. **Prerequisite:** 04-workflow-sequence. **Method:** TDD.

An agent can ask its user for missing information and continue the same run later.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### ASK-001: Request missing initial input

Given a workflow requiring caller data not supplied, when run starts, then it saves a pending request/answer contract and exits 2 before invoking a node.

- [ ] ASK-001 acceptance verified and evidence recorded.

### ASK-002: Resume a node clarification

Given a node returns needs_input after earlier nodes succeeded, when valid answers arrive in a fresh application instance, then answers are saved, the paused node receives original context plus answers, and earlier nodes are not rerun.

- [ ] ASK-002 acceptance verified and evidence recorded.

### ASK-003: Reject invalid answers safely

Given a wrong request ID, missing answer field, or invalid value, when resume runs, then it returns an error while the original run remains paused and no provider is invoked.

- [ ] ASK-003 acceptance verified and evidence recorded.

### ASK-004: Handle repeated and terminal resume

Given an already consumed request ID or completed run, when resume is repeated, then it cannot replay work or overwrite accepted answers and explains the conflict.

- [ ] ASK-004 acceptance verified and evidence recorded.

### ASK-005: Guard captured context

Given changed workspace references, an incompatible schema/engine version, or unavailable captured provider, when resume runs, then it refuses unsafe continuation with an actionable reason and preserves the checkpoint.

- [ ] ASK-005 acceptance verified and evidence recorded.

## Implementation guidance

Implement pending-request lifecycle, answer schemas and answer persistence, status, and resume. Input questions produced by runtime use the same control contract as node questions. Snapshot captured definitions/instructions; do not load changed live definitions silently. Include multiple consecutive clarification cycles with unique request IDs.
Resume must load only from saved state, not in-memory closures. Add separate-process proof using a real fixture provider executable; that fixture is a controlled stand-in for the external tool and need not implement Codex/Cursor syntax yet. Automated mode never blocks waiting for stdin after it returns needs_input.

## Developer sequence

- [ ] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [ ] Run it before implementation; record the relevant RED assertion.
- [ ] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [ ] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [ ] Fresh-process scenario proves durable resume and no prior-node replay.
- [ ] Invalid answers preserve checkpoint/accepted answers.
- [ ] Document what the caller does after needs_input with a runnable example.
- [ ] Run available accumulated checks and record limitations.
- [ ] Review public contracts/docs; update evidence and only then mark this folder complete in the index.


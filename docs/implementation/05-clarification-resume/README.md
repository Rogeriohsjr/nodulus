# 05-clarification-resume: Pause, answer, and resume

**Status:** accepted locally on Windows after independent Sol review. **Prerequisite:** 04-workflow-sequence. **Method:** TDD.

An agent can ask its user for missing information and continue the same run later.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### ASK-001: Request missing initial input

Given a workflow requiring caller data not supplied, when run starts, then it saves a pending request/answer contract and exits 2 before invoking a node.

- [x] ASK-001 acceptance verified and evidence recorded.

### ASK-002: Resume a node clarification

Given a node returns needs_input after earlier nodes succeeded, when valid answers arrive in a fresh application instance, then answers are saved, the paused node receives original context plus answers, and earlier nodes are not rerun.

- [x] ASK-002 acceptance verified and evidence recorded.

### ASK-003: Reject invalid answers safely

Given a wrong request ID, missing answer field, or invalid value, when resume runs, then it returns an error while the original run remains paused and no provider is invoked.

- [x] ASK-003 acceptance verified and evidence recorded.

### ASK-004: Handle repeated and terminal resume

Given an already consumed request ID or completed run, when resume is repeated, then it cannot replay work or overwrite accepted answers and explains the conflict.

- [x] ASK-004 acceptance verified and evidence recorded.

### ASK-005: Guard captured context

Given changed workspace references, an incompatible schema/engine version, or unavailable captured provider, when resume runs, then it refuses unsafe continuation with an actionable reason and preserves the checkpoint.

- [x] ASK-005 acceptance verified and evidence recorded.

## Implementation guidance

Implement pending-request lifecycle, answer schemas and answer persistence, status, and resume. Input questions produced by runtime use the same control contract as node questions. Snapshot captured definitions/instructions; do not load changed live definitions silently. Include multiple consecutive clarification cycles with unique request IDs.
Resume must load only from saved state, not in-memory closures. Add separate-process proof using a real fixture provider executable; that fixture is a controlled stand-in for the external tool and need not implement Codex/Cursor syntax yet. Automated mode never blocks waiting for stdin after it returns needs_input.

## Caller flow

Workflow caller inputs are declared by contract, for example:

```json
{
  "inputs": {
    "goal": { "contract": "goal.v1" }
  }
}
```

Node definitions map values with `"from": "caller.goal"`. If the value is missing, `run` returns exit code 2 with a JSON envelope containing `runId` and `result.request.id`. Save values that satisfy `result.request.answerContract` to an answers file, then inspect or resume the same run:

```sh
nodulus status <run-id> --project . --json
nodulus resume <run-id> --request-id <pending-request-id> --answers-file answers.json --project . --json
```

For example, if the pending contract requests `goal`, `answers.json` can contain `{"goal":{"target":"release notes"}}`. Each later `needs_input` response has a new request ID; use the ID from the latest response. The CLI currently has no built-in provider adapter, so execution beyond a caller-input pause requires a configured provider adapter; provider adapters are covered by folder 07.

## Developer sequence

- [x] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [x] Run it before implementation; record the relevant RED assertion.
- [x] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [x] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [x] Fresh-process scenario proves durable resume and no prior-node replay.
- [x] Invalid answers preserve checkpoint/accepted answers.
- [x] Document what the caller does after needs_input with a runnable example.
- [x] Run available accumulated checks and record limitations.
- [x] Review public contracts/docs; update evidence and only then mark this folder complete in the index.

# OBS-006 launch and interrupted-call evidence

## Implemented behavior

The `readCallEvidence` function in `src/application/call-evidence.ts` provides read-only evidence for provider call lifecycle states based on persisted events and metrics. It does not write files, launch processes, or initiate automatic recovery.

### Key behaviors

1. **Readiness failure**: When a provider call starts but inference does not launch (auth failure, network error, etc.), the evidence reports:
   - `launched: false`
   - `status: 'not_launched'`
   - `transportAvailable: false`
   - `requestAvailable: false` or `true` depending on persisted files

2. **Interruption/killed workflow**: When the process is killed after request persistence but before completion:
   - `launched: null` (uncertain — transport file missing, no explicit metric)
   - `status: 'incomplete'`
   - `requestAvailable: true` (request.json persisted)
   - `transportAvailable: false` (transport.json never written)

3. **Completion**: When transport.json is persisted with matching callId:
   - `launched: true`
   - `status: 'completed'`
   - `transportAvailable: true`

   This classifies capture completion, not workflow success: a captured timeout or failed process still has transport evidence. The run checkpoint and artifact validation remain authoritative.

4. **Unavailable**: When no matching capture files exist, launch is unknown, and a matching call-completed event exists:
   - `status: 'unavailable'`

### Validation

- Event records must be objects with valid UUID `callId` strings and valid `nodeId` strings
- Legacy events without IDs are skipped
- `request.json` and `transport.json` must parse to objects with matching `callId` fields
- ENOENT errors are treated as "file unavailable" (no diagnostic)
- Other read/parse/identity errors produce diagnostic strings without throwing

### Launch certainty

- `launched: true` when transport.json is valid and matching, or a saved metric explicitly reports a completed process capture
- `launched: false` only when metric explicitly reports `launched: false`
- `launched: null` when no matching transport or explicit launch metric resolves certainty (interruption case)

## Historical evidence

The implementation is validated by frozen regression tests in `tests/scenarios/obs-006-launch-and-interruption.test.ts`:

1. **Readiness failure test**: Verifies that a second node in a two-node workflow reports `launched: false` and `status: 'not_launched'` when inference fails to launch due to auth rejection.

2. **Interruption test**: Verifies that a killed workflow leaves an inspectable request.json, reports `status: 'incomplete'` with `launched: null`, and does not replay inference in a fresh status process.

Fixed checks (typecheck, build, lint, regression tests) passed after supervisor correction of the persisted event field and removal of unused type.

## Pending parent-story work

The full OBS-006 lifecycle story includes additional cases not yet implemented or tested in this node:

- Timeout handling with partial telemetry (existing tests retain prior behavior)
- Malformed output cases (existing tests retain prior behavior)
- Additional edge cases for `unavailable` status determination
- Integration with broader observability pipeline beyond `readCallEvidence`

This checkpoint adds the read-only evidence reader, the optional provider launch hook, nullable core metrics and the application status projection, with real-process and fixture regressions. Qwen authored the reader draft and documentation; supervisor integration and the recorded corrections completed the implementation. No autonomous completion is claimed.

## Reader boundaries

The reader itself does not write files, launch inference, retry calls or initiate recovery. Provider/core integration does persist launch evidence during normal execution, and the regression fixtures do run real child processes. Aggregate coverage, repair/resume accounting and estimates belong to later checkpoints.

Documentation review note: the supervisor corrected an internally contradictory unavailable-state sentence and clarified true launch evidence after Qwen accepted the draft. The raw Qwen document/review remain in the run receipts; final independent review covers this corrected document.

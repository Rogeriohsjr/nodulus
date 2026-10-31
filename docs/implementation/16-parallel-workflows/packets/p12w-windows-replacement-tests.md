# P12W: Windows checkpoint replacement contention

Prerequisite: P13A repair/session/metric source has bounded independent review, but the coordinator's 57-case run failed 56/57 on a real unblocked call-start replacement: EPERM renaming run.json.<uuid>.tmp to run.json. The exact log is `.nodulus/checkpoints/parallel-phase2/p13a-root-green.log`. The actor causing that incidental error is unknown. This packet reproduces the sharing mechanism, not an attribution to a particular reader or scanner. Do not retry the old suite to hide the failure.

## Test-only ownership

Luna owns new `tests/scenarios/par-012-windows-replacement.test.ts` and `tests/fixtures/par-windows-file-lock.ps1`; a small test-only Windows lock helper is allowed. Preserve all existing tests/helpers/fixtures and all production until observed RED and review. Other agents may read; do not revert their changes.

Use public runWorkflow with the actual LocalIntakeStorage composition and existing process-backed graph provider. A delegating external-provider wrapper may await its real child result, acquire a real OS file-sharing lock on the existing run.json, then return the raw result so the engine reaches its real call-completion checkpoint replacement. No mocked filesystem, synthetic storage exception or provider action replay.

The PowerShell/.NET child opens the target with FileShare.ReadWrite and without FileShare.Delete, signals its acquired lock and PID, and holds it until a release marker or finite watchdog. Its reads remain available while atomic replacement is denied. Launch hidden with literal argument arrays, keep control files under the generated fixture project, release/await/abort the owned locker in finally, and validate PID identity before deleting the project. Skip this sharing-specific scenario explicitly on non-Windows; a skipped case is not RED.

Observe the real pending checkpoint temporary file while the lock is held. Confirm the target remains its previous valid checkpoint; an independent same-bytes replacement probe may confirm that the real lock rejects rename without modifying the logical state. Release the fixture lock after a short declared controlled hold following the pending-file observation, then await workflow success. The test asserts one original node/provider action, valid final artifact/accepted checkpoint and no inference retry. Its intended old-code RED is actual RUN_STORAGE_FAILED/EPERM before successful acceptance, not a marker timeout. Record exact evidence that the lock was active and the replacement was denied. A fixture hold is controlled failure synchronization, not a concurrency-speed assertion.

Declare finite bounds before the first run. Do not raise existing provider/test timeouts or rerun to manufacture RED. Run PowerShell syntax validation, build, lint, typecheck and this focused test once on Windows; freeze hashes/results and stop for Sol/coordinator review.

## Prospective bounded GREEN scope

Only after accepted RED, Luna may change `src/adapters/storage/local-intake-storage.ts` to retry the same temporary-file rename for a short fixed budget on transient Windows sharing errors. Preserve atomic replacement: never delete the destination, rewrite it in place, retry inference, or recreate accepted artifacts. A target that is a directory remains an immediate permanent failure; exhausted or other errors preserve the original failure and checkpoint. Keep non-Windows semantics and the core/adapter boundary. Define the exact retry budget before implementation review, retain original P12 permanent-blocker tests, then run accumulated graph/lock scenarios and the full sequential quality gate. No P2 completion claim or publishing is authorized by this packet.

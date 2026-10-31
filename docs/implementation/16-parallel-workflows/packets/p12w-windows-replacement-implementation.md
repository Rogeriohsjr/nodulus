# P12W GREEN: bounded Windows atomic replacement

## Accepted RED

Builder and root independently ran the frozen real-lock regression. Both reached RUN_STORAGE_FAILED at the expected-success assertion, with EPERM renaming the actual run.json temporary to run.json after the real child result. Root log: `.nodulus/checkpoints/parallel-phase2/p12w-root-red.log`. The independent same-bytes replacement probe also returned EPERM while the verified PowerShell FileShare.ReadWrite/no-Delete handle was held. The incidental actor in the earlier P13A failure remains unknown; this proves the sharing-denial mechanism only.

Frozen W1 scenario SHA256: `854A2A5B2535D786154205D1F295294018DE3A26075FEEAC97F593DC2FFD842F`; lock helper `4B4AFB7CAB1F8C4BD8962CE1AC6A608D3A5C17E86B7FB8C10D4816D55D793A19`; PS1 `951743D70AA5D922C23CE0C264AC4BDF7E3385E3819D21D26073A3356D216BF6`. Sol accepted the final test-only checkpoint after two bounded correction rounds. The initial fixture watchdog was setup failure, not RED.

## Ownership

Luna owns only `src/adapters/storage/local-intake-storage.ts` and an additional Windows persistent-lock characterization control in the assigned W test area. Keep the accepted W1 test body, existing graph tests/fixtures, and all three P13 graph source files unchanged. No other source refactor or provider behavior change. Root owns documentation; Sol and root review independently. You are not alone: preserve others' edits.

## Before source edits: persistent-lock control

Add a small public-runWorkflow control using the real process provider and same verified OS locker. Include a dependent node. Keep the target locked until the workflow returns; then demonstrate replacement is still denied by a real same-bytes probe before releasing the lock. Expect RUN_STORAGE_FAILED with the actual rename denial, byte-identical last checkpoint, no accepted source artifact, no dependent call, and one original provider action. Release/drain owned processes before cleanup. Run this new control once against the old adapter and record its expected PASS as characterization, not feature RED. Existing W1 RED is the behavior change evidence. The original W1 body remains frozen.

## Minimal source fix

- Write the unique temporary exactly once. Retry only its rename to the original target. No target deletion, in-place overwrite, new temporary per retry, provider replay, artifact replay, or global state.
- Windows only, candidate sharing-denial codes EPERM/EACCES/EBUSY only. Other platforms and errors preserve current immediate failure behavior.
- Freeze a monotonic **1000 ms total retry budget**, **25 ms bounded delay**. Do not reset the deadline after each failure. Keep all existing fixture, profile and test timeouts unchanged. A target directory is a permanent blocker and fails immediately. If a target inspection cannot establish retry eligibility, retain the original failure.
- Exhaustion preserves the original rename failure and last checkpoint. Cleanup may remove only the exact owned temporary, must never remove the destination, and must not replace the primary error with a cleanup error. An orphan temporary is not acceptance authority.
- Existing required writer poison/checkpoint-last semantics remain unchanged; optional measurements remain optional.

## Gates and stop

Run PowerShell syntax validation if its fixture changes (normally none), build, lint, typecheck; W1 + persistent-lock control + P12 persistence tests; then accumulated P1/P2 scenarios and `npm run check`. No concurrent builds or tests from another owner. Record exact outcomes, hashes, and any failure without rerun-to-green. Stop at the stable checkpoint for Sol and root review. Root will independently repeat the focused/accumulated gate after review.

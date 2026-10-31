# P13B GREEN: isolate optional call measurements

Root independently reproduced the final five-case 3 PASS / 2 RED at frozen test SHA256 `F7BD4C78B48709BD6C2FCBB9CA9146901074DD32AAC8FEEBD919C0C15EAFE5B8`. Getter failure leaves no call-specific checkpoint diagnostic. Circular telemetry causes RUN_STORAGE_FAILED at required call-completion publication with Converting circular structure to JSON. Log `.nodulus/checkpoints/parallel-phase2/p13b-root-red-final.log`. Sol accepted the corrected real-process test; no fixture/setup failure was counted as RED.

## Ownership and limits

Luna owns `src/core/execute-graph-workflow.ts` and `src/core/graph-state.ts` only. Keep the graph runner, storage/provider adapters, legacy executor, all tests/helpers, existing bounds and all other edits unchanged. You are not alone: preserve Root's docs and other checkpoint work. A new small graph-only helper may be proposed if necessary, but do not silently broaden ownership.

## Behavior

- Call-keyed telemetry reads, normalization and serialization are optional. A bad call becomes usage null with raw telemetry omitted, a safe callId/node/attempt/operation/elapsed/launch record, and a checkpoint diagnostic identifying its callId and measurement error. Do not fabricate zero values, read usageForLastCall, retry inference or turn this into response correction.
- Capture a detached safe JSON snapshot of optional telemetry, or an equivalently safe metric, within the guarded optional path. A preflight serialization followed by retention of the same mutable/unserializable raw object is insufficient. A bad call must not remain in the writer's private metric array and break later measurements.
- Healthy beta retains its own actual 115/43/3/0.011 usage and complete telemetry. Both validated artifacts and ordered aliases still complete; one original action per node.
- Keep optional metrics-file I/O diagnostic, with no required checkpoint/evidence acceptance weakened. Required event/node-evidence/checkpoint failures still poison publication and stop dependents. Do not catch or downgrade those errors while handling measurement exceptions.
- Private metric-array publication and checkpoint projection remain serialized and publish only after required checkpoint success. Add diagnostic strings safely; do not persist arbitrary exception/telemetry objects inside the checkpoint.

## Verification and stop

Build, lint, typecheck; focused P13B/P13A/P12/W cases plus existing safe-005 and obs-011 version-1 usage/API controls; accumulated graph cases; then `npm run check`. Serialize all builds/tests with other owners. Record exact failures and stop rather than rerun-to-green or raise bounds. Full-gate Windows/DEV-002 historical issues remain recorded even if they do not recur. Return frozen source hashes/diff/results for independent Sol and Root review. This packet does not complete PAR-013 or P2 by itself; provider-error controls, resource/cancellation/crash and later phases remain required.

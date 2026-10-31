# P16 design: real crash and concurrent publication windows

This is a reviewed design note for the later PAR-016 packet, not authorization to start before the preceding runtime checkpoints. Freeze its concrete diagnostic fields and ownership when dispatched. No scenario acceptance is claimed here.

Sol checked the testing policy and existing `safe-006-crash-retains-accepted-work.test.ts` precedent. Controlled fixture processes and the actual filesystem are required. Public `runWorkflow` accepts a storage dependency; a thin test observer may delegate every operation to one actual `LocalIntakeStorage`, preserve the actual result or OS exception, and signal named milestones. It must never fabricate storage success/failure, replace filesystem operations, or bypass production composition. Core continues to depend only on its port; the observer lives in test fixtures.

## Before and after acceptance

Run the public API in a separate Node fixture process with concurrency one and a real process-backed provider. Observe actual successful storage operations only after awaiting the real adapter. For the before-acceptance case, stop the child synchronously once all required result/validation/artifact evidence is physically present and valid while its checkpoint is still active/unaccepted. For the after-acceptance case, stop it immediately after the real checkpoint write contains accepted state, before the observer returns to the engine. Write an external marker identifying the run and milestone before stopping. A marker followed by an ordinary later parent kill is insufficient because the engine could admit a successor in that gap.

The parent awaits worker closure, independently reads actual checkpoint/evidence and hashes, then uses a fresh process for status/resume. Valid orphan files cannot authorize acceptance or replay. A durably accepted node retains its exact evidence and is never invoked again. Interrupted running state fails closed with the recovery diagnostic, without new provider probes or call/action markers. Keep the existing engine/version/reference checks and separate later legitimate paused-run resume tests.

The P12 real checkpoint-directory blocker already covers an event saved before a failed checkpoint replacement. Preserve that proof; do not treat an uncommitted node/call event as authority.

## Concurrent required-write failure

Use a real directory blocker to make one node's final evidence write fail through the actual adapter. Keep another actual provider's completed raw result held at the external delivery boundary. A storage observer may report the original delegated exception and rethrow it unchanged. Its catch marker alone occurs before the runner's poison callback and cannot prove that the sibling was released after poison. Use an explicit post-propagation synchronization point, justified against the real runner's immediate failure callback, and record the exact interleaving. Do not substitute a delay threshold for that proof.

After the failure is propagated, deliver the sibling's valid result and assert no later acceptance, successor admission or success publication. Preserve the last authoritative checkpoint and the original filesystem diagnostic. A writer operation already in flight at the time of failure is a distinct ordering edge; define whether its valid checkpoint can finish and ensure that it cannot cause further provider launch or a successful workflow. Do not claim that P12's cap-one failures proved this concurrent case.

## Failure while publishing an error

Add a separate real error-transition control. A node produces a valid terminal error response. After the real writer saves its node.failed event, a delegating observer installs an owned directory blocker at run.json before checkpoint promotion. Do not fabricate the adapter exception. The public result must expose RUN_STORAGE_FAILED with the real replacement failure, retain the last authoritative checkpoint, preserve the original node error evidence, and start no dependent. An earlier domain error cannot hide a new required publication failure. Root's source review identified the current first-error selection as a candidate gap; only the actual scenario may establish RED.

## Captured validator policy

Add a real policy-change control before a dependent node's readiness/inference: mutate its captured validator entry after a predecessor is running, then complete the predecessor. The changed policy must be diagnosed before that dependent's provider probe/invoke or validator execution. A separate control mutates an entry during its own inference and verifies the existing before-validation hash check, with no accepted artifact. Imported dependencies remain explicit workspace references; these are consistency hashes, not signed proof. Do not broaden this into a claim of filesystem sandbox enforcement.

Every fixture has bounded release/exit cleanup and owned PID evidence. Preserve prior timeouts and record meaningful RED separately from fixture/setup failures. Full recovery compatibility, multi-question answers and final inspection/export/replay still require their later phase scenarios.

# P4C3 answer publication crash feasibility

Preparation only. Root and Sol reviewed the current writer/storage paths and the external watcher design below. No experiment or runtime change has been performed for this packet.

`GraphStateWriter.commit` supplies the answer target, event history and checkpoint in that order. `LocalIntakeStorage.writeRunFiles` writes and renames those targets serially. A genuine crash after answer publication and before checkpoint publication must be observed through those real production paths. A denied rename, manually created orphan file or edited checkpoint does not prove this window.

Start from the real two-question paused graph. Prefer a partial A answer while B remains unanswered: this exercises the actual answer commit with no provider dispatch even if the native monitor misses its window. Use a fresh owned public-resume driver. An external driver gate may hold before the API call while the monitor arms; it must not insert a hook into production code or storage. Preserve all original deadlines.

The native control must establish these observations:

1. The answer target is absent and the old paused checkpoint bytes/hash and event sequence are captured before release.
2. Arm a recursive fs.watch on the real run directory before releasing the external driver gate. Each notification checks the exact answer target; the driver also holds at an external exit gate after its public API settles. Pin the retained owned process before release. On Windows reuse the reviewed P3 native handle-pin helper unchanged, keeping its handle through the stale-owner assertion.
3. When the actual answer target exists, request termination only through that retained owned ChildProcess. Await its actual close and the pinned helper's matching root-exited observation. No suspension primitive or numeric-PID termination is needed.
4. After termination, verify the exact valid answer bytes/hash and the byte-identical old checkpoint with no answer reference. Those postmortem bytes establish whether the real publication window was captured; watcher notification alone does not. An event file ahead of the checkpoint cannot authorize an answer. Keep the native identity pin through the fresh resume assertion and release it only during owned cleanup.
5. Preserve the real stale run lock and orphan answer. A separate fresh public resume must return `RUN_RECOVERY_REQUIRED` with no provider method, fixture activity, accepted-work replay, lock deletion or run-tree mutation. This result proves the stale-lock guard, which runs before saved-state inspection. The separately observed real answer and old checkpoint bytes establish the crash window; do not claim that this rejection independently inspected the orphan answer.

Native notification can arrive after the subsequent checkpoint rename. An advanced checkpoint, a returned API/released lock, an unsupported watcher, or missing ownership evidence is a setup miss. Partial A continuation prevents provider descendants even on a miss. This is a bounded feasibility control; deterministic cross-platform coverage is not promised before observation.

Allow at most two explicitly recorded native attempts. Classify misses as above, release and drain the exact owned operations, and retain their evidence. Do not call a miss behavioral RED, silently edit state back, widen timers or retry indefinitely. Any required-write denial remains a separate fault-control result.

Success cleanup needs actual owned lifecycle completion and exact native project ownership. Retain the project on primary failure or uncertainty without inventing cleanup errors after a safely drained primary failure. The existing 20-second scenario, shared 10-second cleanup, 35-second case and 60-second fixture bounds apply. A source change, new test authoring or native experiment needs its own explicit bounded dispatch after this design is reviewed.

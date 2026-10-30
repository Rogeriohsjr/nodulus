# Implementation gates

A phase proceeds after prerequisite verification and coordinator dispatch, then its test/RED review, implementation and code review gates. The coordinator personally inspects the actual files and diff, checks the evidence, independently runs the fixed scoped verification, and decides acceptance after Sol's review. An agent report or Sol ACCEPT is supporting evidence, not the coordinator's acceptance. The phased work is already authorized; this is the planning checkpoint.

## P0 — freeze decisions

Verify current prerequisite evidence, then inspect production entry points and current storage/provider assumptions. Freeze the schema-2 contract from the folder README and every field needed by P1 assertions. Explicitly settle output alias resolution/order, inspection's unsupported-execution indicator, error precedence (`error > needs_input > success`), pause/drain and multi-pending answer behavior, and compatibility behavior for schema-1 runs. On first pause, stop admission, drain bounded active calls, and persist every runtime-owned pending request ID. The current CLI may answer one pending ID per operation: under the run lock validate the ID and answer before mutation, atomically persist that answer, remain `needs_input` and dispatch nothing while any saved question remains unanswered, then resume eligible pending nodes after all answers without replaying accepted siblings. A draining sibling error makes the run terminal `error`; pending data stays diagnostic and answering cannot resume it.

Before P2, complete and independently accept every P1 scenario, including the separately assigned negative matrices. Approve an exclusive shared-resource policy: identify which nodes may write the same workspace/files, how validator scripts are classified, and whether conflicting work is rejected, serialized, or isolated. Do not assume parallel scripts are safe. Select call-keyed telemetry or a reviewed serialized provider fallback; shared mutable `usageForLastCall` cannot safely identify overlapping calls. Define single-writer checkpoint and event append semantics: current read-modify-write append patterns can lose sequence updates, while existing feedback validation assumes prefix event ordering. Freeze the versioned graph checkpoint and durable node-acceptance commit protocol now, before the scheduler writes concurrent state. Atomic replacement of individual files is not an atomic commit of a group of run files. Pause/error precedence and pending-answer semantics above are also P2 prerequisites, not deferred until P4.

An active-node slot spans readiness, inference, response repair, validation and durable acceptance publication; response arrival alone does not release it. Preserve per-node repair/session ownership. Define cancellation classification separately from feedback deadlines: the current default adapter maps an aborted invocation to `FEEDBACK_LIMIT_EXCEEDED`, so a graph-stop signal cannot be reused without updating the contract and preserving legacy diagnostics. Real child-process fixtures must verify cancellation, cleanup and launch uncertainty.

For acceptance publication, the artifact, validation and provenance records must be durable before the authoritative checkpoint marks a node accepted; only then may successors be admitted. Specify recovery treatment for interruption at each commit boundary, including unmatched events or orphan records. An event log is corroborating evidence, not a replacement resume checkpoint. P2 must cover the commit-boundary cases before later P4 work expands pause/resume coverage.

Before P4, implement against the already frozen versioned graph checkpoint and migration/rejection rules, durable per-node admission/launch/acceptance state, and multi-pending clarification policy. A possibly launched call after a crash must not be auto-replayed. Define run locking and stale/corrupt state diagnosis.

## P1 — inspect, do not execute

Start with P01's assigned positive inspection scenario through existing exported production entry points and real temporary project fixtures. Freeze and assert `workflow.executionSupported:false`, echoed `workflow.execution`, ordered `workflow.outputs`, and declaration-ordered `workflow.nodes`. Include schema-2 run rejection and schema-1 execution controls; these may already pass. Then assign PAR-002 through PAR-004 as separate bounded test/implementation packets. Those negative cases are required P1 acceptance, not deferred beyond P1. Do not add a scheduler or imply P1 execution support.

## P2 — bounded execution

Implement a bounded ready queue, keyed call/attempt/repair state, cancellation classification and serialized persistence transitions only after all P1 cases and the P0 resource, checkpoint and event gates are accepted. Demonstrate overlap with real provider fixture child processes synchronized by started/release files or IPC barriers; use a bounded watchdog and guaranteed cleanup. Never use elapsed-time thresholds to prove concurrency. Cover `maxConcurrency` 1 and 2, slots retained through validation/repair, spaces/Unicode paths, out-of-order completion, and interruption around durable acceptance publication.

## P3 — validated joins

Make acceptance depend on persisted validation, not response arrival. Resolve mappings only from transitive accepted ancestors. Keep explicit named outputs and declared order independent of scheduler completion. A subset join may proceed before an unrelated branch, while overall workflow completion waits for all declared nodes. No continue-on-error or synthesized artifacts.

## P4 — durability

Specify terminal race precedence before coding. Stop admission immediately on error or clarification; drain/cancel bounded in-flight work per the frozen policy, without discarding accepted siblings. Persist potentially multiple runtime-owned pending IDs. Resume from a fresh process using durable graph state; reject unsafe replay of possibly launched work and diagnose lock/checkpoint conflicts. Preserve events without lost or reordered transitions.

## P5 — externally visible behavior

Implement read-only graph timeline inspection, deterministic redacted export, and schema-only replay through actual API/CLI entry points. Add runnable installed-package coverage and compatibility regressions. Keep local fixture, hosted OS, and live-provider proof distinct. Update architecture, CLI/API documentation, sequence index and evidence only when behavior is accepted and observed.

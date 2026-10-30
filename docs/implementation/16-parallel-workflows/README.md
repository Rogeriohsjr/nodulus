# Parallel workflows

Status: P1–P3 are accepted locally and on their exact hosted heads. P3 head d9c2de8c6abcf0fca7c10ea48ab1f6b04fdf5512 passed all Windows/macOS/Linux push and PR checks and title checks; publication skipped. Root's complete instrumented local gate passed lint/typecheck/build, 589 runtime tests and 17 installed-package tests with temporary observer settings restored. [P3 evidence](phase3-evidence.md) preserves earlier failures and attribution limits separately. On the P4 recovery branch, Root/Sol accepted bounded durable pending and node-answer continuation checkpoints, including relevant RED/GREEN, isolated answers/lineage/history and all 35 selected graph/FB080 files, 127 cases. See [P4 evidence](phase4-evidence.md). Fresh-process/recovery/caller-input scenarios, the full P4 gate, delivery and final integration remain pending; all PRs stay draft and unmerged.

## Scope and prerequisites

This work follows [feedback routing](../15-feedback-routing/README.md), preserving its bounded sequential rerouting semantics. Before each implementation phase, verify its prerequisites and inspect the actual exported API/CLI, checkpoint/event store, provider adapters, artifact validation path, and installed-package examples. The main risk gates are exclusive workspace/resource ownership, concurrent event/checkpoint serialization, per-call provider telemetry, and versioned graph resume state. Each requires its recorded scenario and independent review evidence.

## Phases and scenarios

| Phase | Scenarios | Scope and exit gate |
| --- | --- | --- |
| P0 | PAR-DESIGN | Review contract and prerequisites; freeze schema, result fields, pause/error policy, resource policy, event model and checkpoint compatibility before dependent packets. |
| P1 | PAR-001–004 | Positive graph inspection and all negative validation matrices, split into small packets. P01 covers only PAR-001 and compatibility controls; it does not complete P1. Schema-2 is explicitly reported as unsupported for execution. |
| P2 | PAR-010–016 | Bounded scheduler and safe concurrent calls/persistence, gated on completed P1, exclusive resource policy, node-slot lifetime, cancellation classification, a graph checkpoint commit protocol, pause/error semantics and call-keyed telemetry or unknown measurements. |
| P3 | PAR-020–025 | Validated artifact joins, nested forks, terminal paths and deterministic named workflow outputs. |
| P4 | PAR-030–037 | Error, pause, cancellation, caller input and fresh-process resume, gated on versioned graph checkpoints and multiple-pending response shape. |
| P5 | PAR-040–044 | Inspection/export/replay, real CLI and installed archive, legacy and feedback regressions, docs and local final gate. |

Phases are separately gated by prerequisite verification, coordinator dispatch, observed behavioral RED, frozen Sol test review, Luna implementation to GREEN, then Sol code review. The coordinator independently inspects the actual diff, verifies scenario evidence and scoped checks, and makes the final acceptance decision; Sol acceptance alone does not complete a packet or phase. Keep one writer; at most two focused corrections before diagnosis. The current task authorizes continued implementation and a reviewable phase PR stack. Live provider execution and external publication are outside that scope. The documentation-only planning packet uses the docs/skill-metadata exception in [testing policy](../../testing.md); it makes no RED/GREEN claim.

## Contract and staging

Schema version 2 is a strict DAG form: `nodes` is a string array in stable declaration order (a ready-node tie-breaker, not topology); `execution` requires `{kind:"dag", maxConcurrency:<positive safe integer>, dependsOn:{nodeId:[predecessor IDs]}}` and may declare `resources:{nodeId:[exclusive resource keys]}` as defined in [the runtime contract](runtime-contract.md). Every node has exactly one explicit dependency entry and roots use `[]`. Control-only edges are valid. Input artifact mappings may read only from transitive ancestors and must match exact artifact name and contract identity. Workflow outputs are explicit ordered aliases `{name, from, contract}` so results do not depend on completion order.

Reject duplicate node IDs, unknown/self/duplicate edges, cycles, missing dependency entries or referenced nodes/outputs, duplicate workflow output alias names, unknown output sources/contracts, contract mismatch, ambiguous dotted references, unknown fields, unsafe limits, and a schema-2 graph combined with `feedbackRouting`. Each workflow output resolves an exact declared source artifact across the graph; aliases are unique and ordered. Schema-1 ordered workflows retain existing semantics. At the accepted P1 base, inspection reported `workflow.executionSupported:false` and intake rejected valid graph execution. P2 deliberately promotes that capability to true and dispatches the captured graph to its separate executor. Inspection preserves execution fields, output aliases and node declaration order; malformed graphs still fail before provider probes or run creation. The complete runtime remains gated by the remaining phase scenarios.

## Packets and evidence

Accepted foundations include [P10 scheduling](packets/p10-graph-scheduling-implementation.md), [P11 validation slots](packets/p11-validation-slot-tests.md), [P12 persistence](packets/p12-persistence-implementation.md), [P13 repairs](packets/p13a-repair-implementation.md), [measurement isolation](packets/p13b-metric-implementation.md), [provider rejection](packets/p13c-provider-error-implementation.md) and [P14 resource ownership](packets/p14b-resource-matrix-tests.md). The bounded [Windows replacement policy](packets/p12w-windows-replacement-implementation.md) and real forensic controls are reviewed; the earlier incidental actor remains unknown. Coordinator dispatch and prerequisite/RED/review gates control progression; no additional user approval is implied. Keep detailed scenario acceptance and evidence in [scenarios](scenarios.md) and [evidence](evidence.md); mark a box only after its whole scenario is observed and independently reviewed.

## Files

- [Scenario plan](scenarios.md)
- [Implementation gates](implementation.md)
- [Evidence record](evidence.md)
- [Coordinator quality review](coordinator-review.md)
- [Phase stack and execution ledger](stack.md)
- [P2 local exit evidence](phase2-exit.md)
- [P3 evidence](phase3-evidence.md)
- [Frozen graph runtime decisions](runtime-contract.md)
- [P01 test packet](packets/p01-graph-inspection-tests.md)

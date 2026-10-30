# Parallel workflows

Status: planning only. No graph schema, scheduler, persistence changes, tests, or runtime behavior are implemented or accepted. This folder is a staged proposal for schema-version-2 DAG workflows; schema-version-1 ordered workflows remain the supported execution contract until later phases pass their own gates.

## Scope and prerequisites

This work follows [feedback routing](../15-feedback-routing/README.md), but does not alter its bounded sequential rerouting semantics. Before each implementation phase, verify its prerequisites and inspect the actual exported API/CLI, checkpoint/event store, provider adapters, artifact validation path, and installed-package examples. The main risk gates are exclusive workspace/resource ownership, concurrent event/checkpoint serialization, per-call provider telemetry, and versioned graph resume state. None is considered solved by this plan.

## Phases and scenarios

| Phase | Scenarios | Scope and exit gate |
| --- | --- | --- |
| P0 | PAR-DESIGN | Review contract and prerequisites; freeze schema, result fields, pause/error policy, resource policy, event model and checkpoint compatibility before dependent packets. |
| P1 | PAR-001–004 | Positive graph inspection and all negative validation matrices, split into small packets. P01 covers only PAR-001 and compatibility controls; it does not complete P1. Schema-2 is explicitly reported as unsupported for execution. |
| P2 | PAR-010–016 | Bounded scheduler and safe concurrent calls/persistence, gated on completed P1, exclusive resource policy, node-slot lifetime, cancellation classification, a graph checkpoint commit protocol, pause/error semantics and call-keyed telemetry (or reviewed serialized fallback). |
| P3 | PAR-020–025 | Validated artifact joins, nested forks, terminal paths and deterministic named workflow outputs. |
| P4 | PAR-030–036 | Error, pause, cancellation, crash and fresh-process resume, gated on versioned graph checkpoints and multiple-pending response shape. |
| P5 | PAR-040–044 | Inspection/export/replay, real CLI and installed archive, legacy and feedback regressions, docs and local final gate. |

Phases are separately gated by prerequisite verification, coordinator dispatch, observed behavioral RED, frozen Sol test review, Luna implementation to GREEN, then Sol code review. The coordinator independently inspects the actual diff, verifies scenario evidence and scoped checks, and makes the final acceptance decision; Sol acceptance alone does not complete a packet or phase. Keep one writer; at most two focused corrections before diagnosis. The current task authorizes continued implementation and a reviewable phase PR stack. Live provider execution and external publication are outside that scope. The documentation-only planning packet uses the docs/skill-metadata exception in [testing policy](../../testing.md); it makes no RED/GREEN claim.

## Contract draft

Schema version 2 is a strict DAG form: `nodes` is a string array in stable declaration order (a ready-node tie-breaker, not topology); `execution` is `{kind:"dag", maxConcurrency:<positive safe integer>, dependsOn:{nodeId:[predecessor IDs]}}`; every node has exactly one explicit dependency entry and roots use `[]`. Control-only edges are valid. Input artifact mappings may read only from transitive ancestors and must match exact artifact name and contract identity. Workflow outputs are explicit ordered aliases `{name, from, contract}` so results do not depend on completion order.

Reject duplicate node IDs, unknown/self/duplicate edges, cycles, missing dependency entries or referenced nodes/outputs, duplicate workflow output alias names, unknown output sources/contracts, contract mismatch, ambiguous dotted references, unknown fields, unsafe limits, and a schema-2 graph combined with `feedbackRouting`. Each workflow output resolves an exact declared source artifact across the graph; aliases are unique and ordered. Schema-1 ordered workflows retain existing semantics. P1 inspection returns `workflow.executionSupported:false`; `workflow.execution` echoes validated `kind`/`maxConcurrency`/`dependsOn`; `workflow.outputs` echoes ordered alias objects; and `workflow.nodes` preserves declaration order. Intake and run reject schema 2 before provider readiness probes and before creating run state. This means P1 does not implement parallel execution.

## Packets and evidence

The first test packet is [P01](packets/p01-graph-inspection-tests.md). Coordinator dispatch and the prerequisite/RED/review gates control progression; no additional user approval is implied. Keep detailed scenario acceptance and evidence in [scenarios](scenarios.md) and [evidence](evidence.md); leave all boxes unchecked until observed and independently reviewed.

## Files

- [Scenario plan](scenarios.md)
- [Implementation gates](implementation.md)
- [Evidence record](evidence.md)
- [Coordinator quality review](coordinator-review.md)
- [Phase stack and execution ledger](stack.md)
- [P01 test packet](packets/p01-graph-inspection-tests.md)

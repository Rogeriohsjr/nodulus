# Scenario plan

Planning baseline only. All acceptance boxes remain unchecked; scenario names and field shapes are drafts until the stated review gate freezes them.

## P0 — contract and prerequisites

- [ ] PAR-DESIGN — Verify prerequisite evidence and inspect current API/CLI, validation, provider, run-store, event and checkpoint paths. Freeze strict schema-2 shape, inspection capability field, alias resolution, node-slot lifetime, cancellation classification, error precedence (`error > needs_input > success`), pause/drain/multi-pending answer policy, resource/write ownership policy, event sequencing model, and the versioned graph checkpoint/acceptance commit protocol before their dependent implementation packets.

## P1 — definition and read-only inspection

- [x] PAR-001 — Inspect one valid graph with two roots and sinks, a control edge and transitive-ancestor input; include a dependency source declared later in `nodes`. Preserve `workflow.nodes` declaration order, `workflow.execution` as the validated kind/maxConcurrency/dependsOn object, ordered `workflow.outputs` aliases, and `workflow.executionSupported:false`. Declaration order is a stable ready-node tie-breaker, not topology; schema-1 forward-reference behavior remains unchanged. Local three-test GREEN, Sol acceptance and coordinator verification are recorded in evidence; P1 is not complete.
- [x] PAR-002 — Inspect rejection of duplicate node IDs, unknown/self/duplicate edges, missing `dependsOn` entries/nodes/outputs, cycles, duplicate workflow output alias names, and output aliases with unknown source or contract. Output sources resolve exact declared artifacts across the graph. Eleven characterization tests, independent coordinator verification and Sol review are recorded in evidence.
- [x] PAR-003 — Inspect non-ancestor and name/contract mismatch and ambiguous dotted-reference rejection; cover control-only/transitive ancestor mappings and undeclared inherited caller names. Ten tests include observed graph/v1 RED then GREEN, with Sol and independent coordinator acceptance.
- [x] PAR-004 — Reject unknown fields, non-positive/unsafe concurrency limits and graph plus `feedbackRouting`; verify schema-2 intake/run reject before provider probes or run writes. Twenty tests include two strict-field REDs corrected to GREEN; schema-1 legality remains separate. Reviews and final phase gate are recorded in evidence.

P01 owns only `tests/scenarios/par-001-graph-inspection.test.ts` and may add `tests/support/parallel-project.ts`. It covers positive inspection plus schema-2 run-rejection and schema-1 sequence controls. The run rejection already exists and may pass; never fabricate RED. The required behavioral RED is missing valid graph inspection capability. P01 uses the real `inspectWorkflow` and `runWorkflow` entry points, `tests/support/intake-project.ts`, and `tests/support/workflow-sequence.ts`; do not introduce production imports for private helpers. Assert inspection leaves the run tree byte-identical and invokes no provider or validator actions.

P1 is complete only when PAR-001 through PAR-004 pass their own test, implementation, Sol review and coordinator acceptance gates. Completing the positive P01 packet does not permit skipping the malformed-graph cases or dispatching P2.

## P2 — concurrent scheduler and safe runtime

- [ ] PAR-010 — Admit at most `maxConcurrency` active nodes; a slot covers readiness probes, inference, response-only repair, executable validation and durable acceptance publication. Release it only when the node is accepted or its pause/error is stable and its processes have settled. Prove overlap with barriers, limit 1 serialization, and that slow validation or repair does not release a slot early.
- [ ] PAR-011 — Release a dependent only after every predecessor has an accepted, schema-validated artifact; independent branches continue while another branch is active.
- [ ] PAR-012 — Serialize checkpoint/event transitions with unique monotonic sequence and no lost updates under overlap.
- [ ] PAR-013 — Isolate call, attempt, repair-session and telemetry state by call identity; test concurrent provider completion and usage reporting (including `usageForLastCall` shared-state hazard), and response-only corrections on one branch without replaying or changing another branch's actions or evidence.
- [ ] PAR-014 — Enforce the reviewed exclusive workspace/resource and write policy for validators/scripts and shared files; demonstrate conflicts are rejected or serialized per that policy.
- [ ] PAR-015 — Distinguish graph-stop cancellation, node/validator timeout and feedback-region deadline diagnostics. Exercise prelaunch and in-flight cancellation with real fixture descendants; preserve launched/unknown evidence, settle child processes before declaring a stable stop, and keep legacy feedback deadline codes unchanged for feedback workflows.
- [ ] PAR-016 — Exercise interruption before and after durable node acceptance publication. Node artifact, validation and provenance records must be durable before the checkpoint exposes the node as accepted or any successor starts. Use the checkpoint as resume authority; diagnose incomplete or contradictory evidence and never infer replay permission from an orphan artifact or an event alone.

## P3 — joins, outputs and completion

- [ ] PAR-020 — A join waits for all declared dependencies to be accepted and valid, not merely for provider responses.
- [ ] PAR-021 — Support nested forks and joins with exact ancestor-only mappings.
- [ ] PAR-022 — Permit a partial join to proceed while an unrelated branch is still running.
- [ ] PAR-023 — Workflow completion waits for every declared node, including independent terminal paths.
- [ ] PAR-024 — Return explicit named output aliases in declaration order regardless of completion order.
- [ ] PAR-025 — Empty or unavailable values count only where schema permits; missing/invalid output never satisfies a dependency; no fabricated fallback artifacts or continue-on-error.

## P4 — pause, errors, cancellation and recovery

- [ ] PAR-030 — A terminal node error stops new admissions; cancel/drain in-flight calls and preserve already accepted sibling results.
- [ ] PAR-031 — On `needs_input`, stop admission, drain bounded in-flight calls, preserve accepted work and persist every runtime-owned pending response ID.
- [ ] PAR-032 — Validate answers against the exact pending response set. Under the run lock, validate request ID and answer completely before mutation, then atomically persist one answer. With unanswered saved questions, remain `needs_input` and dispatch nothing; when all are answered, resume eligible pending nodes without replaying accepted siblings. If a draining sibling errors, the run is `error`; pending data remains diagnostic and answering cannot turn terminal error into resume.
- [ ] PAR-033 — Fresh-process resume restores graph state and does not auto-replay work that may have launched before a crash.
- [ ] PAR-034 — Enforce run locks and diagnose stale, corrupt or incompatible checkpoints.
- [ ] PAR-035 — Preserve complete, ordered event history across pause/resume and concurrent transitions.
- [ ] PAR-036 — Exercise cancellation, crash windows and multi-pending answers with controlled fixture synchronization and bounded cleanup.
- [ ] PAR-037 — Missing or invalid declared caller inputs pause the graph before any node/provider launch; invalid answers cause no writes, and a fresh-process valid answer resumes the graph without converting caller inputs into node artifacts. Changed workspace references or incompatible captured definitions are diagnosed before answer mutation or provider probes, while current profile/instruction edits are not silently adopted.

## P5 — inspection, delivery and compatibility

- [ ] PAR-040 — Read-only run inspection reports graph and branch states from persisted events/checkpoints.
- [ ] PAR-041 — Diagnostic export is deterministic and redacted for graph definitions and branch/call evidence.
- [ ] PAR-042 — Schema-only replay validates saved artifacts without providers, executable validators, or run writes.
- [ ] PAR-043 — Exercise actual CLI/API and installed archive with temporary project JSON, Markdown, schemas and child-process scripts.
- [ ] PAR-044 — Run legacy sequential, feedback-routing and new graph regressions; update docs; run `npm run check`. Hosted platform checks remain separate evidence.

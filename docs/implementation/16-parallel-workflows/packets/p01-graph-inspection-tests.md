# P01 — graph inspection and preflight tests

Planning packet for the coordinator's P01 test assignment. P0 freezes the result contract below; coordinator dispatch and the prerequisite/RED/review gates control progression, with no additional user approval implied.

## Goal and boundary

Cover only PAR-001: positive graph inspection, plus a schema-2 run-rejection control and schema-1 sequence control. Own `tests/scenarios/par-001-graph-inspection.test.ts`; an optional `tests/support/parallel-project.ts` helper is the only other test-side file. Use the real exported `inspectWorkflow` and `runWorkflow` entry points, `tests/support/intake-project.ts`, and `tests/support/workflow-sequence.ts`; create real temporary project JSON, node definitions, schemas and Markdown. Replace only the external provider boundary if needed. Do not import private production modules or write scheduler/runtime tests in this packet. Negative matrices PAR-002–004 require later separate assignment.

Freeze these inspection fields at P0: `workflow.executionSupported:false`; `workflow.execution` echoes the validated `kind`/`maxConcurrency`/`dependsOn` object; `workflow.outputs` echoes ordered alias objects `{name,from,contract}`; `workflow.nodes` preserves declaration order. Schema-2 run rejection must precede provider readiness/probe and run-state writes. The schema-1 sequence path remains unchanged. Schema-2 run rejection may already pass and is not the required RED; the behavioral RED is failure to inspect the valid graph with those fields.

## Cases

PAR-002 (a later separately assigned packet) also covers duplicate node IDs, duplicate workflow output alias names, and aliases whose exact declared source artifact or contract is unknown. Output aliases resolve exact declared source artifacts across the graph.

- Valid graph has two roots and sinks, one control-only edge, a transitive-ancestor input, and a dependency source declared later in `nodes`; declaration order is a stable tie-breaker, not topology. Preserve alias declaration order.
- Assert inspection has no provider probe/inference or validator action and leaves the run tree byte-identical.
- Assert schema-2 run rejection before probe and run-tree creation; retain the schema-1 sequence control. Do not count an already-passing control as RED.

Use a provider fake that rejects unexpected calls and captures any probe/inference attempt. Assert observable diagnostics and filesystem effects, not private call order. Include Unicode and spaces in at least one project path.

## Gate and evidence to return

Run exactly `npm run build`, then `npx --no-install vitest run tests/scenarios/par-001-graph-inspection.test.ts`; record the assertion-level behavioral RED and scope/hash check. A missing runner, import failure or syntax error is setup failure, not RED. Stop for Sol RED review and the coordinator's independent test/evidence check with no production edits and no other test files. The later GREEN assignment must separately name source ownership; do not implement during this test assignment. Completing P01 does not complete P1: PAR-002 through PAR-004 remain mandatory before P2. No later phase is included.

# P10 GREEN: graph execution foundation

Start only after the corrected P10 tests have coordinator and Sol acceptance. Read `runtime-contract.md`; this implements the first PAR-010/011 subset, not all of P2. Frozen tests cannot change during implementation.

## Ownership

Luna owns new `src/core/execute-graph-workflow.ts`, `src/core/graph-node-runner.ts` and `src/core/graph-state.ts`. Allowed integration edits are `src/core/intake-request.ts`, `src/application/run-workflow.ts`, and the graph capability in `src/core/inspect-workflow.ts`. `src/core/execute-workflow.ts` may only export existing pure helpers/types needed by the new executor: `Node`, `DefinitionContext`, `CapturedInputs`, `OutputArtifact`, `ProviderOutcome`, `parseProviderOutcome`, `validateOutputSet`, `validateValidatorVerdict`, `resolveMappedInputs` and `buildPrompt`. Preserve their bodies and the complete legacy feedback/sequential loop. A small shared graph-validation helper in `workflow-graph.ts` is allowed if needed to avoid inspection/intake drift. Do not alter adapters, CLI, resume, other tests or later-phase surfaces in this packet. Report a concrete blocker before broadening scope.

The coordinator owns design/evidence/stack docs. Other agents may be reading; do not revert their edits. No live provider calls.

## Intake and dispatch

Accept strict schema-2 graphs using the existing graph validator. Resolve all graph node/output declarations before validating ancestor-only mappings; retain legacy sequential preflight order. Reject malformed mappings, graphs, aliases, profiles, contracts and validator files before run creation or provider probes. Preserve required caller contract capture. Save versioned graph definitions and validator entry-file hashes; bind exact saved intake bytes. Dispatch from captured workflow version after intake, preserving the version-1 executor call.

## Execution and publication

The scheduler scans declared node order for dependency-ready work, atomically reserves the complete resource-key set and a concurrency slot, and skips resource-blocked candidates. Missing resource entries mean the exclusive `workspace` key; explicit empty arrays permit independent work. Hold reservations through readiness, inference, required validation and durable acceptance. Await the entire node operation before releasing its slot. Use actual provider ports and `ArtifactValidator`, never adapter imports from core.

Use the package's existing outcome/prompt/mapping helpers, passing only graph ancestor declarations to mapping resolution. Clone mapped values and profile snapshots before exposing them to a provider. Generate runtime call IDs and isolated attempt roots before invocation; preserve true/false/unknown launch evidence. Save raw response, invocation, result, schema/validator verdict and artifact evidence. Required artifacts must validate; missing/invalid/error outcomes never satisfy dependencies. No placeholder artifacts or continue-on-error.

One writer serializes all checkpoint/event/metrics changes. Its commit builds a private next state, persists required evidence, appends the sequenced event, atomically writes `run.json` last, and only then publishes its projection and accepted outputs. A required storage failure poisons the queue and stops admissions. Do not reuse legacy `traceProviderCall`, `appendRunEvent` or metric read/modify/write paths concurrently outside this writer. Optional telemetry cannot change artifact validity or repeat inference; only call-keyed telemetry is usable for graph usage. The detailed checkpoint/hash format is frozen in the runtime contract.

Success waits for all nodes and materializes exact ordered workflow aliases from accepted outputs. Error/clarification closes admission; already active bounded operations must settle before a stable return, and late results cannot reopen admission. Keep the graph outcome representation extensible for later repair/pause/recovery tests without claiming those scenarios complete. Implement only the required foundation now; identify any unfinished behavior precisely.

## Validation and stop

Run build, the frozen P10 + P01-P04 suites, lint and typecheck with the verified subprocess permissions. Record exact counts and source/test hashes, plus any bounded implementation correction. Stop for coordinator and Sol source review. Do not commit, push, weaken tests, mark full P2 complete, or run a package clean/build concurrently with review tests.

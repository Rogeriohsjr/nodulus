---
name: nodulus-scenario-tdd
description: Implement or fix Nodulus runtime scenarios through production entry points using test-first development and real local files and scripts. Use for numbered runtime slices or behavioral regressions, not hosted release configuration.
---

# Implement a Nodulus scenario

Resolve paths from the repository root. Read `AGENTS.md`, `docs/testing.md`, `docs/architecture.md`, and the assigned `docs/implementation/<folder>/README.md`. Follow the index dependencies; do not expand to later slices without task scope.

1. Inspect prerequisite evidence and current code. Identify the first unverified scenario and its observable outcome. If a prerequisite is incomplete, report the concrete gap; do useful preparation without claiming the dependent slice works.
2. Create actual temporary-project fixtures and an entry-point test named with the scenario ID. Keep internal parsing, instruction reading, filesystem storage, schema validation, workflow execution, and script processes real. Replace only external providers/services.
3. Run the test before implementing behavior. Fix harness/setup failures until it fails at the intended assertion. Record command and failure in the folder's evidence.md. If behavior already exists, record that honestly and choose a missing case; never manufacture RED by breaking existing code.
4. Implement the minimum complete behavior with dependencies pointing toward the core. Run the scenario to GREEN; repeat for negative variants. Refactor with the tests green.
5. Run typecheck/build and accumulated scenarios appropriate to this slice. Update acceptance boxes only for observed passes. Record environment, test paths, meaningful RED/GREEN excerpts, and remaining external proof.

Provider fakes must reject unexpected extra calls. Assert that failed or paused nodes never start successors and resumed runs never replay completed nodes. For adapters, launch a real fixture executable instead of stubbing the process runner. For validator scripts, execute the actual script. Resume tests must reopen persisted state in a new instance/process.

Never equate schema-valid output with correct work, provider fixtures with live vendor compatibility, or a local pass with cross-platform proof. Do not claim safe response repair if the adapter reruns side-effecting agent actions.

If a change is genuinely non-TDD, name the exact item and applicable exception in docs/testing.md, then use its replacement verification. Do not exempt an entire slice because it includes configuration.

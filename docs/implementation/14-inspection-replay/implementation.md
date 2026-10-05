# INS implementation sequence

## Current source map

Baseline source revision: `c1bf2d3642539591d3db259b8ccb6ec76aecdfe6` (PR #18); the isolated worktree contains INS-001–005 source and scenario changes. `src/core/intake-request.ts` resolves workflow/node definitions and captures contracts under `context/definitions.json`; `src/core/execute-workflow.ts` persists checkpoints, responses and artifacts; `src/core/execution-events.ts` and `src/application/call-evidence.ts` build execution evidence; `src/adapters/storage/local-intake-storage.ts` provides guarded run-file reads; `src/adapters/validation/process-artifact-validator.ts` executes scripts only during ordinary workflow validation. New inspection/export/replay application services are exported through `src/index.ts` and `src/cli.ts`.

Keep file parsing, store access and schema validation in provider-neutral application/core boundaries. Inspection must not import concrete providers. Export policy belongs in application code and must explicitly classify content-bearing files. Schema replay may reuse Ajv/captured schemas; do not instantiate `ProcessArtifactValidator` in the default replay path because it runs project scripts.

## Checkpoints

### A: Workflow inspection (INS-001)

Implemented locally on 2026-10-05 in `src/application/inspect-workflow.ts`, `src/core/inspect-workflow.ts`, `src/core/workflow-mapping.ts`, `src/core/intake-request.ts`, `src/index.ts`, and `src/cli.ts`. The public `inspectWorkflow(projectRoot, workflowId)` API and `inspect workflow <id> --project <path> --json` command resolve all declared caller contracts. Node mappings use shared preflight rules; workflow and node definitions use the same Ajv schemas as runtime. Project-contained paths are enforced. Effective Codex sandbox defaults to `read-only` when omitted. Inspection reads project files only and does not create or change run records or execute provider/validator processes.

The captured policies expose selected profile fields only; this is configured data, not proof that a provider enforces sandbox settings. The 15-case scenario covers malformed definitions, invalid sources/contracts, unused caller declarations, forward references and provider/validator/run-tree non-invocation. Exact validation and review state is recorded in [evidence](evidence.md).

### B: Saved-run explanation/export (INS-002/003)

Implemented in `src/application/inspect-run.ts` and `export-run.ts`. Read-only inspection summarizes saved states, call/attempt evidence, artifacts and validation; inconsistent evidence is not promoted to accepted status. Export is deterministic and versioned, projects only safe schema/profile summaries, and never writes the run.

### C: Offline replay (INS-004/005)

Implemented in `src/application/replay-run.ts`. Replay reads persisted response candidates and validates them with captured Ajv schemas only. It reports current engine/schema drift and skipped executable validators; it never invokes providers or scripts. Damaged evidence is returned as diagnostics.

### D: User/package handoff (INS-006)

Architecture, user guide and implementation index now cover the new commands. Installed archive tests call the actual CLI and import the new APIs from the packed package. Record final `npm run check`, independent review dispositions and hosted results in [evidence](evidence.md) before marking acceptance.

No visual UI, graph editing, branching, subworkflows, live providers or release/publish work is authorized by this plan.
\n

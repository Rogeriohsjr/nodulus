# 14: Inspect, export and replay saved workflows

Status: implementation complete locally from base revision `c1bf2d3642539591d3db259b8ccb6ec76aecdfe6` (PR #18). INS-001–INS-006 have real-file scenario coverage. Final Sol review findings for schema parity, export redaction, schema-only replay and Windows validator process-tree cleanup have been resolved with regression coverage. The supervised Nodulus documentation/check/review API run succeeded; the current PR head still needs hosted checks. Exact results are in `evidence.md`. Nodulus run records are preserved under the untracked `.nodulus/runs/` directory and excluded from delivery.

As an operator, I want to explain a workflow or stopped run from saved evidence and share a redacted diagnostic record without reading a chat or rerunning work.

## Dependencies

- Folders [04](../04-workflow-sequence/README.md), [05](../05-clarification-resume/README.md), [06](../06-repair-recovery/README.md), and [12](../12-execution-observability/README.md) provide workflow definitions, persistent checkpoints, attempts, events, and validation evidence.
- Folder [13](../13-task-planning/README.md) provides bounded handoff and review patterns; R6 inspection/replay does not require its planning controller.
- Folder 09's remaining hosted release-guard evidence and provider live matrix are not dependencies.
- Current implementation evidence is rechecked from `main`; older index status text is stale and is corrected as part of this slice.

## User scenarios

### INS-001: Inspect a workflow without running it

Given a project with a valid workflow, nodes, mappings, contracts and profiles, when I request workflow inspection, then Nodulus reports the resolved graph, source paths, declared contracts and effective policies without invoking a provider or inferring missing values. Invalid or missing references return structured diagnostics.

### INS-002: Explain a saved run and safe next actions

Given successful, paused, failed, or interrupted saved runs, when I inspect a run, then Nodulus summarizes status, phase, node/attempt timeline, artifact references, validation evidence, known uncertainty and conservative next actions. It reads saved evidence only and does not resume or mutate the run.

### INS-003: Export a portable diagnostic record

Given a saved run, when I export it, then Nodulus emits a deterministic versioned record with safe workflow metadata, timeline, lineage and acceptance evidence. Request/answer text, prompts, responses, credentials, free-form profile strings, schema annotations/literal values and machine-absolute paths are omitted. Contract schemas are summarized by safe structural metadata. Export does not modify saved records.

### INS-004: Replay saved candidates offline

Given saved candidate outputs and captured schemas, when I replay validation, then Nodulus reruns only built-in schema checks, reports comparable pass/fail/unknown results and engine/schema drift, and performs zero provider calls or external actions. Executable validators are identified as skipped; this slice has no script-execution option.

### INS-005: Diagnose incompatible or damaged evidence

Given missing/corrupt/legacy records or incompatible run/engine/schema versions, when I inspect, export or replay, then Nodulus returns honest diagnostics, never invents absent evidence, and does not alter the original records.

### INS-006: Exercise production paths with fixtures

Given real local projects and saved run fixtures, when scenario and installed-package tests invoke the public API and CLI, then inspection/export/replay behavior is verified without network or provider calls, including paths with spaces and Unicode.

## Full R6 direction

- [x] In-scope foundation: workflow/run inspection, portable redacted export, and schema-only offline replay (local scenarios and final gate pass; final independent review/hosted CI are tracked separately below).
- [ ] Future: visual composer/debugger over the same API, preflight, artifact diffs and explicit safe actions.
- [ ] Future dependent work: branches, parallelism and subworkflows.
- [ ] Future: broader fixed model/profile result comparison. This slice compares deterministic saved validation results only; it does not claim inference reproducibility.

## Implementation stages

1. INS-001: Workflow API and CLI implemented. Runtime Ajv definition schemas and the execution mapping validator are shared with inspection. Real-file scenarios cover malformed definitions, source/contract errors and non-invocation.
2. INS-002: Saved-run API and CLI summarize states, attempts, calls, artifacts, validation and safe next actions. Contradictory/mispointed validation evidence is diagnosed; uncertain provider calls block resume-like recommendations.
3. INS-003: Versioned deterministic export API/CLI emits safe profile/schema summaries and portable references while preserving saved run bytes.
4. INS-004/005: Replay uses captured schemas only, reports current engine/schema drift and skipped scripts; corrupt checkpoints/events and malformed responses remain explicit and non-mutating.
5. INS-006: User/architecture docs and installed archive CLI/API scenarios added. The full `npm run check`, final review and hosted checks are recorded as pending until observed.

## Acceptance

- [x] `inspect workflow` resolves declared structure/policies, including runtime schema validation, and reports source-linked diagnostics without side effects (15-case local scenario GREEN; final Sol review found no remaining issue).
- [x] `inspect run` explains terminal and nonterminal records with timeline, attempts, artifacts, validation, uncertainty and safe actions (including a Sol-accepted read-only safety correction).
- [x] Versioned export is portable, deterministic and redacted by default; original runs remain byte-for-byte unchanged. Saved diagnostic codes, event types and operations use closed allowlists with generic fallbacks for unknown strings; private-marker regression cases pass and Sol accepted the focused redaction re-check.
- [x] Default replay checks only captured schemas and never launches providers or scripts; current engine/schema drift is reported (final Sol review found no remaining issue).
- [x] Missing, corrupt, legacy and incompatible data remain explicit and non-mutating.
- [x] Public API and installed CLI paths are covered by real-file scenarios; installed archive tests pass 10/10.
- [x] `npm run check` passes on the final corrected and documented local revision (72 scenario files / 300 tests and 10 installed-archive tests; see evidence).
- [x] A real-file NODE-003 regression confirms timed-out validator descendants are terminated before timeout returns (Windows pass; cross-platform CI pending).
- [x] Supervised Nodulus exported-API workflow records documentation validation, the full quality gate, and the independent Sol review artifact; provider launch fields explicitly show handoff mode.
- [ ] Hosted checks pass on the final PR revision.

See [scenario map](scenarios.md), [implementation notes](implementation.md) and [evidence](evidence.md).
\n

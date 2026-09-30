# 12: Inspect execution traces, provider usage, and cost

Status on 2026-09-30: **checkpoints A–E (OBS-001–010) are locally and independently accepted; checkpoint F (OBS-011/012) has focused package/API validation and one authorized Windows OpenCode/Ollama live cell, with final review and full gate pending**. Qwen generated drafts through Nodulus/OpenCode on localhost Ollama; supervisor integration and factual review remain explicit. See [evidence](evidence.md), the [execution/improvements report](qwen-execution-report.md), [checkpoint D evidence](obs-008-009.md), and the [OBS-010 cost guide](obs-010-cost-estimates.md). Publishing remains outside this scope.

As a user, I want to inspect each workflow step, see the instructions Nodulus sent and the response it received, understand validation and repairs, and compare available token usage and cost without confusing estimates with charges.

## Read in this order

1. [Research and current baseline](research.md): what exists, what each provider exposes, limitations and sources.
2. [Design and file dependencies](design.md): runtime ownership, persisted records, compatibility, and cost semantics.
3. [User scenarios and test assertions](scenarios.md): production-entry-point tests with real local files/processes.
4. [Implementation sequence and AI handoff](implementation.md): checkpoints and scoped assignments.
5. [Evidence](evidence.md): document checks now; future RED/GREEN and live proof separately.
6. [Local Qwen packet experiment](packets/report.md): decomposition skill, two rejected attempts, usage and initial SDLC improvements. This is historical evidence; the later completion is recorded in the execution report.

## Prerequisites and scope

Build on folders [06](../06-repair-recovery/README.md), [07](../07-provider-adapters/README.md), [10](../10-development-workflow/README.md), and [11](../11-opencode-workflow/README.md). The reviewed main revision is `1519183` (PR #7 merged). Recheck these dependencies at implementation time. Folder 09's remaining external release-guard exercise does not block local observability scenarios.

This slice extends the existing local run store, provider adapters, and status command. It preserves artifact validation, bounded response-only repair, provider permissions, and checkpoint-driven resume. It does not add a supervisor LLM, new code-rework loops, or extra inference to measure usage.

## Acceptance sequence

| Done | Checkpoint | Scenarios | Depends on |
| --- | --- | --- | --- |
| [x] | A: Correlated boundary records and timestamps | OBS-001, OBS-002 | Prerequisites above |
| [x] | B: Codex, Cursor, and OpenCode usage | OBS-003, OBS-004, OBS-005 | A |
| [x] | C: Partial evidence and telemetry failures | OBS-006, OBS-007 | B |
| [x] | D: Repair/resume accounting and status | OBS-008, OBS-009 | C |
| [x] | E: Optional reproducible cost estimates | OBS-010 | D; focused checks and independent review accepted at `b57f441` |
| [ ] | F: Portable acceptance and developer handoff | OBS-011, OBS-012 | E; focused acceptance complete, final gate/review pending |

Implementation boxes are checked only with recorded evidence. Fixture GREEN is required for local acceptance; live compatibility has its own matrix and requires later authorization. An unavailable optional live CLI must not block the normal offline test suite.

## Assignment template

> Implement only checkpoint A in docs/implementation/12-execution-observability using the Nodulus scenario TDD skill. Verify prerequisites and read the design/scenarios first. Exercise real application entry points, storage, and child-process fixtures; replace only external inference. Observe a meaningful failing assertion, implement the smallest change, run focused checks, and record evidence. Do not start B, invoke live providers, publish, or mark future checkpoints complete.

This historical assignment template describes the completed checkpoint A. Choose the next explicitly authorized checkpoint for future work.

## 2026-09-29 pilot follow-up

[OBS007A](obs-007-pilot.md) now isolates optional telemetry.json write failure after a valid provider result, preserving counters and diagnostics without repeated inference. The [planning pilot report](../13-task-planning/qwen-planning-pilot-report.md) records local Qwen and supervisor contributions. This was one acceptance case at the time; checkpoint C acceptance is now recorded in the completion report.

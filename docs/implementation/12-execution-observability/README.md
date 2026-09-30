# 12: Inspect execution traces, provider usage, and cost

Status: **researched and planned; implementation has not started**. The current request authorizes documentation only. No runtime changes, new test execution, live inference, publishing, or rollout are authorized by this folder.

As a user, I want to inspect each workflow step, see the instructions Nodulus sent and the response it received, understand validation and repairs, and compare available token usage and cost without confusing estimates with charges.

## Read in this order

1. [Research and current baseline](research.md): what exists, what each provider exposes, limitations and sources.
2. [Design and file dependencies](design.md): runtime ownership, persisted records, compatibility, and cost semantics.
3. [User scenarios and test assertions](scenarios.md): production-entry-point tests with real local files/processes.
4. [Implementation sequence and AI handoff](implementation.md): checkpoints and scoped assignments.
5. [Evidence](evidence.md): document checks now; future RED/GREEN and live proof separately.

## Prerequisites and scope

Build on folders [06](../06-repair-recovery/README.md), [07](../07-provider-adapters/README.md), [10](../10-development-workflow/README.md), and [11](../11-opencode-workflow/README.md). The reviewed main revision is `1519183` (PR #7 merged). Recheck these dependencies at implementation time. Folder 09's remaining external release-guard exercise does not block local observability scenarios.

This slice extends the existing local run store, provider adapters, and status command. It preserves artifact validation, bounded response-only repair, provider permissions, and checkpoint-driven resume. It does not add a supervisor LLM, new code-rework loops, or extra inference to measure usage.

## Acceptance sequence

| Done | Checkpoint | Scenarios | Depends on |
| --- | --- | --- | --- |
| [ ] | A: Correlated boundary records and timestamps | OBS-001, OBS-002 | Prerequisites above |
| [ ] | B: Codex, Cursor, and OpenCode usage | OBS-003, OBS-004, OBS-005 | A |
| [ ] | C: Partial evidence and telemetry failures | OBS-006, OBS-007 | B |
| [ ] | D: Repair/resume accounting and status | OBS-008, OBS-009 | C |
| [ ] | E: Optional reproducible cost estimates | OBS-010 | D |
| [ ] | F: Portable acceptance and developer handoff | OBS-011, OBS-012 | E |

All implementation boxes stay unchecked until exact evidence is recorded. Fixture GREEN is required for local acceptance; live compatibility has its own matrix and requires later authorization. An unavailable optional live CLI must not block the normal offline test suite.

## Assignment template

> Implement only checkpoint A in docs/implementation/12-execution-observability using the Nodulus scenario TDD skill. Verify prerequisites and read the design/scenarios first. Exercise real application entry points, storage, and child-process fixtures; replace only external inference. Observe a meaningful failing assertion, implement the smallest change, run focused checks, and record evidence. Do not start B, invoke live providers, publish, or mark future checkpoints complete.

This template is for a later implementation request; it is not an instruction to execute during the documentation task.

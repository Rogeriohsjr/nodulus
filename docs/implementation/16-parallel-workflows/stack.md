# Phase stack and execution ledger

The user authorized implementation through completion and a stack of phase pull requests. Luna writes assigned test and implementation packets, Sol reviews stable checkpoints, and the coordinator independently verifies actual diffs and results before accepting each milestone. No feature completion or merge readiness is implied by creating a draft PR.

| Phase | Branch | Base | PR | Acceptance |
| --- | --- | --- | --- | --- |
| Planning | `codex/parallel-fork-join` | `main` | [#31](https://github.com/Rogeriohsjr/nodulus/pull/31) | Draft; head `5d7f011` has green push/PR Windows, macOS, Ubuntu and title checks; publishing skipped |
| P1: graph definition and inspection | `codex/parallel-01-graph` | `codex/parallel-fork-join` | Pending creation | PAR-001–004 accepted locally; full gate 522 runtime / 17 package tests; hosted phase checks pending |
| P2: bounded execution | `codex/parallel-02-runtime` | `codex/parallel-01-graph` | Pending | Design gates and PAR-010–016 pending |
| P3: artifact joins and outputs | `codex/parallel-03-joins` | `codex/parallel-02-runtime` | Pending | PAR-020–025 pending |
| P4: durable pause and recovery | `codex/parallel-04-recovery` | `codex/parallel-03-joins` | Pending | PAR-030–037 pending |
| P5: inspection and delivery | `codex/parallel-05-delivery` | `codex/parallel-04-recovery` | Pending | PAR-040–044 and final gates pending |

Each PR describes its own phase and prerequisite, exact validation, and remaining limitations. Until all required phases and integration checks pass, the stack remains unmerged. Hosted checks on each reviewed head are separate from local fixtures and from live-provider proof. No live Nodulus inference is required for the offline acceptance suite.

## Initial dispatch

P01 is assigned to Luna for tests only. The accepted test packet must demonstrate missing valid-graph inspection through existing public APIs, preserve the sequential control, and prove that schema-2 execution is still rejected before side effects. The test hash and observed RED are frozen before implementation. Negative graph scenarios remain required P1 work after the positive packet; finishing P01 does not finish the phase.

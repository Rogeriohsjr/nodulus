# Phase stack and execution ledger

The user authorized implementation through completion and a stack of phase pull requests. Luna writes assigned test and implementation packets, Sol reviews stable checkpoints, and the coordinator independently verifies actual diffs and results before accepting each milestone. No feature completion or merge readiness is implied by creating a draft PR.

| Phase | Branch | Base | PR | Acceptance |
| --- | --- | --- | --- | --- |
| Planning | `codex/parallel-fork-join` | `main` | [#31](https://github.com/Rogeriohsjr/nodulus/pull/31) | Draft; head `5d7f011` has green push/PR Windows, macOS, Ubuntu and title checks; publishing skipped |
| P1: graph definition and inspection | `codex/parallel-01-graph` | `codex/parallel-fork-join` | [#32](https://github.com/Rogeriohsjr/nodulus/pull/32) | Local gate 522 runtime / 17 package tests; head `7eb74bd` green push/PR Windows/macOS/Ubuntu and title checks; publishing skipped; remains draft |
| P2: bounded execution | `codex/parallel-02-runtime` | `codex/parallel-01-graph` | [#33](https://github.com/Rogeriohsjr/nodulus/pull/33) | Partial draft `2547f68`; Root 75 graph / 553 full runtime passed, package16/17 aggregate timeout; hosted push/PR Linux+macOS and title passed, Windows F1 report assertion failed, publishing skipped; PAR-015–016/full phase acceptance pending |
| P3: artifact joins and outputs | `codex/parallel-03-joins` | `codex/parallel-02-runtime` | Pending | PAR-020–025 pending |
| P4: durable pause and recovery | `codex/parallel-04-recovery` | `codex/parallel-03-joins` | Pending | PAR-030–037 pending |
| P5: inspection and delivery | `codex/parallel-05-delivery` | `codex/parallel-04-recovery` | Pending | PAR-040–044 and final gates pending |

Each PR describes its own phase and prerequisite, exact validation, and remaining limitations. Until all required phases and integration checks pass, the stack remains unmerged. Hosted checks on each reviewed head are separate from local fixtures and from live-provider proof. No live Nodulus inference is required for the offline acceptance suite.

## Initial dispatch history

P01 is assigned to Luna for tests only. The accepted test packet must demonstrate missing valid-graph inspection through existing public APIs, preserve the sequential control, and prove that schema-2 execution is still rejected before side effects. The test hash and observed RED are frozen before implementation. Negative graph scenarios remain required P1 work after the positive packet; finishing P01 does not finish the phase.

## Current dispatch

P1 is accepted and P2 is being implemented on its child branch. P10–P14 are bounded accepted checkpoints, with source copies saved for differential review. Root independently passed 75 graph cases after the constructor resource fix and complete resource policy matrix. The earlier instrumented full gate passed 545 runtime / 17 installed-package tests. The latest gate passed 553 runtime tests but failed the first PKG-001 test at its unchanged aggregate five-second guard, 16/17 package cases passed; a bounded diagnostic is planned. The Windows actor and separate DEV-002 occurrence remain unattributed historical failures. The P2 PR is saved as an explicitly partial draft so the reviewed foundations have a durable stack checkpoint and hosted platform proof before cancellation and crash work continues on the same branch. PAR-015–016 remain required; no phase or merge acceptance is implied.

## Local partial revision after 2547f68

The reviewed P15A runtime, canonical forensic match and case-specific package guard passed Root's build/lint/typecheck, 91 combined cases (78 graph plus FB080/node003), and 17 installed-package cases. The subsequent full gate failed555/556 on the recurring unexpected Windows rename denial before gamma; one post-cleanup native report was captured, without a proven actor. It is explicitly retained and keeps final acceptance open. This partial revision will be saved on the same P2 draft; P15B/C and crash cases remain required. Later phase branches have not started.

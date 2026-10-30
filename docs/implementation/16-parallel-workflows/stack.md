# Phase stack and execution ledger

The user authorized implementation through completion and a stack of phase pull requests. Luna writes assigned test and implementation packets, Sol reviews stable checkpoints, and the coordinator independently verifies actual diffs and results before accepting each milestone. No feature completion or merge readiness is implied by creating a draft PR.

| Phase | Branch | Base | PR | Acceptance |
| --- | --- | --- | --- | --- |
| Planning | `codex/parallel-fork-join` | `main` | [#31](https://github.com/Rogeriohsjr/nodulus/pull/31) | Draft; head `5d7f011` has green push/PR Windows, macOS, Ubuntu and title checks; publishing skipped |
| P1: graph definition and inspection | `codex/parallel-01-graph` | `codex/parallel-fork-join` | [#32](https://github.com/Rogeriohsjr/nodulus/pull/32) | Local gate 522 runtime / 17 package tests; head `7eb74bd` green push/PR Windows/macOS/Ubuntu and title checks; publishing skipped; remains draft |
| P2: bounded execution | `codex/parallel-02-runtime` | `codex/parallel-01-graph` | [#33](https://github.com/Rogeriohsjr/nodulus/pull/33) | Local acceptance: Root full579 runtime/17 package with lint/type/build. Final hosted head pending; prior5d775ba allplatform push/PR green. Historical unexpected Windows EPERM retained |
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

The next partial checkpoint restores native-first error classification and transport evidence: Root67 provider/feedback/native cases passed after independent source review. A subsequent conservative Windows uncertainty metadata rule passed fresh build/type and5 selected output controls. B2/C1 actual tests expose missing bounded-return/recovery state and remain outside this preserved implementation checkpoint until their runtime integration is ready. Main source dispatch now uses a reviewed publication fence and one-checkpoint recovery transitions. No later phase branch or merge has started.

After the B2/C1 runtime and atomic failed/cleanup event fix, Root independently passed95/95 accumulated graph cases in23 files,52.53s (p15c3-p16a-graph-accumulated.log). This includes P16A's two passing crash characterizations. Separately, the15-case validator/provider control check passed9.44s; these selections overlap and are not added as unique counts. Build/typecheck/lint pass. B2 external settlement is bounded separately from actual required storage/fence work; conservative cleanup uncertainty covers provider stages and validators without fabricating a second provider completion. e7a0852 hosted checks passed all three platforms before these later changes, so the new checkpoint still needs its own hosted proof. P16B/B2 test-only packets now cover held sibling delivery and an already-durable acceptance whose storage return remains in flight. P16C/D, later phases and final integration remain pending.

Saved checkpoint5d775baa12180464f58fe0e1d7cacb99dda5035d subsequently passed exact-head Windows/macOS/Ubuntu push and PR validation and both title checks; publishing skipped. Root then passed the separate P16B held-delivery characterization (1/1,685ms) and P16B2 in-flight acceptance characterization (1/1,1.30s), with genuine filesystem errors and truthful completed provider evidence. These later tests are not in the hosted checkpoint yet. P16C real error-publication failures and P16D workspace-policy integrity tests are being authored independently; no later phase branch or merge has started.

P16C now passed both real publication-failure characterizations after a diagnosed cleanup-only import repair. P16D's actual1RED/1controlPASS exposed B provider work before policy diagnosis; its reviewed runner guard and stale timer-context correction passed2/2. Root's full npm run check then passed579 runtime/17 installed-package cases, exit0, at the frozen source. [P2 local exit evidence](phase2-exit.md) records scope and limitations. Final hosted P2 validation gates P3 execution; P3's reviewed three-packet design remains planning only until then.

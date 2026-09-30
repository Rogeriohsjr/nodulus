# 13: Reusable task planning and supervised execution

Authorized 2026-09-29. Dependencies: existing caller-input workflows, schema/script validators, local Qwen artifact workflow and OBS-001–005 telemetry. Goal: turn a task into a dependency-ordered, repository-specific junior developer handoff, then use a selected small packet in a tested apply/check flow.

Scope for this run: reusable planning workflow, template/context preparation, deterministic plan validation, bounded one-file application/check receipts, and one actual missing OBS-006/007 behavior as a live local Qwen pilot. Parent OBS stories remain incomplete until every acceptance case is evidenced. Broader OBS work follows the existing sequence after pilot evaluation.

## Scenarios

- [x] PLAN-001: A small task yields one ready packet with repository ID, exact files/symbols, prerequisites, expected behavior, test cases, validation check IDs and documentation paths.
- [x] PLAN-002: A larger task yields ordered packets with unique IDs, valid dependencies, one repository per packet and explicit cross-repository dependencies. Cycles/unknown repositories/dependencies/oversized packets are rejected.
- [x] PLAN-003: TDD tasks name actual tests and a meaningful expected failure. Docs/hosted pipeline/metadata work name an item-specific exception and concrete replacement checks. An upgrade that changes runtime/install behavior still requires TDD.
- [x] PLAN-004: Context is prepared from explicit repository/file/check allowlists. Invented existing files/symbols, escaped paths, stale hashes and unauthorized commands cannot be accepted for execution.
- [x] APPLY-001: A reviewed one-file artifact applies only to an allowed unchanged base, through atomic replacement; rejected paths/stale hashes/fenced source do not alter files. Each attempt has a receipt.
- [x] APPLY-002: Fixed caller-owned checks determine acceptance. Model claims do not; a failing check is recorded and limits advancement. Test hashes are frozen before implementation.
- [x] PILOT-001: Select one missing OBS behavior, observe real RED, generate/apply Qwen implementation, observe GREEN, update docs, run Qwen and focused Sol review. Record every coordinator edit and compare intervention counts with the previous report.

Use actual application workflows, files and processes; fake only external inference for offline scenarios. Templates/docs are the documented non-TDD exception; changed validation/application behavior requires observed RED. The final package check follows documentation changes.

Acceptance evidence: [recorded checks](evidence.md), [new run report](qwen-planning-pilot-report.md), and [usage ledger](qwen-phase-c-ledger.json). These checks establish the bounded supervised slice, not autonomous multi-packet delivery.

## Phase D: bounded remaining-phase recovery

The follow-up implements the planning report's IMP-11 in the packaged helpers. Read the [recovery behavior](phase-recovery.md), [new execution report](qwen-recovery-report.md) and [D usage ledger](qwen-phase-d-ledger.json). A live localhost-Qwen demonstration recovered documentation/review with one code call/application overall. The builder still needed substantial supervisor corrections. OBS006A adds a characterization test for existing nonzero-exit usage retention; parent OBS-006 remains open.

Phase F follow-up: [bounded review-loop evidence, configuration experiments and hiccup history](../13-task-planning/qwen-review-loop-report.md). The loop has controlled live local-Qwen proof; it does not complete remaining OBS scenarios.

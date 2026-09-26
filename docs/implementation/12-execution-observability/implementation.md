# Future implementation sequence and AI handoff

**Do not execute this plan during the documentation task.** The user has requested research and a handoff only. Later authorization must select the checkpoint(s) to implement. All items below are pending.

Read [architecture](../../architecture.md), [testing policy](../../testing.md), [code quality](../../code-quality.md), the [scenario TDD skill](../../../.agents/skills/nodulus-scenario-tdd/SKILL.md), and this folder's design/scenarios. Use the [delivery validation skill](../../../.agents/skills/nodulus-delivery-validation/SKILL.md) for the local archive handoff. No new skill is required: this checklist specializes the existing skills.

## A: Correlated requests and event timeline

- [ ] Write OBS-001/002 with real provider scripts and files; observe missing request records/timestamps as RED.
- [ ] Add optional call metadata contracts in `src/core/ports/provider.ts`. Put shared measurement/event types in focused core modules as needed.
- [ ] Allocate correlation in `src/core/execute-workflow.ts`; adapt `src/adapters/providers/default-provider-port.ts` to persist effective stdin before launching each invoke/repair.
- [ ] Extend existing storage/application event writers consistently, including initial intake and resume; do not timestamp only successful node events.
- [ ] Implement the request/transport links, safe metadata, stable event sequence and coverage of prelaunch failures. Keep existing files and provider arguments compatible.
- [ ] Run focused GREEN, lint/typecheck, and record evidence before B.

## B: Provider-specific measurement translation

- [ ] Create versioned transcripts/manifests for OBS-003/004/005 with source/version and counter semantics clearly separated from fictional numeric values.
- [ ] Observe concrete-adapter null usage as RED through the production run/status path.
- [ ] Extract focused parsers beneath `src/adapters/providers/`; default-provider-port composes them. Core must not parse Codex/Cursor/OpenCode event names.
- [ ] Add call-keyed telemetry plus a compatible legacy-hook bridge; never scrape user-wide session totals.
- [ ] Prove deduplication, missing optional counters, mixed internal steps and unchanged artifact selection. Keep unknown semantic conversions null until supported by evidence.
- [ ] Record GREEN and focused review before C.

## C: Failure handling and measurement validity

- [ ] Add OBS-006/007 fixtures and observe missing partial coverage/diagnostics as RED.
- [ ] Preserve bounded transport output and failure reasons. Extend process-runner only where required to expose existing capture/termination facts; do not raise limits or add unbounded buffering.
- [ ] Validate safe integer counters and finite nonnegative costs. Reset telemetry on every path and preserve accepted artifact behavior independently.
- [ ] Exercise real storage prelaunch failure, timeout, output limits and controlled interruption. Ensure no inference replay for missing logs.
- [ ] Record GREEN and focused review before D.

## D: Repair/resume totals and read compatibility

- [ ] Add OBS-008/009 with a fresh-process resume and actual persisted legacy/corrupt files; observe missing identity/coverage as RED.
- [ ] Add idempotent metrics finalization by call ID; retain the legacy array and optional public port methods.
- [ ] Implement field-level coverage and compatible status aggregation in focused core/application modules, composed by `src/application/resume-workflow.ts`.
- [ ] Update `src/cli.ts` text/JSON projections without contaminating core with formatting. Distinguish reported versus requested model, and incomplete evidence versus a failed workflow.
- [ ] Verify no duplicate measurements, no completed-node replay and no read-time migration. Record GREEN before E.

## E: Optional estimates with frozen provenance

- [ ] Add OBS-010 synthetic rate-card scenarios; observe absent configuration/snapshot/estimate behavior as RED.
- [ ] Extend typed settings loading and capture via existing settings/intake boundaries. Missing configuration preserves current behavior.
- [ ] Implement a pure rate calculator in core, with explicit billing mode, verified token buckets and per-call snapshot references. Do not fetch pricing or account data at runtime.
- [ ] Add status's separate estimate fields and coverage; keep legacy costUsd provider-reported only.
- [ ] Verify snapshot reuse after pause and null diagnostics for unknown inputs. Record GREEN before F.

## F: Delivery, docs and optional live verification

- [ ] Implement OBS-011 through existing exported API and local archive test harness. Preserve custom provider compatibility.
- [ ] Update `docs/user-guide.md`, relevant examples, architecture, scenario index and this evidence file only to describe behavior actually implemented.
- [ ] Run the complete local quality gate; inspect the diff for scope and unintended recorded transcripts/secrets.
- [ ] Obtain hosted fixture results for Windows/macOS/Linux through the existing CI. Any required Actions configuration changes are an item-specific non-TDD exception and need static/hosted evidence, not invented RED.
- [ ] Only after explicit live authorization, execute OBS-012 independently for each available provider/platform. Keep untested cells pending.
- [ ] Record reviewed revision, commits/PR and limitations. Mark implementation acceptance independently from optional live-provider acceptance.

## Test commands for a later developer

These are future commands, **not commands run as part of this plan**. Build before invoking a focused scenario because some tests exercise dist/CLI. For each selected file substitute its actual scenario path:

```text
npm run build
npx vitest run tests/scenarios/obs-001-effective-provider-request.test.ts
npm run lint
npm run typecheck
```

Record the first relevant assertion failure before production edits, then rerun the same test to obtain GREEN. Missing modules, runner setup and syntax failures are not valid behavioral RED. At final implementation handoff run `npm run check`; do not run a parallel build while package tests clean dist. Reuse existing regressions for SAFE/ASK/PROV alongside the focused scenarios.

Documentation and source research use the existing docs non-TDD exception: link, consistency and scope review. This task creates no scenario test files and claims no runtime validation.

## Focused AI review checklist

- [ ] Selected checkpoint and prerequisites are explicit; later checkpoints are untouched.
- [ ] Tests traverse production entry points and real local modules/files/processes. External inference is the only substituted boundary.
- [ ] Behavioral RED/GREEN includes command, assertion, revision and platform. Previously passing regressions are labelled regressions.
- [ ] Call identity covers invoke, response repair, readiness failure and resume without stale or duplicate measurements.
- [ ] Every measurement declares provenance/coverage; cache and reasoning are not double-counted; unknown does not become zero.
- [ ] Existing artifact, repair, permissions, process limits and checkpoint behavior remain covered.
- [ ] No runtime network pricing calls, dashboard access, new telemetry service, provider database access or unsolicited live inference.
- [ ] Lint/typecheck/check results are recorded without weakening rules; docs distinguish planned, fixture-tested and live-proven behavior.

If a later request authorizes builder/reviewer agents, use the existing [agent workflow](../../agent-workflow.md) and current user-selected model overrides. Assign one checkpoint at a time; the reviewer examines a stable test or implementation diff, not a continuously changing tree. Do not launch agents from this documentation request or silently change the established developer/test-review/final-review roles.

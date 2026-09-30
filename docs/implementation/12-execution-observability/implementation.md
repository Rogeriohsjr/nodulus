# Implementation sequence and AI handoff

**Checkpoints A–F are locally and independently accepted as of 2026-09-30.** OBS-012 has one authorized Windows OpenCode/Ollama live result; every other live matrix cell and final hosted fixture proof remain pending. See [evidence](evidence.md) and [checkpoint D evidence](obs-008-009.md) for tested behavior and the local Qwen/coordinator role split.

Read [architecture](../../architecture.md), [testing policy](../../testing.md), [code quality](../../code-quality.md), the [scenario TDD skill](../../../.agents/skills/nodulus-scenario-tdd/SKILL.md), and this folder's design/scenarios. Use the [delivery validation skill](../../../.agents/skills/nodulus-delivery-validation/SKILL.md) for the local archive handoff. No new skill is required: this checklist specializes the existing skills.

## A: Correlated requests and event timeline

- [x] Write OBS-001/002 with real provider scripts and files; observe missing request records/timestamps as RED.
- [x] Add optional call metadata contracts in `src/core/ports/provider.ts`. Put shared measurement/event types in focused core modules as needed.
- [x] Allocate correlation in `src/core/execute-workflow.ts`; adapt `src/adapters/providers/default-provider-port.ts` to persist effective stdin before launching each invoke/repair.
- [x] Extend existing storage/application event writers consistently, including initial intake and resume; do not timestamp only successful node events.
- [x] Implement the request/transport links, safe metadata, stable event sequence and coverage of prelaunch failures. Keep existing files and provider arguments compatible.
- [x] Run focused GREEN, lint/typecheck, and record evidence before B.

## B: Provider-specific measurement translation

- [x] Create versioned transcripts/manifests for OBS-003/004/005 with source/version and counter semantics clearly separated from fictional numeric values.
- [x] Observe concrete-adapter null usage as RED through the production run/status path.
- [x] Extract focused parsers beneath `src/adapters/providers/`; default-provider-port composes them. Core must not parse Codex/Cursor/OpenCode event names.
- [x] Add call-keyed telemetry plus a compatible legacy-hook bridge; never scrape user-wide session totals.
- [x] Prove deduplication, missing optional counters, mixed internal steps and unchanged artifact selection. Keep unknown semantic conversions null until supported by evidence.
- [x] Record GREEN and focused review before C.

## C: Failure handling and measurement validity

- [x] Characterize existing partial transport and invalid-counter behavior; observe missing launch/status evidence as behavioral RED.
- [x] Preserve bounded transport output and failure reasons. Extend process-runner only where required to expose existing capture/termination facts; do not raise limits or add unbounded buffering.
- [x] Validate safe integer counters and finite nonnegative costs. Reset telemetry on every path and preserve accepted artifact behavior independently.
- [x] Exercise real storage prelaunch failure, timeout, output limits and controlled interruption. Ensure no inference replay for missing logs.
- [x] Record GREEN and focused review before D.

## D: Repair/resume totals and read compatibility

- [x] Add OBS-008/009 with a fresh-process resume and actual persisted legacy/corrupt files; OBS-008 was characterization GREEN and OBS-009 observed missing coverage/diagnostics as RED.
- [x] Add idempotent metrics finalization by call ID; retain the legacy array and optional public port methods.
- [x] Implement field-level coverage and compatible status aggregation in focused application modules, composed by `src/application/resume-workflow.ts`.
- [x] Update `src/cli.ts` text/JSON projections without contaminating core with formatting. Distinguish reported model identity, including unknown, from requested model labels.
- [x] Verify no duplicate measurements, no completed-node replay and no read-time migration. Record GREEN before E.

## E: Optional estimates with frozen provenance

- [x] Add OBS-010 synthetic rate-card scenarios; observe absent configuration/snapshot/estimate behavior as RED.
- [x] Extend typed settings loading and capture via existing settings/intake boundaries. Missing configuration preserves current behavior.
- [x] Implement a pure rate calculator in core, with explicit billing mode, verified token buckets and per-call snapshot references. Do not fetch pricing or account data at runtime.
- [x] Add status's separate estimate fields and coverage; keep legacy costUsd provider-reported only.
- [x] Verify snapshot reuse after pause and null diagnostics for unknown inputs. Independent review accepted the corrected implementation at `b57f441`.

## F: Delivery, docs and optional live verification

- [x] Implement OBS-011 through existing exported API and local archive test harness. Preserve invoke-only and legacy custom provider compatibility.
- [x] Update the user/provider guides, scenario index and evidence files to describe behavior actually implemented; ship linked public documentation in the archive.
- [x] Run the complete local quality gate; inspect the diff for scope and unintended recorded transcripts/secrets.
- [ ] Obtain hosted fixture results for Windows/macOS/Linux through the existing CI. Any required Actions configuration changes are an item-specific non-TDD exception and need static/hosted evidence, not invented RED.
- [x] After explicit live authorization, execute the Windows OpenCode/Ollama cell through a freshly packed and installed archive. Keep every untested provider/platform cell pending.
- [x] Record reviewed revision and limitations at `0a97d60`. Mark implementation acceptance independently from optional live-provider acceptance; PR/hosted results follow after push.

## Test commands

Build before invoking a focused scenario because some tests exercise dist/CLI. The completion evidence records the commands actually run; future maintenance should keep the same sequence:

```text
npm run build
npx vitest run tests/scenarios/obs-001-effective-provider-request.test.ts
npm run lint
npm run typecheck
```

Record the first relevant assertion failure before production edits, then rerun the same test to obtain GREEN. Missing modules, runner setup and syntax failures are not valid behavioral RED. At final implementation handoff run `npm run check`; do not run a parallel build while package tests clean dist. Reuse existing regressions for SAFE/ASK/PROV alongside the focused scenarios.

Documentation and source research use the existing docs non-TDD exception: link, consistency and scope review. Runtime behavior is covered by the OBS scenario, installed-package, and opt-in live tests recorded in [evidence](evidence.md).

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

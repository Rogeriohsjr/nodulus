# Planned user scenarios and tests

Status: **all scenarios pending**. Test paths below are proposed, not existing test evidence. Every scenario uses the production application/CLI, real internal adapters, temporary project files, schemas and validator scripts. A real child-process fixture replaces only the external provider executable. Pure parser/math tests can supplement these scenarios, never replace them.

Use `tests/fixtures/observability/` for versioned transcripts, Node executable scripts, project templates and a provenance manifest. Scripts consume stdin, record safe argv/cwd and invocation count, emit configured protocol output and reject unexpected extra calls. Use real files to coordinate termination/failure; do not mock filesystem, process runner, storage or clocks. All data and model prices below are synthetic unless explicitly labelled as a sanitized historical protocol shape.

## OBS-001: Inspect exactly what Nodulus sent

**Given** a real temporary project under a path containing spaces and Unicode, a configured provider fixture, mapped input artifacts and multiline Markdown instructions.

**When** the production run entry point invokes a node.

**Then** the fixture's captured stdin equals the new call's stdin.txt byte for byte, including adapter-added suffixes. The prelaunch request.json exists before the fixture emits output, has safe argv/cwd, run/node/attempt/call identity and requested model, and points back to the base prompt. The received transport and accepted outcome have distinct file references. Parameterize Codex, Cursor and OpenCode; retain their current outcome parsing and permissions.

**Relevant RED:** current runs have no correlated effective-stdin record. Proposed test: `tests/scenarios/obs-001-effective-provider-request.test.ts`.

## OBS-002: Reconstruct the workflow timeline

**Given** a two-node workflow and a real output validator which deliberately rejects the first node's otherwise schema-valid artifact.

**When** the CLI executes it with response repair disabled.

**Then** timestamps are valid UTC values, event sequences strictly increase, call start/end identity joins to validation/error evidence, elapsed time is finite/nonnegative, and the second node's fixture invocation count is zero. A successful variant advances only after validation. The log contains no environment-secret sentinel or non-allowlisted credential/profile fields. Prompt/output contents are not promised generic redaction.

**Relevant RED:** new timestamp/sequence/call references are absent. Proposed test: `tests/scenarios/obs-002-correlated-timeline.test.ts`.

## OBS-003: Read Codex usage without confusing it with the artifact

**Given** a Codex fixture emitting item events, a valid last-message outcome, and terminal turn usage with reported input 1000, cached input 200, output 100, reasoning output 20.

**When** Nodulus runs and status reads the saved call.

**Then** reported counters are 1000/200/100/20, source references the terminal turn, the artifact is still accepted, and provider cost is null. A fixture manifest with verified inclusive semantics permits normalized totals 1000 and 100; removing that semantic evidence keeps the reported counters and leaves affected normalized totals unknown. Multiple supported turn records are accounted once each; item text that looks like usage is ignored. Optional missing fields remain null.

**Relevant RED:** concrete Codex adapter returns null usage. Proposed test: `tests/scenarios/obs-003-codex-usage.test.ts`.

## OBS-004: Accept Cursor with or without optional usage

**Given** Cursor terminal-result fixtures both with optional camelCase usage (input 6766, output 65, cache read 3840, cache write 0) and without it, with valid identical outcome text.

**When** separate runs use the existing JSON adapter.

**Then** both succeed. The first preserves those reported values with version-specific provenance and explicit unknown cache inclusion unless independently verified; the second reports unavailable metrics, never zeros. Missing reported model is null even when the profile requested one. Strings such as `"65"` are not silently coerced into counters.

**Relevant RED:** optional concrete Cursor usage is currently discarded. Proposed test: `tests/scenarios/obs-004-cursor-optional-usage.test.ts`.

## OBS-005: Count OpenCode internal steps exactly once

**Given** an OpenCode fixture containing step parts A and B with distinct IDs and reported input/output/cache-read/cache-write/reasoning counts of A=100/20/30/5/4 and B=200/40/50/7/6. Their synthetic reported USD costs are 0.001 and 0.002. The stream also repeats A identically, supplies an assistant-level summary, and finishes with a valid artifact.

**When** the production adapter handles the stream.

**Then** reported sums are input 300, output 60, cache-read 80, cache-write 12, reasoning 10, cost 0.003 (with numeric tolerance), and exactly two unique steps. The duplicate and assistant summary add nothing. Artifact selection remains based on the existing final stopped-message behavior. A semantic profile verified to exclude cache from input may normalize input to 392; without evidence that conversion stays null. Conflicting duplicate IDs and missing completion produce incomplete coverage, not a complete total.

**Relevant RED:** OpenCode usage is currently null despite its captured events. Proposed test: `tests/scenarios/obs-005-opencode-step-usage.test.ts`.

## OBS-006: Preserve partial evidence on provider failure

**Given** scripts that emit known usage for one internal step and then exit nonzero, wait for timeout, emit a truncated terminal line, or exceed the existing output limit.

**When** Nodulus invokes each script through its real runner.

**Then** existing provider failure behavior and downstream blocking remain intact. Any captured usage is retained with partial coverage and transport limits/status. A readiness failure has `launched: false`, no invented token/cost total and no inference subprocess. A controlled killed Nodulus process leaves a prelaunch record; a fresh status process reports incomplete evidence without launching anything. Assert cleanup with process/file synchronization, not a long sleep. Do not demand output that the bounded runner never retained.

**Relevant RED:** no call-level capture/coverage status exists. Proposed test: `tests/scenarios/obs-006-partial-provider-evidence.test.ts`.

## OBS-007: Isolate invalid telemetry from valid work

**Given** a provider fixture with a valid artifact but counters that are negative, fractional, unsafe integers, strings or invalid types; also a valid first call followed by a second call throwing before reporting usage.

**When** the workflow executes.

**Then** malformed measurements become null with a field-specific diagnostic; valid fields survive where meaningful; the valid artifact is not retried solely for telemetry. The throwing second call never inherits the first call's counters. Test a real file occupying the planned calls directory: request-record persistence fails before inference and fixture count stays zero. Existing process and artifact errors retain their own identity.

**Relevant RED:** call-scoped diagnostics/reset contract and prelaunch request records do not exist. Proposed test: `tests/scenarios/obs-007-telemetry-isolation.test.ts`.

## OBS-008: Include repairs and avoid recounting on resume

**Given** node A succeeds, node B emits malformed outcome text, a first response-only repair is also invalid, and a second safe repair returns valid needs_input. These four calls each report input 10 and output 2. After an answer, B returns success with input 20/output 4.

**When** the first CLI exits paused, another process resumes it, and status is read twice.

**Then** exactly five call IDs exist, operations distinguish two repairs, input total is 60 and output total 12 under verified semantics, and A's fixture count remains one. Each repair's actual stdin contains the appropriate prior response and exact validation errors. No third repair or automatic tool/action replay occurs. A resumed completed run creates no sixth call. Keep provider repair capability restrictions unchanged.

**Relevant RED:** call identity/effective repair prompts and concrete usage accounting are missing. Proposed test: `tests/scenarios/obs-008-repair-resume-accounting.test.ts`.

## OBS-009: Report incomplete and legacy histories honestly

**Given** two launched calls where the first has input 100/output 20/cost 0.01 and the second has unknown input, output 5 and unknown cost; plus separate legacy, missing-metrics and corrupted-metrics run fixtures.

**When** CLI JSON/text status and the public status application read these real run directories without mutation.

**Then** input total is null/subtotal 100/knownCalls 1/totalCalls 2; output total is 25; cost total is null/subtotal 0.01. Legacy rows and untimestamped events remain readable, labelled legacy; missing metrics are unavailable; corrupt metrics and invalid complete JSONL lines have explicit diagnostics. A trailing partial line is diagnosed separately. No provider calls, migrations or fabricated zero totals occur; checkpoint determines run status.

**Relevant RED:** status lacks coverage/subtotals and hides corrupt metrics as an empty list. Proposed test: `tests/scenarios/obs-009-status-coverage-and-legacy.test.ts`.

## OBS-010: Estimate cost reproducibly without claiming a charge

**Given** the fictional rate card and counters in [the design](design.md), an explicit API billing mode, and a reported model matching the rate entry.

**When** a run pauses, the external rate file changes, and the run resumes in a new process.

**Then** estimates use the original snapshot/hash and equal 0.0022 per matching call, within a documented tolerance. Reasoning is not billed twice. Provider-reported cost remains a separate field. Parameterize absent cache rates, invalid configured rates, missing model identity, unknown semantics, local/subscription modes and reported zero. No policy means no estimate; invalid explicit policy fails before inference; unknown inputs never produce zero. A requested API-equivalent subscription estimate is visibly hypothetical, not actual billing.

**Relevant RED:** no captured pricing policy or estimate provenance exists. Proposed test: `tests/scenarios/obs-010-cost-provenance.test.ts`.

## OBS-011: Keep custom providers and installed packages compatible

**Given** a packed local archive installed into a temporary project and a custom provider implementing only the existing required port method; a second custom provider supplies the legacy usage hook.

**When** the installed CLI runs/statuses a fixture workflow and the exported API runs those custom providers.

**Then** existing provider implementations still work, new optional telemetry is unavailable or labelled legacy, machine output remains valid JSON, and the shipped user guide explains actual supported logging/coverage semantics. Use the existing package test harness; no registry install/publish. Run fixture tests on Windows/macOS/Linux using argument arrays and Node scripts.

**Relevant RED:** new status/installed-guide behavior is missing; do not fabricate RED from an old compatibility assertion that already passes. Proposed scenario file: `tests/scenarios/obs-011-public-api-compatibility.test.ts`; add package assertions to existing `tests/scenarios/pkg-001-installed-archive.test.ts` so the package suite remains sequential.

## OBS-012: Verify real provider protocol compatibility explicitly

**Given** future explicit authorization and an installed authenticated Codex, Cursor or OpenCode CLI.

**When** an opt-in, bounded, read-only smoke invokes the production adapter on a tiny known artifact request.

**Then** record Nodulus/CLI/model/OS versions, effective request/transport/telemetry references, artifact validation and observed coverage. Missing optional usage is an honest supported outcome. Sanitize before turning a transcript into a committed fixture. Do not assert exact live token counts or actual billing. Extend the existing Cursor live harness where appropriate; other live scripts must also be opt-in and outside `npm test`/`npm run check`.

This is compatibility verification after fixture GREEN, not behavioral RED. Installing/authenticating a CLI is not inference proof. Leave each untested provider/platform cell pending; a Windows fixture pass does not prove live macOS/Linux compatibility.

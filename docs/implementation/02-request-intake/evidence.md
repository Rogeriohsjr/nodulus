# Evidence: 02-request-intake

Status: local GREEN checkpoint; awaiting independent review. Intake is an internal milestone and does not execute workflows or expose public `run` success.

## Environment and contract

- Branch: `codex/nodulus-v1-stories`; Windows; Node/npm versions not separately captured.
- Request sources: exactly one inline, UTF-8 file resolved from caller `cwd`, or stdin text. Exact text is written to `request.md` and `inputs.json`.
- Definitions use the INIT-001 schemaVersion 1 settings/workflow/node starter shapes. Intake validates workflow/node schemas, enabled provider-profile references, structural mappings, referenced contracts, and ordered instructions before run creation.
- References manifest shape: `{references:[{path,mode:"snapshot"|"workspace"}]}`. Manifest argument resolves from caller `cwd`; entries resolve from project root. `references.json` records absolute paths and SHA-256; snapshot entries include captured UTF-8 content, workspace entries retain path/hash.
- Internal run storage includes `run.json`, `events.jsonl`, normalized inputs, references, and captured workflow/node/contracts context. It snapshots only safe provider-profile fields used by the workflow (`enabled`, `executable`, `model`, `timeout`/`timeoutMs`, and string capabilities); credential fields are excluded. Preflight errors have no run ID or durable run directory. No provider executable is launched; there is no terminal result artifact.

## Scenario evidence

| Scenario | RED evidence | GREEN evidence | Remaining proof |
| --- | --- | --- | --- |
| REQ-001 | `npx vitest run tests/scenarios/req-001-normalize-request-sources.test.ts` failed at `INTAKE_NOT_IMPLEMENTED` after reaching the API. | `npm run test:scenarios` — exact inline, relative-file, and stdin text persisted; distinct IDs, context, checkpoint, and event verified. | Independent review; broader caller integrations |
| REQ-002 | `npx vitest run tests/scenarios/req-002-reject-invalid-request-source.test.ts` reached API and mismatched `REQUEST_SOURCE_INVALID`. | `npm run test:scenarios` — missing, conflicting, and unreadable sources return actionable errors without creating a run. | Independent review |
| REQ-003 | `npx vitest run tests/scenarios/req-003-capture-references.test.ts` reached API but references were not persisted. | `npm run test:scenarios` — relative manifest arg resolved from caller cwd; Unicode/space entries from project root; SHA-256 and snapshot/workspace policy verified. | Independent review; workspace change handling is a later resume concern |
| REQ-004 | Initial test had the missing-instruction fixture pointing at `unconfigured`, which masked the intended failure. Corrected it to the valid `fixture` profile and asserted the missing path in the message. Rerun: all four cases passed existing behavior; no RED was manufactured. | `npm run test:scenarios` — all four malformed-definition cases return actionable pre-run diagnostics with no durable run. | Independent review; full graph validation remains folder 04 |
| REQ-005 | Initial implementation passed request/context assertions but failed the added resolved-profile assertion: `expected undefined to deeply equal { fixture: { enabled, executable, model, timeoutMs } }`. | `npm run test:scenarios` — large request and ordered instructions preserved literally; safe provider executable/model/timeout are captured and credential metadata is absent. | Independent review |

## Validation

- `npm run typecheck`: passed after profile snapshot change.
- `npm run build`: passed after profile snapshot change.
- `npm run test:scenarios`: passed after profile snapshot change, 9 files / 21 tests (includes accumulated INIT scenarios and the 13 folder 02 cases).
- `git diff --check`: passed.
- No hosted, live-provider, or package-install checks were run; these are outside this slice.

## Handoff

- Implementation: CLI-neutral `createIntake` core uses an `IntakeStorage` port; application composition binds the local filesystem adapter. The package entry source exports the application API. Public CLI `run` remains absent.
- Reviewer: inspect path/config contracts and evidence; no folder 03 work has started.

## Final acceptance

Sol independently accepted folder 02 after correcting test isolation and adding a safe resolved-profile snapshot regression. Final builder checks: typecheck/build plus 9 files / 21 tests passed on Windows. Sol independently reran the corrected cases (5/5). No provider execution, hosted validation, or terminal workflow success is claimed. Coordinator marked folder 02 complete.

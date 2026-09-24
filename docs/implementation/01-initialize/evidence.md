# Evidence: 01-initialize

Status: folder 01 accepted locally on Windows. INIT-001 was reviewed in the pilot; INIT-002 through INIT-004 were independently accepted by GPT-6 Sol on 2026-09-24.

## Environment

- Base revision: `5af3ae5efae548b40cb1ebc3492d38e7ab64af9f`
- Working diff: uncommitted; includes prior user documentation work and the accepted 00-foundation files.
- OS and Node/npm: Windows; Node.js `v24.15.0`; npm `11.12.1`
- Owner/date: Codex, 2026-09-24

## Scenario evidence

| Scenario | Test file and test name | RED command / meaningful failure | GREEN command / result | Remaining proof |
| --- | --- | --- | --- | --- |
| INIT-001 | `tests/scenarios/init-001-create-project.test.ts`: `INIT-001 creates a usable starter project from an empty directory`; help assertion `INIT-001 init help explains the generated project files` | Initial RED at base `5af3ae5efae548b40cb1ebc3492d38e7ab64af9f`: missing `.nodulus/settings.json`. After review, the test resolved `node.instructions[0]` from the project root and `npm run test:scenarios` failed with `ENOENT` for `<temp-project>\\instructions\\example.md`; this exposed the incorrect project-root-relative reference. Both runs reached the compiled CLI; help passed. | After correcting the starter node to `.nodulus/instructions/example.md`, `npm run typecheck`, `npm run build`, and `npm run test:scenarios` passed. Vitest: 1 file, 2 tests passed. The test checks all starter files, JSON parsing, workflow-to-node and node-to-instruction/contract references, Ajv 2020-12 schema validity/sample acceptance and rejection, non-empty content at the resolved instruction path, run ignore rule, and `init --help`. | Local Windows only; independent review accepted; macOS/Linux remain open |
| INIT-002 | `tests/scenarios/init-002-preserve-project.test.ts`: `INIT-002 preserves edited project files and adds only missing defaults` | No behavioral RED manufactured: current INIT-001 create-if-missing/ignore-line behavior already satisfies this case. | `npx vitest run tests/scenarios/init-002-preserve-project.test.ts`: 1 test passed. It preserves edited settings/instructions and user ignore rules, restores a removed contract, avoids duplicate ignore entries, and uses relative `--project` from nested cwd. | Independent Sol review accepted; no change was required for the observed case |
| INIT-003 | `tests/scenarios/init-003-doctor-readiness.test.ts`: nested-cwd ancestor discovery/empty profiles; available/disabled/missing/non-executable paths | `npx vitest run tests/scenarios/init-003-doctor-readiness.test.ts`: initial RED showed no doctor JSON. Sol's added Windows `.txt` regression then failed as intended: `text` was reported `available` but expected `unavailable`. The platform marker fixture's control run succeeded and its marker was cleared before doctor ran. | `npm run test:scenarios`: full suite passed, including these 2 tests. Windows direct paths now require a case-insensitive `PATHEXT` suffix; the `.txt` entry is unavailable, four profile results match exactly, and the fixture marker remains absent. | Local Windows only; executable availability does not establish authentication or model readiness; no provider executable is invoked |
| INIT-004 | `tests/scenarios/init-004-machine-errors.test.ts`: unknown option, malformed settings JSON, invalid settings shape | `npx vitest run tests/scenarios/init-004-machine-errors.test.ts`: before implementation, unknown option exited 1 without a JSON envelope; malformed and invalid-shape settings exited 0 with empty stdout because doctor was a no-op. | `npm run test:scenarios`: full suite passed, including these 3 tests. Each error emits one parseable envelope with `status:error`, `runId:null`, a nonempty code, and a message identifying the failure. No stack trace is emitted. | Local Windows only; exact error wording is not a stable public contract |

Expand rows for parameterized cases. Paste concise assertion/output excerpts or link durable logs. Do not invent command output. For an applicable exception, replace RED with N/A, explain why, and record replacement verification.

## Accumulated validation

- Typecheck: `npm run typecheck` passed.
- Build: `npm run build` passed; the scenario script also rebuilt successfully.
- Scenario suite: `npm run test:scenarios` passed, 4 files and 8 tests. INIT-001's 2 tests and INIT-002's 1 test passed alongside the new INIT-003/004 tests. Windows/Node only.
- Package checks (when available): not run
- Hosted/live verification (when applicable): not run

## Handoff

- Files added for INIT-002/003/004: `tests/support/production-cli.ts`; `tests/scenarios/init-002-preserve-project.test.ts`, `init-003-doctor-readiness.test.ts`, and `init-004-machine-errors.test.ts`; `src/core/project-settings.ts`, `src/core/doctor-project.ts`, `src/core/shared/nodulus-error.ts`, `src/core/ports/project-settings.ts`, `src/adapters/storage/local-project-settings.ts`, and `src/adapters/storage/local-executable-discovery.ts`.
- Files updated for INIT-002/003/004: `src/cli.ts` and `src/bin.ts` compose settings and executable discovery and normalize machine errors. Tests use real temporary projects and a platform `.cmd`/`.sh` fixture that would write a marker if doctor launched it.
- Contract decisions/deviations: doctor discovers whether an executable path exists; Windows candidates are restricted to case-insensitive `PATHEXT` extensions, while POSIX candidates require execute permission. It does not validate credentials, model access, or inference. Extra provider-profile metadata is ignored/preserved. Settings validation requires schemaVersion 1, a non-empty defaultWorkflow, providerProfiles object, and enabled/executable fields per profile. INIT-002 already passed before additional behavior changes, so no behavioral RED was manufactured.
- Remaining issues and next eligible folder: final Sol review accepted after the executable-extension regression was fixed. Folder 02 is next and outside this assignment.

## Settings and doctor behavior

- Settings retain the initialized shape: `schemaVersion: 1`, string `defaultWorkflow`, and `providerProfiles` as a name-to-profile object.
- `LocalExecutableDiscovery` checks project-relative paths, absolute paths, and executable names on `PATH` using filesystem metadata only. Disabled profiles are reported without invoking the configured executable.
- Doctor JSON uses the architecture envelope `{schemaVersion:1,status,runId,result}` with `status: "success"`, `runId: null`, and `result.providers` entries `{profile,status}`. The fixture test expects exactly four entries: available, disabled, missing executable, and a non-executable `.txt` file. Empty profiles produce a clear message; no model or credential values are invented.
- Parser and settings errors use one stdout JSON object with the same envelope, `status: "error"`, and `runId: null`. `result.code` and `result.message` are nonempty; codes distinguish usage, malformed JSON, and invalid settings.

## Review acceptance

Luna independently reproduced RED, reviewed GREEN, found the instruction path bug, and accepted the correction after independently rerunning the focused suite (2/2 passed). Coordinator accepted INIT-001 only. INIT-002/003/004 were subsequently accepted by Sol. No live provider or hosted checks ran.

## Final Sol review (2026-09-24)

Sol reviewed the test checkpoint and implementation independently. The test review strengthened detection of any provider invocation; implementation review found and reproduced the Windows plain-text-file availability bug. A production-CLI regression demonstrated RED before the extension fix. Final independent review accepted the corrected code and reran build plus all 4 scenario files / 8 tests successfully; independent typecheck also passed. These are local Windows results, not hosted or live-provider proof. All folder-01 acceptance boxes are now complete.

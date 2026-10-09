# Evidence: execution observability

## Documentation task

- Date: 2026-09-25.

- Scope: online source research, repository baseline inspection, scenario/design/implementation handoff documentation only.

- Baseline: main `1519183`, `feat: add OpenCode development workflows (#7)`.

- Sources and limitations: [research.md](research.md).

- Document validation: a scoped Python check passed for 10 Markdown files and 86 local link targets, balanced code fences, unique OBS-001 through OBS-012 headings and no prematurely checked implementation boxes. Manual consistency review covered scenario/checkpoint mapping, baseline versus proposal, nullable costs and deferred live proof. `git diff --check` passed on Windows. This verifies document structure, not runtime behavior or provider billing.

- Runtime implementation, scenario creation/execution, lint/typecheck/full check and live-provider calls: **not performed for this slice**. Documentation follows the explicit non-TDD exception in [testing policy](../../testing.md).

## Runtime evidence

| Checkpoint | Relevant RED | GREEN / regression evidence | Review | Status |
| --- | --- | --- | --- | --- |
| A / OBS-001,002 | Missing calls directory; undefined event timestamp; missing accepted result ref; non-string boundary marked successful; resume missing time/sequence | 164 scenario + 7 package tests, lint/typecheck; focused 29 tests | GPT-5.6 Sol ACCEPT after corrections; local Qwen helper review accepted | Locally accepted 2026-09-28 |
| B / OBS-003,004,005 | Missing call-level telemetry and version-aware normalization | 183 scenarios + 7 package tests after archive correction | GPT-5.6 Sol ACCEPT | Locally accepted; hosted evidence recorded on PR #12 |
| C / OBS-006,007 | Missing launch classification and interrupted-call status | 260 scenarios + 9 package tests | GPT-5.6 Sol ACCEPT after documentation correction | Locally accepted |
| D / OBS-008,009 | OBS-008 characterization GREEN; OBS-009 coverage/diagnostic assertions failed | 33 focused OBS-003–009 tests pass; hosted run 36672162478 passed Windows/macOS/Linux, publish skipped | GPT-5.6 Sol ACCEPT at e3ee261 | [Checkpoint D evidence](obs-008-009.md) |
| E / OBS-010 | Exact calculator, captured snapshot and invalid-before-inference assertions failed; review counterexamples then exposed real evidence, cache-bucket and valid-tamper gaps | Sequential build; 2 focused files / 10 tests pass; lint/typecheck | Local Qwen source ACCEPT missed adapter/integrity cases; independent Sol ACCEPT at `b57f441` after exact counterexamples | Locally accepted |
| F / OBS-011 | Existing installed/public acceptance omitted status and invoke-only/legacy telemetry compatibility | Full gate: lint, typecheck, 67 files / 281 scenarios, installed archive 9/9; post-review lint + installed archive 10/10; live 1/1; hosted run `36679523915` passed Windows/macOS/Linux | Local Qwen drafts rejected for invented APIs; supervisor roadblock integration; independent Sol ACCEPT at `0a97d60` after installed-guide and build-freshness corrections | Accepted; publish skipped |

For every row record actual test names, exact commands, the meaningful failing assertion, passing result, source revision, OS/Node version and unresolved limitations. Record lint/typecheck/full check at the appropriate checkpoints. Never replace a pending entry with an expected result from scenarios.md.

## Future live compatibility: OBS-012

| Provider | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Codex | Pending | Pending | Pending |
| Cursor | Pending | Pending | Pending |
| OpenCode/Ollama | PASS: installed archive 1.0.0, OpenCode 1.18.32, local Qwen2 14.8B Q4_K_M | Pending | Pending |

Prior provider invocation proof in folders 10/11 does not establish this slice's telemetry, cost or exact-input capture. For each future cell, record explicit authorization, CLI/model/Nodulus versions, fixture-GREEN prerequisite, command/result, sanitized evidence references and observed completeness. Unsupported usage remains an accepted limitation, not a fabricated measurement. Actual billing reconciliation remains out of scope.

The final Windows OpenCode/Ollama cell used a freshly built, packed and isolated installation, not the older global builder CLI. Package 1.0.0 archive SHA-256 `405e93a533142542f3f069201534886cf3d4b7ed87aa6d883f50b74c84af0662` was packed from the dirty post-review checkpoint-F tree based on `133c56d`. Installed Nodulus invoked OpenCode 1.18.32 against `http://127.0.0.1:11434` with `ollama/qwen-nodulus-coder:latest` (Qwen2 14.8B Q4_K_M). Run `28e2158d-adbc-48ea-8808-a033ecc133a6`, call `3e768629-770c-47e5-9ee0-f46aec05b32e`, reported complete input 357, output 56, cache read 113, cache write/reasoning 0, provider-reported cost 0, and normalized input/output 470/56. The sanitized local evidence omits prompt and transcript. Every other matrix cell remains pending.

The opt-in test builds before packing, so its standalone command cannot reuse stale `dist`: `$env:NODULUS_LIVE_OPENCODE='1'; $env:NODULUS_LIVE_OPENCODE_CONFIG=(Resolve-Path 'opencode.json'); $env:NODULUS_LIVE_OPENCODE_MODEL='ollama/qwen-nodulus-coder:latest'; npx vitest run tests/live/opencode-observability.live.test.ts`. The local config must resolve to a loopback Ollama endpoint; the harness rejects any other provider/model boundary before inference.

Final hosted fixture run [36679523915](https://github.com/Rogeriohsjr/nodulus/actions/runs/36679523915) validated source head `42842fa` on Windows, macOS, and Ubuntu. All three jobs passed and the publish job was skipped. Hosted jobs use fixtures; they do not add live-provider matrix cells.



## Checkpoint A completion: 2026-09-28

Base `42397bc`, branch `codex/observability-qwen`; Windows, Node v24.15.0. User explicitly authorized finishing OBS-001/002 through local Qwen with coordinator roadblock fixes. [Execution report](qwen-execution-report.md) separates Qwen generation, coordinator integration, local usage and future product work.

- OBS-001 initial behavioral RED: effective-call directory absent, `expected false to be true`. Earlier wrong imports/harness failures are not RED evidence. GREEN expanded to real Codex/Cursor/OpenCode child fixtures under Unicode/spaced paths, multiline instructions/input, byte-equal effective stdin present at child startup, safe argv/cwd/model metadata and existing parse/permission behavior.

- OBS-002 behavioral RED: event timestamp undefined (`expected undefined to be type string`). Real two-node workflows with a real accepting/rejecting validator now show increasing sequence/time, call/validation joins, finite nonnegative duration and no successor call on rejected validation.

- Resume regression RED at 09:29:33 EDT: `run.resumed` omitted timestamp/sequence. After shared-writer integration, the same two provider resume cases passed at 09:29:48.

- Review regression RED at 09:37:08: three adapters lacked `refs.result`; invoke and repair returned `failed: false` for runtime non-string responses. After correction, eight focused OBS tests passed at 09:38:20. The mapped-artifact test initially asserted the wrong saved artifact shape; that harness correction is not product RED.

- Added existing-behavior coverage for a mapped validated predecessor through a real Codex process and a real file blocking calls-directory creation (zero inference). Added unique call IDs, parent chain, exact stdin and validation links to the existing two-repair OpenCode scenario; no replayed build call.

- `npx vitest run tests/scenarios/obs-001-effective-provider-request.test.ts tests/scenarios/obs-002-correlated-timeline.test.ts tests/scenarios/prov-007-opencode-adapter.test.ts`: **29 passed** at 09:39:11.

- `npm run check`: **PASS**, lint/typecheck, **41 files / 164 scenario tests** at 09:40:44 and **7 package tests** at 09:40:58. The earlier full run's three exact-event-shape failures were updated to assert the additive fields without dropping old expectations.

- GPT-5.6 Sol focused review: three blockers corrected, final **ACCEPT**, no remaining concrete correctness/security/compatibility blocker. Review was inspection only, not independent test execution.

- Local Qwen review on rebuilt Nodulus: run `c8744fe6-d71e-4d5f-bee1-148d8435f1b7`, **success/accept**, one call. Six events have sequence 1–6, matching IDs and linked accepted result. An earlier failed review preserved three calls and bounded repairs. This is Windows live boundary/timeline proof, not OBS-012 usage/cost acceptance.

- Reusable example: both `qwen-artifact` and `qwen-review` definitions completed through real application/storage/contract handling with a fake external provider. No live inference in that configuration check. Docs/skill updates are non-TDD documentation/configuration verification. Skill quick validator was unavailable because this Python lacks PyYAML; frontmatter and local links were checked directly instead.

Remaining: OBS-003–012, automatic token/cost extraction, incomplete-call classification, crash/telemetry-failure matrix, richer status and unattended artifact application. Hosted proof is separate from these local results; consult the implementation PR checks. Raw local prompts/transcripts and machine configuration are not committed.


Document verification: 13 changed/new Markdown files and 53 local links passed UTF-8/fence/link checks. Example JSON parsed and skill frontmatter passed direct validation. `git diff --check` passed.

## Checkpoint B completion: 2026-09-28

Base `9cca96b`, branch `codex/provider-usage-qwen`. User authorized OBS-003–005 with local Qwen, documentation-node work and the existing focused Sol review. See the [continuation report](qwen-execution-report.md), [hiccup history](qwen-hiccups.md), [B ledger](qwen-phase-b-ledger.json) and [fixture provenance](../../../tests/fixtures/observability/usage-provenance.v1.json).

- OBS-003 behavioral RED at 11:09:10 EDT: no telemetry on a successful default-adapter call. OBS-004 RED at 11:10:27: no optional-usage telemetry. All five initial OBS-003/004/005 cases RED at 11:13:24. Wrong draft imports/helper calls were excluded from RED.
- Five initial cases GREEN with lint/typecheck at 11:25:57; extended 16 cases GREEN at 11:27:28. Cases cover exact/unknown versions, nullable optional fields, duplicate/conflicting scoped identities, multi-turn/multi-step sums, missing completion, invalid string/fractional counters, overflow, preserved artifacts and single inference. A later seventeenth case verifies no inherited telemetry after readiness failure.
- DEV-001 sequence RED at 11:32:07; seven cases GREEN at 11:34:47. Documentation is before both reviews, both receive its artifact, rejection/empty files block downstream work, and the fixed final check remains enforced. The full six-node workflow uses a fake external provider with real project/validator processes; it is not live autonomous proof.
- Full suite initially caught two PROV-004 failures (usage:null compatibility). Fixed production projection, retained original assertions; twelve focused compatibility/Codex cases GREEN at 11:38:38.
- `npm run check` runtime-checkpoint PASS (before final docs edits): lint, typecheck, **44 scenario files / 183 tests** at 11:40:18; **7 archive/install tests** at 11:40:34. Windows Node 24.15.0. Local log: `.nodulus/phase-b/check-final.log` (not committed).
- GPT-5.6 Sol focused checkpoint B review ACCEPT, no blocker. Review was source/test inspection, not independent execution.
- Live Windows OpenCode 1.18.32 / Ollama 0.32.15: documentation runs `0d671e32-f1b7-4d5a-b828-64666a367a81`, `2fced891-b350-4199-b41b-bcae01ef7dcc`, and review `40e8cb8e-9812-459a-819d-72ce5fcaef3e` ran on rebuilt telemetry code. Saved telemetry matches unique raw step parts, call IDs and transport refs. Documentation drafts required coordinator corrections; review accepted supplied code/evidence without running tests itself.
- Documentation/skill edits and standalone example definitions follow the documented non-TDD exception: links/consistency/schema/application checks, not invented RED. The changed development sequence has behavioral RED/GREEN above.

OBS-006–012 remain pending: full process-failure/crash/telemetry-write isolation, resume aggregation, rich coverage status, reproducible pricing and expanded live/installed acceptance. No release was published. Existing package tests pass, but do not substitute for those future scenarios. Raw local configurations/transcripts remain untracked.

Final delta review: GPT-5.6 Sol ACCEPT for the legacy null projection, documentation sequencing/validator, review inputs and report attribution. No independent test execution by the reviewer. Standalone qwen-document definitions were exercised through the real application: allowed content succeeded, edits-only and out-of-scope paths failed, one boundary fixture call each. All three post-build live telemetry records matched their raw unique step parts and persisted call files.

Document verification: 20 changed/new Markdown files, 77 local links, JSON parsing and skill frontmatter passed. `git diff --check` passed. Hosted CI evidence follows separately; this local acceptance does not authorize merging or publishing.

Hosted packaging regression: [run 36446410656](https://github.com/Rogeriohsjr/nodulus/actions/runs/36446410656), revision `3ba7254`, passed all 183 runtime scenarios but failed PKG-002 on Windows/macOS/Linux: the new linked provider guide was excluded from package.json files. Local `npm run test:package` reproduced the same missing installed-file assertion at 11:51:05 EDT. Added that exact guide to the archive allowlist; no assertion was weakened. The earlier local package pass preceded the final documentation edits and was not final-artifact proof.

After the archive fix, full `npm run check` passed again with lint/typecheck, 183 scenarios and 7 package tests (package phase 11:52:14 EDT). The final committed guide is included. Final hosted status and exact revision/run links are recorded on [PR #12](https://github.com/Rogeriohsjr/nodulus/pull/12); the CI run above deliberately records the initial failure.

## 2026-09-29 OBS006A characterization

The obs-006-partial-provider-evidence.test.ts scenario now exercises a real OpenCode fixture emitting known usage then exiting 23. Reported counters and transport evidence survive with partial coverage; normalized totals and aggregate usage remain unknown, and two status reads do not infer again. This passes existing production code: no new RED or production implementation is claimed. See the [phase D report](../13-task-planning/qwen-recovery-report.md) for Qwen drafts, supervisor corrections and final validation. Parent OBS-006 remains unchecked; this does not cover timeout, truncation, output limits, readiness or killed-process status.

## Checkpoint C completion: 2026-09-30

On base `1f5ddba`, branch `codex/observability-completion`, missing launch classification and interrupted-call status assertions failed before implementation (`.nodulus/phase-f/lifecycle-red.txt` and `lifecycle-scaffold-red.txt`). Existing transport limits and counter validation passed characterization; no new RED is claimed for those behaviors.

`npm run check` passed on Windows Node 24.15.0: lint, typecheck, **260 scenarios and 9 installed-package tests** (`.nodulus/phase-f/obs-c-check.txt`). Real fixture processes cover timeout, truncation, output cap, prelaunch failure and killed-process read-only status. Invalid usage never retries a valid artifact. GPT-5.6 Sol accepted after a documentation-only scope correction. Hosted acceptance is separate and pending for this revision.

The [completion report](qwen-completion-report.md) records exact Qwen runs, supervisor fixes, tuning, failed attempts and improvement scenarios. The [lifecycle guide](obs-006-lifecycle.md) describes nullable launch evidence. OBS008–012 remain pending; no release or merge was performed.

## OBS-012 checkpoint A test review: 2026-10-08

Base: `2ae0153` (`codex/obs-012-live-provider-evidence`), Windows, Node v24.15.0. Work is frozen at the test-review checkpoint; no collector behavior beyond the faithful existing-field extraction is implemented. No live provider, install, authentication, commit, or push was performed.

- Behavior-preserving baseline: `npm run build` then `npx vitest run tests/scenarios/obs-012-live-evidence.test.ts` passed, 1 test. The real OpenCode fixture runs through `runDefaultProviderCli`, production adapter and status; the extracted collector emits the prior schemaVersion/packageVersion/archiveSha256/runId/callId/model/optional endpointOrigin/cliVersion/coverage/reported/normalized keys.
- Expanded behavioral RED: same build and focused command after adding OBS-012 assertions failed, 6 tests. The positive case fails because `os` and `nodeVersion` are absent. Five negative cases show no throw for tampered telemetry and missing/invalid validation or result records. These are collector-behavior failures, not setup failures.
- The frozen scenario also asserts call-relative paths for request/stdin/transport/telemetry and prompt/response/validation/result; fixture-captured stdin equality; valid validation and successful expected artifact; persisted telemetry equality; and evidence JSON exclusion of the unique request sentinel, raw transport stdout, profile credential sentinel and diagnostics.
- This is offline fixture evidence only. The already recorded live Windows OpenCode/Ollama cell is unchanged; all other provider/platform cells remain pending.

### OBS-012 checkpoint A test-review correction 1: 2026-10-08

The initial review requested a stricter frozen test contract. The live OpenCode path now passes the installed CLI's existing `statusEnvelope.result` directly to the collector; it no longer performs an additional repository `getRunStatus` read. The offline scenario exact allowlist now requires provider, nullable reportedModel, platform/architecture/OS release, Node version and all eight relative references. Requested model metadata accepts null for future unknown-model cells.

- Corrected focused run: `npm run build` passed; `npx vitest run tests/scenarios/obs-012-live-evidence.test.ts` produced **8 failed, 1 passed**. The positive test fails because the extracted baseline collector lacks the required provider/model/OS/Node/refs fields. Seven negative cases fail because it accepts telemetry tampering, missing/invalid validation/result, and request.json references escaping the run root or using an absolute path.
- The unavailable-usage case passes: a real Cursor fixture reports unavailable coverage and all-null counters, and collection succeeds. The positive scenario hashes the run tree around collection to assert read-only behavior when the positive assertions reach that check.
- Baseline extraction's original 1-test GREEN remains historical evidence above. No new collector behavior has been implemented; this checkpoint remains frozen for review. No provider was invoked live and no package was installed.

### OBS-012 checkpoint A test-review correction 2: collection read-only snapshot ordering

Moved the run-tree hash snapshot to immediately before `collectLiveEvidence`; the unchanged post-collection hash comparison now brackets the collector call directly. No other scenario, helper, or behavior changes were made.

- Validation: `npm run build` passed; `npx vitest run tests/scenarios/obs-012-live-evidence.test.ts` produced **8 failed, 1 passed**. The positive test reaches the expected RED at missing provider/nullable model/OS/Node/reference evidence. The seven integrity-negative cases remain RED because the baseline collector accepts tampered telemetry, missing/invalid validation/result, and escaped/absolute request references. The unavailable-usage case passes with null counters and successful collection.
- The pre-collection run-tree snapshot and post-collection comparison now directly prove read-only behavior once the positive metadata assertions pass. No collector implementation was added. `git diff --check` passed.

## OBS-012 checkpoint A collector implementation: local GREEN

Implemented the accepted frozen contract in `tests/support/live-provider-observability.ts`; the frozen scenario at SHA-256 `6AA0FCEC08D3ACB2B1BAD21E5F28C6D936EFEFA306BE3E1BEB657FB60E71614D` is unchanged. The collector reads only the selected run's real files, checks request/run/call/provider identity and exact safe relative refs, rejects path escape/absolute refs, requires successful transport, matches persisted telemetry against status, and requires valid saved validation plus a successful nonempty result. The emitted evidence contains the allowlisted provider/model/version/OS fields and relative refs; it excludes raw prompt, response, transport, profile data and diagnostics. The installed OpenCode harness hands the CLI status result into the same collector.

- `npm run build`: **PASS**.
- `npx vitest run tests/scenarios/obs-012-live-evidence.test.ts`: **PASS, 9 tests**. This includes unavailable optional usage with null counters, exact captured stdin, evidence redaction/allowlist, read-only run-tree hash, and rejection of telemetry tampering, missing/invalid validation/result, and escaped/absolute request refs.
- `npm run lint`: **PASS**, zero warnings.
- `npm run typecheck`: **PASS**.
- `git diff --check`: **PASS**.

Windows, Node v24.15.0. Offline provider fixtures only; no live provider, package install, or full quality gate was run. This is the implementation checkpoint awaiting focused Sol review.

## OBS-012 checkpoint B installed-smoke harness: local validation

Added a shared installed-archive provider smoke path for Codex, Cursor, and OpenCode/Ollama. It sequentially builds, packs, installs into a temporary prefix, initializes a fresh project, configures a tiny artifact-only request, runs/statuses the installed Nodulus CLI, validates the exact saved artifact and captured call evidence, and optionally writes only the collector's sanitized allowlist. Codex uses an initialized isolated Git repository, read-only sandbox, low reasoning effort and no extra capabilities. OpenCode preserves the loopback-only Ollama configuration, exact model/small_model, Ollama-only enablement, denied tools and disabled compaction. Cursor model and all provider reported-model/usage fields may remain null.

- `npx vitest run tests/scenarios/obs-012-live-evidence.test.ts`: **9 passed**; frozen test SHA-256 remains `6AA0FCEC08D3ACB2B1BAD21E5F28C6D936EFEFA306BE3E1BEB657FB60E71614D`.
- `npm run test:live:codex`, `npm run test:live:cursor`, `npm run test:live:opencode`: each **1 skipped** with opt-in unset. No live CLI was invoked.
- `npm run check`: **PASS**; lint, typecheck, **74 scenario files / 321 tests**, installed archive **10 tests**. The build/package phases ran sequentially.
- Changed Markdown local-link check: **PASS**, 4 files. `git diff --check`: **PASS**.

Windows, Node v24.15.0. This validates harness wiring and offline gates, not live provider compatibility. No additional OBS-012 matrix cell is claimed. The earlier Windows OpenCode/Ollama PASS remains the sole recorded live cell. Current provider readiness (standalone Codex 0.156.1, Cursor 2026.09.23-86fc751, OpenCode 1.18.32/Ollama 0.35.0/model available) is not inference proof. No live provider, authenticated session, or explicit-opt-in archive installation occurred. Ready for focused Sol review.

### OBS-012 harness correction 1: enabled-path setup failure reproduced

Before changing the harness, the persistent PKG-010 enabled-path test was run with local child-process fixtures and no live provider. Command: npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t PKG-010. It failed in runInstalledProviderSmoke with initialized settings must be an object. The helper supplied UTF-8 JSON text directly to its object validator instead of parsing it. The failure occurred before the configured fixture provider executable was called. This is a harness setup failure, not a live-provider or Nodulus runtime behavioral RED; no usage, authentication, or provider compatibility conclusion is drawn.

Enabled local-fixture rerun after parsing correction advanced beyond initialization and invoked the installed CLI with the real Codex child fixture. It failed the harness assertion that captured stdin contain the known request: the initializer's starter node has inputs empty, so the CLI did not map --request into provider stdin. This is an enabled-path fixture setup gap, not live Codex evidence or a Nodulus runtime regression; only the scripted local provider boundary was invoked.

### OBS-012 harness correction 2 test-review checkpoint: fixture evidence overwrite

Added PKG-011 with a real marker file and the actual NODULUS_LIVE_EVIDENCE environment variable, saving and restoring its prior value around an enabled offline fixture run. Before changing the helper, command npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t PKG-011 failed because the local Codex fixture overwrote the marker with generated evidence JSON. The subprocess was the scripted local fixture, not a live provider. This is a harness separation/data-preservation defect, not product behavioral RED. The helper implementation remains unchanged at this checkpoint.

The scenarios now state that all provider smokes send a tiny artifact-only request; only Codex applies Nodulus's read-only sandbox. Cursor relies on the request and does not receive a Codex sandbox policy; OpenCode separately denies tools in its configured project.

### OBS-012 harness correction 2: explicit evidence destination accepted

Sol accepted the PKG-011 marker-overwrite failure as the focused RED. The helper now accepts an optional explicit evidencePath and never reads NODULUS_LIVE_EVIDENCE itself. Only the three opt-in live tests pass process.env.NODULUS_LIVE_EVIDENCE; offline archive fixtures omit the destination. PKG-011 sets the actual environment variable while preserving a pre-existing marker and verifies the file remains byte-for-byte unchanged after the local fixture run.

The correction-1 setup failures above were observed and corrected before the reviewer requested a frozen test checkpoint; their actual ordering is retained here. They were not presented as accepted behavioral REDs. No frozen OBS-012 collector scenario was changed.

- Sol accepted PKG-011 RED; `tests/scenarios/pkg-001-installed-archive.test.ts` SHA-256 is `4CFE77EF94F9395248F22ABD29F78DB4B694A184E1882258B5186483233CA4ED`.
- `npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t 'PKG-010|PKG-011'`: **2 passed, 10 skipped**. The three sequential local child-process provider fixtures pass; the evidence marker stays unchanged; invalid executable errors are bounded and sanitized.
- `npm run test:live:codex`, `npm run test:live:cursor`, `npm run test:live:opencode`: each **1 skipped** with opt-in unset; no provider was called.
- Final `npm run check`: **PASS**; lint and typecheck passed, **74 scenario files / 321 tests**, installed archive **12 tests**. Build and package phases ran sequentially.
- Changed Markdown local-link check: **PASS**; `git diff --check`: **PASS**.

Windows, Node v24.15.0. These are local fixture and repository checks, not live provider evidence. No live provider, package installation for a live smoke, authentication, commit, or push occurred. Ready for final focused Sol code review.

## OBS-012 failure-diagnostics fixture checkpoint: RED

Added installed-archive regression cases for a local Codex-protocol child process that exits 23 while writing credential/prompt markers to stderr and stdin, and for a configured executable that does not exist. Both pass an explicit diagnosticPath and require a fixed-schema classification with stage, CLI exit code, envelope status/error code, run/call/request/transport availability and timeout/output-limit fields. Exact object assertions also ensure that stdout/stderr, prompt, credential, executable path, and other diagnostics are not serialized.

- `npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t 'PKG-012|PKG-013'`: **2 failed, 12 skipped**. Both cases reach the intended assertion after the installed run throws: the requested diagnostic file does not exist (`ENOENT` while opening `provider failure diagnostic.json` and `prelaunch failure diagnostic.json`). The current harness discards the run's stdout and removes its scratch project, so it cannot classify either failure or retain safe run evidence. This is the observed RED; no implementation changes have been made.
- Frozen OBS-012 collector contract remains unchanged at SHA-256 `6AA0FCEC08D3ACB2B1BAD21E5F28C6D936EFEFA306BE3E1BEB657FB60E71614D`.

Local fixture subprocesses only; no live providers were invoked. Stop for focused test review before implementing diagnostics.

### OBS-012 diagnostics checkpoint correction: prelaunch request availability

Sol's RED review identified that PKG-013's missing Codex executable fails the adapter's version probe before the provider request capture exists. Corrected only the expected `requestAvailable` value from true to false; `callLaunched` and `transportAvailable` remain false. PKG-012 remains unchanged.

- Focused rerun: `npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t 'PKG-012|PKG-013'`: **2 failed, 12 skipped**, both at the intended missing diagnostic JSON assertion. The failure-diagnostics behavior remains unimplemented.
- Frozen OBS-012 collector test remains unchanged at SHA-256 `6AA0FCEC08D3ACB2B1BAD21E5F28C6D936EFEFA306BE3E1BEB657FB60E71614D`.

## OBS-012 failure diagnostics: local implementation and live evidence update

Implemented the accepted failure-diagnostics contract in the installed-archive helper. It captures the installed CLI's bounded exit status and machine envelope, and when a safe run ID is present asks the installed CLI for status before cleanup. It uses the status call ID only after validating it, then checks request/transport availability and reads only the owned call's transport status fields. Parse failures become missing/null fields without surfacing JSON contents. Optional JSON is written only to the caller's explicit `diagnosticPath`; the helper does not read environment variables. Each opt-in live caller derives a separate `.failure.json` path only when the sanitized success evidence path is configured. Provider stderr, stdout, prompt, credentials, profile, command arguments, paths and envelope messages are never exported. `PROVIDER_FAILURE` is a generic workflow classification and is not evidence of a specific vendor cause.

- `npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t 'PKG-010|PKG-011|PKG-012|PKG-013'`: **4 passed, 10 skipped**. The local provider exit-23 case reports transport exit 23 and includes no fixture credential/prompt markers or executable path; the missing-executable case reports no request or transport capture; earlier successful fixture and evidence-marker cases remain green.
- Live evidence reported by the coordinator from Windows 10.0.26300 x64, Node v24.15.0: OpenCode 1.18.32 with Ollama 0.35.0 and requested `ollama/qwen3.5:9b` passed **1/1** (26.86s). Archive version 1.0.0, SHA-256 `fa192de85143d3bc49699ab24bac3f74a9a42b519e8d08e7cd74344ee052bcb6`; run `6b88cad7-ab57-47ec-ae31-265bf6d538d1`; call `378525c0-6391-4ae9-aefc-d04429546c85`; coverage complete, input 502, output 193, cache read 0, reasoning 0, provider cost 0; reported model null. Evidence file: `.nodulus/pilot/obs-012-2026-10-08/opencode.json`. Captures and results were checked before temporary cleanup; relative references do not mean raw capture files were retained.
- The same Windows live attempts failed for Codex standalone 0.156.1 (1/1, 8.35s) and Cursor 2026.09.23-86fc751 (1/1, 42.57s), both installed run exit 1 with prior harness classification `cause unknown`; these are failures, not compatibility passes. The new safe diagnostic fixture contract addresses the lost classification on future explicitly authorized attempts; this task performed no live retry.
- macOS and Linux live compatibility remain pending. Three-OS fixture CI is separate evidence and is not live-provider proof.
- `npm run lint` and `npm run typecheck`: **PASS**. Final `npm run check`: **PASS**; 74 scenario files / 321 tests passed, then installed archive **14 tests passed**. Build and package test stages ran sequentially.
- Changed Markdown local-link check: **PASS**, 4 files. `git diff --check`: **PASS**.

No live provider was called in this diagnostics implementation task. Previously reported live attempts above are retained as separate facts, not rerun or upgraded by the local fixture suite. Ready for focused Sol implementation review.

### OBS-012 diagnostics classifier sanitization: focused test-review RED

Extracted the existing diagnostic mapping into `classifyInstalledFailure` so its output contract can be checked using a real temporary envelope JSON file and the real classifier, without a fake Nodulus executable or mocked APIs. PKG-014 provides a valid JSON envelope with an unrecognized status sentinel and a private message sentinel, with no status observation. It requires unknown statuses and unobserved launch/request/transport/timeout/limit facts to remain null and excludes both sentinels.

- `npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t PKG-014`: **1 failed, 14 skipped**. The focused assertion shows the current classifier echoes the unknown status sentinel and reports missing call/request/transport/timeout/limit observations as false. This is a diagnostics-helper contract RED only; it does not demonstrate Nodulus runtime or live-provider behavior. No behavior fix has been applied after this result.
- The accepted PKG-012/013 test bodies and frozen collector test are unchanged. No live provider was called.

### OBS-012 diagnostics classifier correction 1: local GREEN

Restricted envelope status to the three recognized CLI values. Launch status is emitted only from an observed boolean metric. Request and transport availability are null until a valid status call ID identifies a call directory within a real run tree contained by the project; existing request/transport paths are checked after realpath containment. Transport timeout and output-limit values are emitted only from validated boolean fields. Malformed or unavailable status/transport JSON remains unobserved without exposing its contents.

- `npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t 'PKG-010|PKG-011|PKG-012|PKG-013|PKG-014'`: **5 passed, 10 skipped**. Existing successful/offline-preservation and provider-exit/missing-executable classification tests remain green; PKG-014 now confirms an unknown status and unavailable observations are null and sentinel values are not emitted.
- Frozen collector scenario remains SHA-256 `6AA0FCEC08D3ACB2B1BAD21E5F28C6D936EFEFA306BE3E1BEB657FB60E71614D`; frozen package scenario test checkpoint `1678C408BB30696E6E58E367D8B1DC7AD4570231BEC3A0A4C0026440E60DE323` is unchanged.
- `npm run check`: **PASS** after source and documentation edits; lint, typecheck, 74 scenario files / 321 tests, then installed archive **15 tests**. Changed Markdown local-link check: **PASS**, 4 files; `git diff --check`: **PASS**.

No live providers were invoked. Ready for final focused Sol implementation review.

### OBS-012 diagnostics declaration correction 2: typed harness validation

Declared the optional `diagnosticPath` property used by the installed smoke helper and its three opt-in callers. A focused TypeScript check also exposed five pre-existing helper typing issues that the repository's source-only `npm run typecheck` does not compile: cross-spawn `Error.code` access and an optional metric call ID used as a path. Replaced those with a guarded unknown-property reader and required call-ID validation; no rules or compiler configuration were changed.

- `npm run lint`: **PASS**.
- `npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t 'PKG-010|PKG-011|PKG-012|PKG-013|PKG-014'`: **5 passed, 10 skipped**.
- `.\node_modules\.bin\tsc.cmd --ignoreConfig --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2023 --types node tests/support/live-provider-observability.ts tests/live/codex-observability.live.test.ts tests/live/cursor-adapter.live.test.ts tests/live/opencode-observability.live.test.ts`: **PASS**.
- Final `npm run check` after source and documentation edits: **PASS**; lint, source typecheck, 74 scenario files / 321 tests, then installed archive **15 tests**. Markdown local links: **PASS**, 4 files. `git diff --check`: **PASS**.

Ready for final focused Sol review. No live providers were invoked; no commit or push was made.

## OBS-012 outcome protocol regression: frozen RED checkpoint

Added `tests/scenarios/obs-012-outcome-protocol.test.ts` for Codex, Cursor, and OpenCode through the real `createProviderScenario` and `runDefaultProviderCli` path. The named-outputs fixture always returns the same valid fixed response with `primary` and `secondary` artifacts, both using `example.v1`; it does not inspect or condition its answer on the prompt. The scenario configures both expected outputs in the real node file, verifies one launched provider call and successful transport, checks the CLI's accepted artifacts plus saved valid validation/result and both persisted artifacts, then inspects the saved prompt and effective captured stdin for the exact output name/contract pairs and package schemas for all three outcome types. Ajv assertions exercise valid and invalid samples using the parsed schemas.

- `npm run build`: **PASS**.
- `npx vitest run tests/scenarios/obs-012-outcome-protocol.test.ts`: **3 failed**, one for each provider. Setup, provider fixture invocation, protocol response, success transport, artifact validation and persistence assertions passed; each case then fails at the intended assertion because `prompt.md` lacks `## Expected output names and contracts`. No syntax/import/setup failure occurred. The later schema and Ajv assertions are frozen in the test but were not reached because the required prompt section is absent.
- This is a production prompt-contract RED. The fixture deliberately returns the correct fixed two-output response independent of prompt contents; the test does not claim that this defect caused any previous live response loss.

Only the support fixture and new scenario test changed for this checkpoint; `src/core/execute-workflow.ts` is untouched. No live providers were invoked. Stop for Sol test review before implementation.

### OBS-012 outcome protocol test-review correction 1

Corrected the schema sample to validate the saved attempt result object, which includes the `success` status required by the outcome schema. Changed the fixture instruction to neutral wording that does not name expected output artifacts or reveal their contracts. The fixed provider response remains unconditional and prompt-independent.

- `npm run build`: **PASS**.
- `npx vitest run tests/scenarios/obs-012-outcome-protocol.test.ts`: **3 failed**, one for each provider, at the same intended missing `## Expected output names and contracts` section. All run acceptance, successful transport, valid saved validation/result, and artifact persistence assertions before that checkpoint pass. The Ajv sample assertions occur after the missing section assertion and were not reached in RED.
- `src/core/execute-workflow.ts` remains untouched. No live providers were invoked. This is the corrected frozen test checkpoint for Sol review.

### OBS-012 outcome protocol implementation: local GREEN

`buildPrompt` now includes the exact expected name/contract pair list separately from contract-keyed schemas, preserving multiple outputs that share one contract. It also serializes the existing package-owned success, needs-input, and error schemas in a provider-neutral prompt section. Runtime outcome parsing and artifact/script validation remain authoritative and unchanged; no provider adapter or transport envelope changed.

- `npm run build`: **PASS**.
- `npx vitest run tests/scenarios/obs-012-outcome-protocol.test.ts`: **3 passed** for Codex, Cursor, and OpenCode. Each verifies one successful real fixture call, successful transport, both persisted artifacts, saved valid validation/result, exact expected pair records, inclusion in effective stdin, and real Ajv acceptance/rejection samples for all three serialized outcome schemas.
- The scenario's first strict TypeScript check exposed an incorrect default Ajv import. Corrected it to the repository's named `Ajv2020` export. This is a static typing finding, not behavioral RED. Focused command `.\node_modules\.bin\tsc.cmd --ignoreConfig --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2023 --types node tests/scenarios/obs-012-outcome-protocol.test.ts`: **PASS** after correction.
- `npm run check`: **PASS** after source and documentation edits; lint, source typecheck, 75 scenario files / 324 tests, then installed archive **15 tests**. No live-provider call was made.

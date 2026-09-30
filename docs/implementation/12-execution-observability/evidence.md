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
| B / OBS-003,004,005 | Pending | Pending | Pending | Not started |
| C / OBS-006,007 | Pending | Pending | Pending | Not started |
| D / OBS-008,009 | Pending | Pending | Pending | Not started |
| E / OBS-010 | Pending | Pending | Pending | Not started |
| F / OBS-011 | Pending | Pending | Pending | Not started |

For every row record actual test names, exact commands, the meaningful failing assertion, passing result, source revision, OS/Node version and unresolved limitations. Record lint/typecheck/full check at the appropriate checkpoints. Never replace a pending entry with an expected result from scenarios.md.

## Future live compatibility: OBS-012

| Provider | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Codex | Pending | Pending | Pending |
| Cursor | Pending | Pending | Pending |
| OpenCode/Ollama | Pending | Pending | Pending |

Prior provider invocation proof in folders 10/11 does not establish this slice's telemetry, cost or exact-input capture. For each future cell, record explicit authorization, CLI/model/Nodulus versions, fixture-GREEN prerequisite, command/result, sanitized evidence references and observed completeness. Unsupported usage remains an accepted limitation, not a fabricated measurement. Actual billing reconciliation remains out of scope.



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

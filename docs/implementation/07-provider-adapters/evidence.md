# Evidence: 07-provider-adapters

Status: accepted locally on Windows after independent Sol review; live provider compatibility remains unverified.

## Environment

- OS and Node/npm: Windows, Node 24.15.0 / npm local runtime
- Owner/date: builder / 2026-09-24
- No commit, publish, credential change, live provider call, or folder 08 work was performed.

## Scenario evidence

| Scenario | Test file | RED evidence | GREEN evidence | Remaining proof |
| --- | --- | --- | --- | --- |
| PROV-001 | `tests/scenarios/prov-001-protocol-translation.test.ts` | Before adapter implementation, the default production CLI returned exit 1 with `No provider adapter is configured for this application run.` and produced no fixture invocation. | `npx vitest run tests/scenarios/prov-001-protocol-translation.test.ts`: 2 passed. Both default CLI adapters invoke real temporary executable fixtures, normalize the provider transport, and preserve kind/options without credentials in captured definitions. | Fixtures model documented transports; they do not establish live provider compatibility. |
| PROV-002 | `tests/scenarios/prov-002-provider-readiness.test.ts` | Before adapter implementation, the default CLI could not probe auth or version and returned the same provider-unavailable failure. | In the focused run, 7 tests passed: Codex/Cursor auth failures and version failures stop before inference; explicit kind is required only for default adapters; injected generic providers remain supported; doctor still identifies disabled/missing executables without invoking them. | Codex's 0.144.4 floor is anchored to locally inspected help. Cursor fixtures use simulated version strings; no Cursor minimum is claimed. Doctor's existing check is executable availability; provider auth/version probes occur before run/resume. |
| PROV-003 | `tests/scenarios/prov-003-portable-invocation.test.ts` | Before adapter implementation, long-context fixtures were never invoked by the default CLI. | 2 passed. Real Windows `.cmd` fixtures run through `cross-spawn`; tests preserve Unicode, spaces, `&`, `%`, and long prompt content through Codex stdin and Cursor's captured UTF-8 prompt file. | Windows/macOS/Linux live provider installations were not tested. |
| PROV-004 | `tests/scenarios/prov-004-capability-and-usage.test.ts` | Before adapter implementation, malformed responses could not reach the runtime's repair-capability behavior. | 4 passed. Unknown usage/cost stays null; invalid provider output with empty capabilities ends as `RESPONSE_REPAIR_UNAVAILABLE` after exactly one inference invocation. | Neither adapter currently advertises response-only repair; no usage fields are inferred. |

### Focused review corrections

- Attempt isolation RED: a real same-node pause/resume through each default adapter could not find `provider/<node>/attempt-001/transport.json`; the adapter stored only one node-level diagnostics path. After adding the invocation attempt to the provider boundary and storing prompt/schema/transport/output under attempt-specific directories, the Codex and Cursor resume cases both pass and retain both attempts.
- UTF-8 RED: a Cursor fixture wrote a JSON result one byte at a time; the previous per-chunk UTF-8 decoding returned replacement characters for `Ω 🦊`. The runner now aggregates bounded byte chunks before decoding. The byte-split Unicode case passes.

The test-only RED checkpoint ran all four PROV files with 2 existing green cases and 13 expected default-adapter failures (15 tests total). The accumulated suite at that checkpoint was 86 passed and 13 failed (99 total); those 13 failures were the four new scenario files' missing-default-adapter behavior. These commands exercised temporary local provider fixtures only.

## Final validation

- `npm run typecheck`: passed.
- `npm run build`: passed.
- Focused PROV suite after review corrections: 4 files passed, 18 tests passed.
- `npm run test:scenarios`: 35 files passed, 102 tests passed.
- Live login, inference, and compatibility: not run.

## Implementation notes and limits

- The default CLI composition selects explicit `kind: "codex" | "cursor"`; captured safe profile data now retains `kind` but excludes credentials. Injected generic providers remain kind-free.
- `cross-spawn` receives executable and argument arrays. The process runner uses a bounded timeout, output cap, process-tree termination, and preserves inference stdout/stderr in `.nodulus/runs/<runId>/provider/<nodeId>/attempt-N/transport.json`.
- Codex transport uses locally inspected `codex-cli 0.144.4` flags: JSONL mode, stdin prompt, output-last-message file, requested schema file, project cwd, model option, and ephemeral mode. The version check rejects versions below 0.144.4. It does not enable bypass/full-auto permissions.
- Cursor transport uses JSON print mode, project workspace, optional model, and a short prompt referencing a captured UTF-8 prompt file. Its status probe relies only on process exit; it does not parse undocumented authentication JSON fields. Cursor version parsing rejects unparseable versions but has no asserted minimum.
- Adapter tests emulate the provider process protocol with scripts; they are not live compatibility evidence. Source citations and provider research are in [provider-research.md](../../provider-research.md).
- Usage remains null when no trusted telemetry is reported; concrete adapters do not implement response-only correction, preventing action replay.

Independent Sol correction review passed 7 focused cases and accepted implementation. Builder final full suite passed 102 tests; focused provider suite passed 18. Folder 08 is next.

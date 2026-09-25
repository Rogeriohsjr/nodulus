# Evidence: 07-provider-adapters

Checkpoint history: counts and remaining work below describe this slice at acceptance time. See the [current implementation status](../README.md) and [hosted validation](../09-ci-release/evidence.md#final-code-checkpoint-verification) for later completion.

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

### OpenCode nested-event correction (2026-09-24)

- RED: `npm run build; npx vitest run tests/scenarios/prov-007-opencode-adapter.test.ts` built successfully and ran 17 tests with three behavioral failures: final nested text selection and reasoning-only fallback both exited 1 instead of 0, and a nested invalid outcome returned `PROVIDER_RESPONSE_MISSING` instead of `RESPONSE_REPAIR_UNAVAILABLE`.
- GREEN: the same command built successfully and passed all 17 tests after the OpenCode adapter added `--thinking` and selected only nested parts correlated to the final `step_finish` with reason `stop`. The fixture proves text wins over a schema-valid same-message reasoning outcome, ignores an earlier text outcome ending in `tool-calls`, and uses final-message reasoning only if text is absent.
- Quality gate: `npm run check` was run twice. Lint, typecheck and build passed both times; the scenario suite consistently stopped at 142 passed / 3 failed because the existing `NODE-003 distinguishes validator timeout` and two `SAFE-003` validator timeout/cancellation tests exceeded Vitest's 5-second test timeout. Package tests did not start. No timeout thresholds or unrelated tests were changed.

### OpenCode complete-outcome transport suffix RED (2026-09-24)

- Test-only RED: `npm run build` passed, then `npx vitest run tests/scenarios/prov-007-opencode-adapter.test.ts` ran 17 tests with one relevant failure and 16 passes. The real executable fixture captured stdin equal to the persisted complete Nodulus prompt, but it lacked the required final adapter-owned instruction to return one complete system-outcome JSON object, reject artifact `data` alone and file output, and show the success shape with `status`, `artifacts`, `name`, `contract`, and `data`.
- The new assertion requires stdin to equal the original persisted prompt verbatim, followed by two newlines and the exact transport suffix. It also confirms the user request remains in stdin and out of the argument array. Production adapter behavior remains unmodified pending implementation; no permissive output wrapping was added.

### OpenCode complete-outcome transport suffix GREEN (2026-09-24)

- `npm run build` passed, then `npx vitest run tests/scenarios/prov-007-opencode-adapter.test.ts` passed all 17 tests. OpenCode alone now appends the tested adapter-owned suffix after the complete persisted Nodulus prompt, using stdin and the existing argument array.
- The suffix requires exactly one complete system-outcome JSON object as the final assistant response, rejects returning artifact `data` alone or writing the outcome to a file, and supplies the concrete success shape while deferring actual names/contracts to the node prompt. The existing parser, strict core validation, no-replay behavior, and Codex/Cursor transports remain unchanged.

### OpenCode response-only repair GREEN (2026-09-24)

- Accepted RED: `npm run build; npx vitest run tests/scenarios/prov-007-opencode-adapter.test.ts` had 17 passing tests and three intended behavioral failures because OpenCode did not expose a response-repair adapter hook.
- GREEN: `npm run build; npx vitest run tests/scenarios/prov-007-opencode-adapter.test.ts` passed all 20 tests. A malformed build response with its final-message session ID now makes one or two same-session `nodulus-response` corrections without replaying the build invocation. The fixture proves final stopped-message text wins over reasoning and earlier-message distractors for repair responses, and verifies separate `repair-001`/`repair-002` transports. Live evidence showed that the built-in plan agent injects planning instructions into the correction session; the example therefore defines `nodulus-response` with every tool denied and a JSON-only system prompt.
- Failure evidence: the repair-process fixture exits 24 with identifiable stdout/stderr; its `repair-001/transport.json` retains both streams while the original attempt transport remains intact. A missing session remains an actionable repair failure without a new build action.
- Related capability check: `npx vitest run tests/scenarios/prov-004-capability-and-usage.test.ts` passed all 5 tests.
- Final local quality gate: `npm run check` passed lint, typecheck and build, then stopped in the scenario suite at 146 passed / 3 failed because the existing validator-timeout cases `NODE-003 distinguishes validator timeout` and two `SAFE-003` cases exceeded Vitest's five-second test timeout. Package tests did not start; this is not a full quality-gate pass or live-provider proof.

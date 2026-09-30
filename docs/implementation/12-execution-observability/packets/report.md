# Local Qwen task-packet experiment — 2026-09-28

## Outcome

Created a reusable [planning skill](../../../../.agents/skills/nodulus-task-packets/SKILL.md), [packet template](../../../../.agents/skills/nodulus-task-packets/references/packet-template.md), and small `packet-test` / `packet-implement` workflow examples. Ran two product-test assignments and one separately budgeted disposable editing probe through installed Nodulus against local Qwen. Neither product assignment produced accepted behavioral RED. The probe changed its scratch file, but timed out before completing its protocol. No product implementation was dispatched or accepted; OBS-001 and its parent checkboxes remain incomplete.

Decomposition made the failure easier to diagnose, but this experiment does **not** show that specificity alone makes Qwen 3.5 9B a reliable autonomous developer. The correction gave exact helper calls, path construction, assertions and commands; the model read the file and ended before performing the edit.

The coordinator authored planning/setup/docs, inspected files and independent validator evidence, and quarantined rejected output. Qwen authored the rejected test. GPT-5.6 Sol reviews setup and findings only. No cloud builder fallback, merge, release or npm publish occurred.

## Environment and local routing

- Windows worktree `opencode-workflow/nodulus`; starting revision `961f882`; branch `codex/qwen-task-packets`.
- Installed Nodulus reported `2.1.0-dev.5`; OpenCode reported `1.18.32`.
- Local OpenCode provider: `ollama`, model `qwen3.5:9b`, base URL `http://127.0.0.1:11434/v1`.
- Local Ollama `/api/ps` confirmed that model loaded, Q4_K_M, 65,536 context. OpenCode exports for all three actual sessions identify `ollama/qwen3.5:9b` on every assistant message.
- Repair uses the same captured session with the tool-denied `nodulus-response` agent. No action replay was requested for envelope correction.

This verifies the builder routing for these calls. Coordinator and Sol account usage is separate and not measured by this ledger. Local inference consumes compute even when vendor-reported monetary cost is zero.

## Attempt ledger

| Observation | P01a initial | P01b one allowed correction |
| --- | --- | --- |
| Run ID | `a9107926-62a4-4e8f-bff1-499f3a279ad9` | `e2178866-8c6e-4bd3-9911-66d404bfd92f` |
| OpenCode session | `ses_f1811ea44ffevBermA83GnlhTT` | `ses_f180f01a0ffegiloHqiVQac1pd` |
| Request size | 434 words / 3,304 bytes | 190 words / 1,490 bytes |
| Saved assembled Nodulus prompt | 5,013 bytes | 3,208 bytes |
| Nodulus calls | 1 primary + 1 envelope repair | 1 primary + 1 envelope repair |
| Recorded call elapsed | 114,627 + 11,756 ms | 66,592 + 8,843 ms |
| OpenCode assistant messages | 30 | 3 |
| Tool parts | 29 (28 completed, 1 denied) | 1 completed read |
| Provider-reported input tokens | 688,544 | 18,896 |
| Provider-reported output tokens | 6,582 | 992 |
| Provider-reported cost | 0 | 0 |
| Actual result | Harness failure; RED gate rejected | No edit; repaired outcome `PACKET_BLOCKED` |

Usage comes from `opencode export <session-id>`, summed once per unique assistant message ID across the whole session, including repair. Do not also add step-finish usage or count the same session twice. These are provider-reported aggregates across repeated agent context, **not unique input size**, normalized Nodulus usage or a billing statement. Both sessions reported reasoning tokens as zero; this is not proof that no internal reasoning occurred. Nodulus `metrics.json` currently records `usage: null`, so these metrics required manual export. A small request can still produce many model/tool turns: four outer Nodulus calls here represent 33 OpenCode assistant messages, 707,440 reported input tokens and 7,574 output tokens.

P01a incorrectly assigned `call.stdin` (captured text) to a pathname and threw `Error: stdin.txt does not exist - harness bug`. It did not implement the requested startup observation fixture. Vitest reported one failed test, but this was not the required assertion failure. The model's outcome claimed an equality assertion that was absent from the file. One command used a mistyped `worktries` absolute path and was denied by the external-directory rule; this was not evidence that the allowed test path could not be edited. Qwen also created an unassigned root `test-output.txt` file, so prompt-level file scoping did not hold completely.

P01b deliberately narrowed coverage to post-call persistence/content using the existing fixture. It explained that `call.stdin` is content, gave the run directory recipe and specified the expected existence assertion RED. The trace contains one successful file read, then final prose announcing an edit. No editing tool or test command followed. Response-only repair correctly could not perform the missing work and returned a blocked outcome. No write-permission denial is present in this run. The exact cause of premature termination is unresolved; calling it only an ambiguous specification would exceed the evidence.

### Separate edit-capability probe

After closing P01, the coordinator defined a separate hypothesis: can this route perform one explicit edit and finish its protocol on a disposable file? Budget: one primary call, zero task corrections, envelope repair disabled, 60-second provider timeout. The coordinator created `.nodulus/pilot/edit-probe-2026-09-28/value.txt` containing `TODO` and a fixed Node assertion expecting `READY`. The assertion failed before dispatch. This is a diagnostic fixture, not a product scenario test.

- Run `03ca4e90-53da-46eb-ad07-74ba2744053f`; session `ses_f18072b6cffeOG1xNYnC3DjIpp`.
- Nodulus recorded 62,673 ms elapsed and `PROVIDER_TIMEOUT`; zero completed nodes, no retry/repair. The elapsed time includes invocation/termination overhead, so the configured timeout is not an exact total-duration guarantee.
- Export: five assistant messages, four tool parts (read, failed edit, extra shell read, successful edit), 32,460 reported input tokens, 524 reported output tokens, zero reported cost. These interrupted-session figures may omit usage for unfinished generation.
- The first edit incorrectly included the read tool's display footer `(End of file - total 1 lines)` in the search text. It then recovered with another read/edit, contrary to the requested single-edit/no-extra-command budget. It never invoked the assigned assertion command or produced an accepted success artifact before timeout.
- Independent coordinator assertion passed afterward. Scratch SHA-256 changed from `63aa4f98ea87e958658e2b033d34497b882dab15f02233823d929459d535f1ae` to `5f14c516e0c7a2be0aa613a98a475138fe4e5824bd7715e51ae46652059c709b`. The fixed assertion script retained its expected content. A before/after hash inventory of tracked/untracked files outside `.nodulus/` showed no changes. The surviving OpenCode process was created on September 24, predating this probe; it was left alone.

Disposition: **partial edit capability, failed end-to-end probe**. This disproves a blanket inability to write files, but does not establish reliable tool-result parsing, instruction following or completion. No further inference was dispatched. Across all three sessions the available reported aggregates are 38 assistant messages, 739,900 input tokens and 8,098 output tokens; the timeout makes complete usage uncertain.

## Artifact audit and scope

For each run, `.nodulus/runs/<run-id>/` contains the request, assembled prompt, invocation, raw response, validation, transport transcript, events, run state and metrics. Both initial responses were invalid JSON. Each received one response-only repair. P01a's repaired success-shaped report failed the independent RED validator. P01b's repaired error envelope was schema-valid, but the run remained an error. Both `completedNodes` arrays are empty; implementation never ran.

The existence of `nodes/.../result.json`, or a schema-valid outcome, is not acceptance. Read the corresponding validation and run state. P01a's independent Vitest evidence is `.nodulus/checkpoints/red/78952e50-b86b-41c0-b16d-aa2239fae8f5.json`: one failed test with a plain harness Error, correctly rejected. P01b has no new RED receipt because its outcome was an error before the artifact gate.

Rejected drafts and the stray output file were preserved under `.nodulus/rejected/` and removed from the active test suite. Raw provider/session transcripts remain local, not committed. The Codex adapter SHA-256 remained `7cc81a967e215df837e3c75f8d297c38ec892333c0ffa9de4ae3d2e870e2448d`; no product diff was accepted. Pre-existing unrelated checkout changes were preserved. P01b would not have proved prelaunch ordering even if it passed: that timing probe, metadata, other providers and the rest of OBS-001 still need separate tests.

## Recommended SDLC improvements

1. **Improve tool execution reliability before another product assignment.** The disposable edit probe exposed confusion between file bytes and read-tool display metadata, followed by incomplete execution. Next proposed comparison: the same disposable task with a dedicated short worker prompt and minimal read/edit/test tools, explicitly distinguishing tool display wrappers from file content. Keep model/task fixed, assign a fresh small budget, and score diff/assertion/protocol completion and internal call count. This configuration comparison has not run. Do not weaken product acceptance or automatically switch to GPT.
2. **Make budgets cover internal turns.** Add provider-specific verified limits on model/tool steps where supported, plus duration/output limits and a usage ledger. A workflow timeout or number of Nodulus nodes is not a token cap. Fail with a typed budget diagnostic and preserve partial evidence. Do not claim a hard cap until integration tests prove it.
3. **Produce deterministic evidence receipts.** Record command identity, exit status, assertion details, test hash and source revision from the fixed validator. Bind implementation to the accepted receipt and frozen test; do not trust prose `validation` or let a success-shaped JSON artifact imply accepted work. Distinguish executed/validated/accepted states clearly in status output.
4. **Make scope enforcement explicit.** Prompt file lists are not isolation. Compare before/after file inventories, include untracked outputs, fail on unexpected edits, and retain the draft for inspection. A future isolated patch application step could enforce assigned paths. This experiment used coordinator inspection, not an implemented automatic scope gate.
5. **Separate errors from rework.** Envelope repair may only fix formatting and must never repeat writing actions. A premature final response needs a separate bounded work correction, charged to its budget. A real `PACKET_BLOCKED` outcome should name an external obstacle; missing work alone should remain incomplete evidence rather than imply a permissions failure.
6. **Keep packets small and concrete.** State content-versus-path types, helper signatures, exact fixture outputs, shell and working directory, assertions, and pending coverage. Prefer relative in-worktree paths and a fixed validation command to avoid shell/path detours. Smaller packets improved diagnosis here, but did not prove successful implementation.

These are proposals, not runtime changes delivered by this branch. The next step should compare the edit/tool protocol setup before spending more local compute on OBS-001. Model quality or an alternative local coding model may then merit a controlled comparison; this experiment does not establish which model would work best. Do not simply increase timeouts or request length based on this evidence.

## Verification of the delivered setup

These checks verify the reusable setup and existing regressions, not successful Qwen feature delivery. Docs/skill metadata follow the explicit non-TDD exception in `docs/testing.md`; the example workflows reuse existing runtime/validator behavior.

- Skill creator's `quick_validate.py`: passed for `nodulus-task-packets`.
- Local Markdown links in the new skill/packets and affected indexes: no missing targets. All example JSON parsed.
- `npm run check`: exit 0 on Windows; lint and typecheck passed; 39 scenario files / 155 tests passed; one package file / seven tests passed. Rejected Qwen drafts were quarantined before this check. No accepted product test was added.
- GPT-5.6 Sol's first focused setup review requested changes: remove per-packet full-suite execution, require before/after scope checks, preserve failed drafts, and close P01 without product acceptance. The implementation packet now validates its response contract only; coordinator-scoped GREEN and file/hash inspection are mandatory, with the full check reserved for final acceptance. The same reviewer's focused follow-up accepted the revised setup as a supervised experiment only, with no factual or safety blocker in that scope. Automatic scope enforcement remains unimplemented; acceptance does not cover unattended operation, product behavior or Qwen writer reliability.

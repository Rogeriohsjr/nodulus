# Claude Code provider extension

Status: Claude adapter and observed-usage parser are accepted by Sol. A bounded installed-archive Windows run captured Haiku success and a controlled inner Nodulus error with CLI 2.1.295; Sonnet and macOS/Linux live compatibility remain pending. The final local `npm run check` passes on Windows; this is not new hosted CI or publish proof. Scope: folder 07 maintenance, prerequisites 00–06 accepted in their evidence. Existing Codex/Cursor behavior and the repository's `develop` workflow remain in place.

## Execution and review

Execute the local `claude-implementation` Nodulus workflow using the app GPT-6 Luna builder at medium reasoning through the exported `runWorkflow` application API and an injected app-agent `ProviderPort`. A local mailbox bridge captures the real invocation and accepts the actual builder outcome; Nodulus validates and persists it normally. The installed Codex CLI 0.144.4 rejected this account/model, so the app provider is used for implementation; this is not live Codex CLI compatibility proof. The coordinator supplies a request for each stable checkpoint: tests/RED, then implementation/GREEN after Sol accepts the tests. One writer; Sol reviews frozen files. Use at most two correction rounds per checkpoint, as described in `docs/agent-workflow.md`. Capture run IDs and results here or in evidence.md. Implementation agents must not invoke live Claude, publish, or release.

## Provider design

- Extend explicit provider kind selection and safe profile snapshots with `claude`, retaining generic injected providers.
- Probe the installed version and `claude auth status`; inspect the documented JSON `loggedIn` value as well as exit status. Local 2.1.294 returns exit 1 with `loggedIn: false` (explicit exit-code check). Also exercise an exit-0/loggedIn=false fixture so inconsistent auth responses cannot permit inference. Record a conservative supported version floor from inspected flags; do not claim older compatibility without proof.
- Invoke print mode with complete UTF-8 prompt through stdin, project cwd, JSON output and explicit optional model. Use documented JSON schema support where compatible with response limits. Parse the result transport and return only the Nodulus outcome from its structured output; independently validate outcome/artifacts through the existing core. Distinguish a successful Claude transport carrying a Nodulus `error` from Claude transport/API failure.
- Retain per-attempt prompt and raw transport diagnostics, bounded output and process-tree timeout handling. No full-action response repair; invalid outcomes must stop without replay.
- Capture allowlisted Claude options needed by the smoke: `maxTurns`, `maxBudgetUsd`, and tool/customization isolation. Validate option values before inference and preserve them on resume. Use typed options rather than arbitrary CLI argument injection. Do not change Codex/Cursor flags.
- Parse documented numeric usage/cost fields when present; missing values stay null and telemetry is reset between calls. Record requested and reported model information where available, without assuming an alias resolves to a fixed release.

## Acceptance matrix: PROV-005 Claude parity

Extend existing provider scenarios or add a focused PROV-005 file using production CLI/application composition and real external executable fixtures. Fixtures must reject unexpected flags and extra calls.

| Existing scenario | Required Claude coverage |
| --- | --- |
| PROV-001 protocol | Valid structured result/artifact; Haiku → Sonnet mapping through a two-node workflow; Nodulus error outcome stops successors; needs_input/resume with answers and isolated attempt files; captured kind/options and credential exclusion |
| PROV-002 readiness | Missing executable, disabled profile, unsupported/unrecognized version, auth probe failure and exit-0 loggedIn=false; no inference or successor after failure; doctor preserves current discovery semantics |
| PROV-003 portability | Spaces/Unicode/shell-sensitive executable and project paths, Windows wrapper, long stdin with unique tail, byte-split UTF-8 response, bounded timeout/child cleanup and output overflow |
| PROV-004 capability/usage | Missing and present usage; malformed JSON/envelope, missing structured output, invalid outcome/artifact, process/API failure, turn/budget exhaustion; exactly one inference, no unsafe repair or successor |
| Model/options | `haiku`, `sonnet`, explicit model ID, omitted model and provider-rejected model; flags/options are forwarded and safely snapshotted; invalid budgets/turns rejected before inference |

Include at least one compiled CLI process scenario and a fresh-process resume check. Preserve Codex/Cursor regression coverage. Assert persisted checkpoints/raw responses/metrics and no successor calls for errors, rather than source text or private call order.

## Reusable smoke workflow

Provide tracked example definitions outside generated run directories and instructions to copy them into an initialized project. Profiles `claude-haiku` and `claude-sonnet` use kind `claude`, the corresponding model aliases and the user's authenticated executable. Do not overwrite settings or replace a default workflow. Also install the smoke definitions in this local worktree for execution.

Workflow `claude-smoke`: Haiku emits `{message: "ping"}` under a tiny schema; Sonnet consumes that artifact and emits `{message: "pong"}`. Fixed local schema/validator checks establish the expected values. Minimal instructions/context; no code-editing task. Disable built-in/MCP tools and customizations for smoke calls while preserving normal Claude authentication; do not use `--bare`, which disables OAuth. Bound turns (allow the extra structured-output turn), timeout and estimated dollar budget. No model fallback or automatic retry. Proposed starting cap: $0.05 per node, two total live Claude CLI invocations maximum (one Haiku, one Sonnet; each may make up to three agentic turns); budget flags are estimates and can overshoot, not hard token caps.

## Validation and limits

1. Tests and executable fixtures first; record behavioral RED before runtime edits and obtain focused Sol test acceptance.
2. Implement, run focused provider checks, lint and typecheck; record GREEN; Sol reviews stable implementation.
3. Run `npm run check` sequentially (runtime tests then package tests), record exact local results. Hosted platform proof remains separate.
4. Coordinator runs the two-process live smoke only after fixture acceptance and authentication readiness. Exercise remaining error/model variants via fixtures at no Claude inference cost. If a live call fails, stop and retain diagnostics; no automatic live retries.

At the initial setup checkpoint, the installed executable was `C:\Users\Admin\.local\bin\claude.exe`, version 2.1.294, absent from this process PATH, and auth status was `loggedIn=false`; live verification awaited login then. A later bounded installed-archive Haiku capture is recorded below. No credentials are stored in project configuration.

Official sources inspected: [CLI reference](https://code.claude.com/docs/en/cli-reference), [programmatic execution](https://code.claude.com/docs/en/headless), [model selection](https://code.claude.com/docs/en/model-config). Local installed help confirmed print, JSON schema, model, budget, tools, safe mode and no-session-persistence flags. Fixture checks do not establish compatibility beyond the bounded Windows Haiku result captured later, or hosted platform compatibility.

Plan review: Sol requested clarification that two CLI processes can contain multiple model requests. Corrected to two provider process invocations, maxTurns=3 and an estimated budget per process; no exact two-inference claim.


Sol accepted the corrected plan. Setup runs e34e7066-5577-4025-9349-0d74c71d7683 (old CLI project-config parsing) and 2203ce2d-be71-45dc-bc01-55cde058f2cc (model unsupported) stopped before implementation. Test checkpoint run: 687a1d37-051d-4ec2-b4dd-63266496e3cf via app Luna bridge. Setup failures are not behavioral RED evidence.


## Coordinator run receipts

| Run | Checkpoint | Observed result |
| --- | --- | --- |
| 687a1d37-051d-4ec2-b4dd-63266496e3cf | Tests/RED | Nodulus success receipt; 30 expected Claude failures, 18 existing provider passes; build/lint/typecheck passed. Sol requested four test corrections; runtime implementation has not started. |
| f260e7fb-d407-46af-bfa8-9059b3631712 | Test correction 1 | Nodulus success receipt; corrections accepted by Sol. Build/lint/typecheck passed, 29 expected Claude RED failures and 18 existing provider passes (47 total). |

| 9bb59d06-2783-4182-8887-30756b2956dc | Implementation/GREEN | Nodulus success receipt; Claude source accepted by Sol, 50 focused tests pass, lint/typecheck pass. Full check failed only NODE-003 in the latest run (146/147 scenarios). |


Auth evidence correction: the initial batched shell exit code reflected a later command. An explicit LASTEXITCODE check confirmed Claude auth status exits 1 while loggedIn=false. Exit-0/loggedIn=false remains a defensive fixture case, not an observed local vendor response.


## Historical coordinator verification (before the 2026-10-09 Haiku capture)

These results describe the state at that earlier checkpoint; the later bounded Windows Haiku capture and final local full-check result are recorded below.

- Package/doc correction run `3531e8d6-405e-4fbf-8054-d253ec2561d8`: Nodulus success receipt; Sol accepted the scoped correction. Lint/typecheck passed; `npm run test:package` passed 7/7 after correcting the packaged guide link and isolating the dry-run test version in an owned scratch directory. No actual publication or production version change occurred.
- Reduced-worker diagnostic `npx vitest run tests/scenarios --exclude tests/scenarios/pkg-*.test.ts --maxWorkers 2` failed only NODE-003 at that time (146/147 passed). It was not a green replacement for `npm run check`.
- Timestamped real-process diagnostic in local `.nodulus/diagnostics/validator-cQx9b6/diagnostic.json`: timeout fired at 159ms, taskkill spawned at 166ms, exited at 404ms, validator closed at 406ms. The single diagnostic marker was absent but within milliseconds of its 350ms-after-fixture-start window. Sol identified asynchronous Windows tree-kill latency and recommended separate process supervision; no cleanup assertion or production validator code was changed.
- Installed smoke run `610c67c0-9579-43a3-bfdd-11745df9cc10` errored at Claude auth before print/inference. No Sonnet node ran, no accepted artifacts were produced, and no Claude inference tokens were consumed in that run. Login was still required for the planned two-process live smoke at that checkpoint; the later Haiku capture is recorded separately below.
- At that checkpoint the existing `develop` workflow, defaultWorkflow, and original Codex profile were retained; Claude definitions/profiles were additive. No publish or hosted validation was performed. Windows supervision scope clarification had not been expanded into this Claude change.

### Captured Windows Haiku follow-up (2026-10-09)

The parent made three bounded local CLI calls after installing archive SHA-256 `e1fbaab2cb620a91b8dceeb9360bc995a5dd29829ceb310f34028bd06c76ecab` (package 1.0.0, Claude Code CLI 2.1.295). Haiku success and a controlled outer-CLI-success/inner-Nodulus-error payload were captured; all three calls, including the `maxTurns: 1` turn probe, reported aggregate CLI cost `$0.001666765`. The first two costs were `$0.0007042` and `$0.000527845`; these are not verified invoices. Sanitized fixture replays and parser findings are recorded in [folder evidence](evidence.md#sanitized-haiku-observation-replay-2026-10-09). This is Windows Haiku proof only; no Sonnet success or macOS/Linux compatibility is claimed. The `maxTurns: 1` probe returned SDK success with `num_turns: 2` and a non-LLM successor probe, not a live provider error.

# Develop and review this repository with Nodulus

This example turns the repository's local-builder and independent-review process into sequential Nodulus nodes. Writing nodes use OpenCode with local Ollama `qwen3.5:9b`; Qwen reviews run in fresh OpenCode sessions and the final review uses a fresh GPT-5.6 Sol Codex execution.

## Sequence

1. `dev-tests`: OpenCode/Qwen writes real tests and observes meaningful RED (or records an applicable non-TDD exception).
2. `dev-test-review`: Qwen inspects the actual tests and independently verifies the checkpoint.
3. `dev-implement`: OpenCode/Qwen implements to GREEN and runs required checks.
4. `dev-qwen-review`: Qwen independently inspects implementation and reruns the focused check.
5. `dev-review`: GPT-5.6 Sol inspects actual files and reruns focused checks.

Only an accepted review is a success artifact. A rejection returns `REVIEW_CHANGES_REQUIRED` and stops the workflow. Ask for a focused correction in a new request; v1 does not automatically loop or revise previous nodes. `needs_input` uses the normal saved clarification/resume flow. The separate `develop-escalate` workflow provides a GPT-5.6 Sol diagnosis when explicitly requested, normally after two correction rounds. No extra LLM supervisor runs.

## Setup

Use a dedicated Git worktree with dependencies installed. Copy the contents of this example's `.nodulus` directory into that worktree's `.nodulus` directory. Merge settings and preserve existing definitions if the destination already exists; never blindly overwrite another workflow. Copy `.agents/skills/nodulus-workflow-builder/SKILL.md` from this repository into the same path in the target worktree; nodes explicitly include it in their prompt, so skill auto-discovery is not required. Inspect and merge `opencode.json` into the worktree root so its local model and permissions are explicit. The names `dev-*` and `develop-reviewed` avoid the existing local `develop` example. Ignore `.nodulus/runs/` and `.nodulus/pilot/`.

Node.js 24, OpenCode 1.18.32 or newer, a running Ollama service with `qwen3.5:9b`, and an authenticated Codex CLI are required. Models must be available to each provider. OpenCode local inference reports zero vendor cost but still consumes local compute; Codex review nodes consume account usage. Timeouts bound wall time, not tokens or money. A straight-through run makes four local OpenCode invocations and one Codex invocation. The OpenCode writer explicitly enables `responseRepair`, allowing at most two non-writing corrections in the same captured session when its final Nodulus envelope is invalid. It never repeats the writing action. Workflow review rejection and implementation correction remain separate requests.

```sh
npm ci
npm run build
node dist/bin.js doctor --json
node dist/bin.js run --workflow develop-reviewed --request-file .nodulus/requests/observability-obs-001.md --json
```

For a published version containing this change, use `nodulus` in place of `node dist/bin.js`. Run `opencode models ollama` and `codex login status` from the worktree before invoking models. If multiple executables are installed, set each profile executable to the actual current binary or command shim.

OpenCode writing permissions come from the root `opencode.json`; the supplied example denies external directories, subagents, web tools, commits, pushes, reset and clean while allowing in-worktree edits and test commands. It also defines a primary `nodulus-response` agent whose final permission rule denies every tool. Nodulus uses that agent only for same-session envelope correction, avoiding the built-in plan agent's unrelated planning instructions and preventing repair from editing files or running commands. GPT-5.6 Sol receives Codex `workspace-write` because build and Vitest create generated files; all review instructions prohibit source edits, and independent evidence records whether files changed. Codex uses approval policy `never`. These policies are not a Nodulus per-file isolation boundary. Use a separate worktree and explicit task paths; never use a sandbox or permission bypass to get a test green.

## Historical pilot and evidence

The historical Node-test pilot asks for a tiny `clamp` function and real Node tests only under `.nodulus/pilot/`. Its prior run exercised RED, test review, GREEN and final review without modifying product behavior. Successful fixture tests demonstrate mapping/stopping logic, not live model correctness. See [the implementation evidence](../../docs/implementation/10-development-workflow/evidence.md) for observed live results and limitations.

Inspect `.nodulus/runs/<run-id>/run.json`, `events.jsonl`, `nodes/<node-id>/attempt-001/` and `provider/<node-id>/attempt-001/`. The latter retains provider transport logs and final responses. Preserve failed attempts; do not report an error run as successful. The workflow does not commit, push, merge or publish. Review and commit accepted changes separately.

## Deterministic final check

An accepted final review is additionally validated by `.nodulus/validators/dev-quality.mjs`, which runs the fixed repository command `npm run check`. A nonzero exit or the 120-second validator timeout stops the workflow even if the reviewer says ACCEPT. The validator runs as a normal Nodulus child process with the caller's permissions, separately from the Codex node sandbox. It does not execute commands supplied by the model. Failure output is retained in the final node's validation diagnostics; success records the accepted validator verdict. Only use this example on a repository whose check script you trust and authorize.

For this Nodulus repository, the full suite includes process timeout/cancellation tests. They timed out in the pilot's Codex Windows sandbox but passed under the normal Nodulus caller. No timeouts were raised and no sandbox bypass was enabled. Node reports must retain any failed checks; the final scripted gate establishes the actual full-suite result.

To review and validate existing work without replaying the builder, use `develop-verify` with a request describing the scope and requirements. It has one GPT-5.6 Sol review node followed by the same scripted gate. It is useful after a focused correction or to verify an existing exercise.

```sh
node dist/bin.js run --workflow develop-verify --request "Review .nodulus/pilot/clamp.mjs and clamp.test.mjs against .nodulus/requests/pilot.md; do not edit files." --json
```

## Qwen review limits and improvement

Qwen writing and review sessions use the adapter's existing build agent. Reviewer instructions prohibit source edits, but this is not a separate filesystem sandbox. Inspect the reviewer diff and reject unexpected edits. Sol provides review by a different model family; Qwen agreement is not independent model diversity. Preserve failed runs and apply at most two focused correction requests. Skill changes require an observed failure and coordinator review; the workflow does not rewrite its own rules.

The live local setup selects the authenticated npm Codex executable explicitly when another older Codex installation takes precedence on PATH. Do not change global configuration to mask an executable mismatch.

## Required RED checkpoint configuration

Before the run command above, the coordinator creates `.nodulus/development-task.json` with `{"mode":"vitest-red","testFile":"tests/scenarios/obs-001-effective-provider-request.test.ts"}` (substitute the assigned test). After the test writer and again after Qwen test-review ACCEPT, the fixed `dev-red.mjs` validator builds and runs only that test through real Vitest. It rejects passing tests, missing tests and setup/syntax failures before implementation can start; JSON reports are saved under `.nodulus/checkpoints/red/`. An assertion failure still needs review for relevance. Models must not edit this configuration or validator.

For an actual documented non-TDD task, the coordinator may explicitly select `{"mode":"non-tdd","reason":"The specific docs/testing.md exception and replacement verification"}`. Never use that mode to bypass runtime TDD. The historical Node-test pilot needs a supported RED runner or manual checkpoint; the new automatic gate currently supports Vitest scenarios only. Missing task configuration fails closed.

See [current local-run evidence](../../docs/implementation/11-opencode-workflow/qwen-review-evidence.md) for the rejected Qwen checkpoints and guard improvements. Workflow success alone is not accepted implementation evidence.

## Small work packets for local Qwen

Use the coordinator skill `.agents/skills/nodulus-task-packets/SKILL.md` to split a scenario before dispatch. The worker receives one packet rather than the entire planning skill. See [the OBS-001 packet experiment](../../docs/implementation/12-execution-observability/packets/README.md).

After copying the example definitions and configuring `.nodulus/development-task.json` for the assigned test, run `nodulus run --workflow packet-test --request-file <test-packet.md> --json`. The fixed RED gate must pass, and the coordinator must verify assertion relevance, inspect all changed/untracked paths and freeze the test hash. Only then run `nodulus run --workflow packet-implement --request-file <implementation-packet.md> --json`. This small implementation node validates the response contract only: the coordinator must independently verify its scoped GREEN command, unchanged test hash and file scope before accepting work. Run the full `npm run check` at final acceptance, not on every packet. These are existing Nodulus commands with small workflow definitions, not a new CLI API. A successful run is not coordinator acceptance and does not complete its parent scenario. The examples are supervised; automatic scope/hash receipt enforcement remains future work.

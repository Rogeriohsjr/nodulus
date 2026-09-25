# Develop and review this repository with Nodulus

This example turns the repository's local-builder and independent-review process into sequential Nodulus nodes. Writing nodes use OpenCode with local Ollama `qwen3.5:9b`; review nodes are fresh Codex CLI executions with explicit models and policies.

## Sequence

1. `dev-tests`: OpenCode/Qwen writes real tests and observes meaningful RED (or records an applicable non-TDD exception).
2. `dev-test-review`: Luna inspects the actual tests and independently verifies the checkpoint.
3. `dev-implement`: OpenCode/Qwen implements to GREEN and runs required checks.
4. `dev-review`: GPT-5.6 Sol inspects actual files and reruns focused checks.

Only an accepted review is a success artifact. A rejection returns `REVIEW_CHANGES_REQUIRED` and stops the workflow. Ask for a focused correction in a new request; v1 does not automatically loop or revise previous nodes. `needs_input` uses the normal saved clarification/resume flow. The separate `develop-escalate` workflow provides a GPT-5.6 Sol diagnosis when explicitly requested, normally after two correction rounds. No extra LLM supervisor runs.

## Setup

Use a dedicated Git worktree with dependencies installed. Copy the contents of this example's `.nodulus` directory into that worktree's `.nodulus` directory. Merge settings and preserve existing definitions if the destination already exists; never blindly overwrite another workflow. Inspect and merge `opencode.json` into the worktree root so its local model and permissions are explicit. The names `dev-*` and `develop-reviewed` avoid the existing local `develop` example. Ignore `.nodulus/runs/` and `.nodulus/pilot/`.

Node.js 24, OpenCode 1.18.32 or newer, a running Ollama service with `qwen3.5:9b`, and an authenticated Codex CLI are required. Models must be available to each provider. OpenCode local inference reports zero vendor cost but still consumes local compute; Codex review nodes consume account usage. Timeouts bound wall time, not tokens or money. A straight-through run makes two local OpenCode and two Codex invocations. The OpenCode writer explicitly enables `responseRepair`, allowing at most two non-writing corrections in the same captured session when its final Nodulus envelope is invalid. It never repeats the writing action. Workflow review rejection and implementation correction remain separate requests.

```sh
npm ci
npm run build
node dist/bin.js doctor --json
node dist/bin.js run --workflow develop-reviewed --request-file .nodulus/requests/pilot.md --json
```

For a published version containing this change, use `nodulus` in place of `node dist/bin.js`. Run `opencode models ollama` and `codex login status` from the worktree before invoking models. If multiple executables are installed, set each profile executable to the actual current binary or command shim.

OpenCode writing permissions come from the root `opencode.json`; the supplied example denies external directories, subagents, web tools, commits, pushes, reset and clean while allowing in-worktree edits and test commands. It also defines a primary `nodulus-response` agent whose final permission rule denies every tool. Nodulus uses that agent only for same-session envelope correction, avoiding the built-in plan agent's unrelated planning instructions and preventing repair from editing files or running commands. Luna and GPT-5.6 Sol receive Codex `workspace-write` because build and Vitest create generated files; both review instructions prohibit source edits, and independent evidence records whether files changed. Codex uses approval policy `never`. These policies are not a Nodulus per-file isolation boundary. Use a separate worktree and explicit task paths; never use a sandbox or permission bypass to get a test green.

## Pilot and evidence

The supplied pilot asks for a tiny `clamp` function and real Node tests only under `.nodulus/pilot/`. It exercises RED, test review, GREEN and final review without modifying product behavior. Successful fixture tests demonstrate mapping/stopping logic, not live model correctness. See [the implementation evidence](../../docs/implementation/10-development-workflow/evidence.md) for observed live results and limitations.

Inspect `.nodulus/runs/<run-id>/run.json`, `events.jsonl`, `nodes/<node-id>/attempt-001/` and `provider/<node-id>/attempt-001/`. The latter retains provider transport logs and final responses. Preserve failed attempts; do not report an error run as successful. The workflow does not commit, push, merge or publish. Review and commit accepted changes separately.

## Deterministic final check

An accepted final review is additionally validated by `.nodulus/validators/dev-quality.mjs`, which runs the fixed repository command `npm run check`. A nonzero exit or the 120-second validator timeout stops the workflow even if the reviewer says ACCEPT. The validator runs as a normal Nodulus child process with the caller's permissions, separately from the Codex node sandbox. It does not execute commands supplied by the model. Failure output is retained in the final node's validation diagnostics; success records the accepted validator verdict. Only use this example on a repository whose check script you trust and authorize.

For this Nodulus repository, the full suite includes process timeout/cancellation tests. They timed out in the pilot's Codex Windows sandbox but passed under the normal Nodulus caller. No timeouts were raised and no sandbox bypass was enabled. Node reports must retain any failed checks; the final scripted gate establishes the actual full-suite result.

To review and validate existing work without replaying the builder, use `develop-verify` with a request describing the scope and requirements. It has one GPT-5.6 Sol review node followed by the same scripted gate. It is useful after a focused correction or to verify an existing exercise.

```sh
node dist/bin.js run --workflow develop-verify --request "Review .nodulus/pilot/clamp.mjs and clamp.test.mjs against .nodulus/requests/pilot.md; do not edit files." --json
```

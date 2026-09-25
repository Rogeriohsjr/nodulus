# Develop and review this repository with Nodulus

This example turns the repository's Luna-builder/Sol-reviewer process into sequential Nodulus nodes. Node calls are fresh Codex CLI executions; they do not load the app's `.codex/agents/*.toml` as agents. Their instructions and model settings are explicit here.

## Sequence

1. `dev-tests`: Luna writes real tests and observes meaningful RED (or records an applicable non-TDD exception).
2. `dev-test-review`: Sol inspects the actual tests and independently verifies the checkpoint.
3. `dev-implement`: Luna implements to GREEN and runs required checks.
4. `dev-review`: Sol inspects actual files and reruns focused checks.

Only an accepted review is a success artifact. A rejection returns `REVIEW_CHANGES_REQUIRED` and stops the workflow. Ask for a focused correction in a new request; v1 does not automatically loop or revise previous nodes. `needs_input` uses the normal saved clarification/resume flow. The separate `develop-escalate` workflow provides a Sol diagnosis when explicitly requested, normally after two correction rounds. No extra LLM supervisor runs.

## Setup

Use a dedicated Git worktree with dependencies installed. Copy the contents of this example's `.nodulus` directory into that worktree's `.nodulus` directory. Merge settings and preserve existing definitions if the destination already exists; never blindly overwrite another workflow. The names `dev-*` and `develop-reviewed` avoid the existing local `develop` example. Ignore `.nodulus/runs/` and `.nodulus/pilot/`.

The profiles require the Codex policy support introduced alongside this example; npm 1.0.1 does not honor `sandbox` or `reasoningEffort`. Until this PR is released, use the built CLI from this branch. Node.js 24 and an authenticated Codex CLI are required. Models must be available to the signed-in account. Each run consumes model usage; timeouts bound wall time, not tokens or money. A straight-through run makes four node invocations; clarification/resume or future repair-capable providers can add calls. These Codex profiles do not enable response repair. Escalation is separate.

```sh
npm ci
npm run build
node dist/bin.js doctor --json
node dist/bin.js run --workflow develop-reviewed --request-file .nodulus/requests/pilot.md --json
```

For a published version containing this change, use `nodulus` in place of `node dist/bin.js`. Run `codex login status` from the worktree before invoking models. The live pilot uses standalone Codex CLI 0.156.1; the app-bundled 0.144.4 rejected newer project settings and Luna. If multiple executables are installed, set each profile executable to the actual current binary or command shim. Node profiles independently select Luna or Sol at medium reasoning.

Builder calls request Codex `workspace-write`; reviewer calls request `read-only`. Both use non-interactive approval policy `never`, so an action requiring approval fails instead of broadening permissions. These are Codex sandbox policies, not a Nodulus per-file isolation boundary. Use a separate worktree; textual task limits do not enforce filesystem isolation. Reviewers can run non-writing checks; tests needing generated build files may require already-built artifacts or a separate verification process. Never use a sandbox bypass to get a test green.

## Pilot and evidence

The supplied pilot asks for a tiny `clamp` function and real Node tests only under `.nodulus/pilot/`. It exercises RED, test review, GREEN and final review without modifying product behavior. Successful fixture tests demonstrate mapping/stopping logic, not live model correctness. See [the implementation evidence](../../docs/implementation/10-development-workflow/evidence.md) for observed live results and limitations.

Inspect `.nodulus/runs/<run-id>/run.json`, `events.jsonl`, `nodes/<node-id>/attempt-001/` and `provider/<node-id>/attempt-001/`. The latter retains provider transport logs and final responses. Preserve failed attempts; do not report an error run as successful. The workflow does not commit, push, merge or publish. Review and commit accepted changes separately.

## Deterministic final check

An accepted final review is additionally validated by `.nodulus/validators/dev-quality.mjs`, which runs the fixed repository command `npm run check`. A nonzero exit or the 120-second validator timeout stops the workflow even if the reviewer says ACCEPT. The validator runs as a normal Nodulus child process with the caller's permissions, separately from the Codex node sandbox. It does not execute commands supplied by the model. Failure output is retained in the final node's validation diagnostics; success records the accepted validator verdict. Only use this example on a repository whose check script you trust and authorize.

For this Nodulus repository, the full suite includes process timeout/cancellation tests. They timed out in the pilot's Codex Windows sandbox but passed under the normal Nodulus caller. No timeouts were raised and no sandbox bypass was enabled. Node reports must retain any failed checks; the final scripted gate establishes the actual full-suite result.

To review and validate existing work without replaying the builder, use `develop-verify` with a request describing the scope and requirements. It has one Sol review node followed by the same scripted gate. It is useful after a focused correction or to verify the pilot's existing `.nodulus/pilot/` files.

```sh
node dist/bin.js run --workflow develop-verify --request "Review .nodulus/pilot/clamp.mjs and clamp.test.mjs against .nodulus/requests/pilot.md; do not edit files." --json
```

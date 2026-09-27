# Qwen builder and review workflow follow-up

User authorization: 2026-09-26, use local Qwen to build and review, then Sol for final review. The retained Sol choice is GPT-5.6 Sol. This supersedes Luna test review for the development example; earlier evidence remains historical.

## Sequence and scope

`dev-tests` (Qwen) -> `dev-test-review` (Qwen) -> `dev-implement` (Qwen) -> `dev-qwen-review` (Qwen) -> `dev-review` (GPT-5.6 Sol) -> fixed `npm run check` validator.

Each stage is a fresh provider execution. Only accepted review artifacts permit downstream work. Rejected tests stop before implementation; rejected Qwen code review stops before Sol; rejected Sol review stops before the fixed gate. No automatic code-correction loop or recursive delegation is added.

The [workflow skill](../../../.agents/skills/nodulus-workflow-builder/SKILL.md) is included directly in every node's instructions. It separates writer/reviewer roles, requires real scenario fixtures and observed RED/GREEN, preserves scope, and permits skill improvements only after a demonstrated failure and coordinator review. Prompt restrictions do not establish filesystem isolation for reviewers.

## Offline evidence

- Windows, source baseline `d15d249` (observability plan on top of main `1519183`).
- `npm run build` passed before the updated DEV-001 scenario was run.
- RED: `npx vitest run tests/scenarios/dev-001-development-workflow.test.ts` failed three tests: expected five nodes but received four; expected OpenCode/Qwen test review but received Codex/Luna. These are intended behavior mismatches, not setup failures.
- GREEN: the same focused command passed five cases: success, test-review rejection, Qwen code-review rejection, Sol rejection, and fixed-gate failure. Production runWorkflow/storage/contracts/validator are real; only external inference is replaced.
- `npm run lint` and `npm run typecheck` passed.
- `npm run check` passed lint/typecheck, 152 runtime/release scenarios and 7 local archive tests before starting the live builder. This is workflow-setup evidence, not OBS-001 GREEN.
- Skill `quick_validate.py` passed. The default/bundled Python lacked PyYAML; installing it in a task-specific temporary dependency directory resolved this validation-tool prerequisite without changing the repository's dependencies.

## Live run

- Installed Nodulus reports `2.1.0-dev.5`; OpenCode `1.18.32`; local Ollama lists `qwen3.5:9b`.
- The npm Codex CLI `0.156.1` reports authenticated with ChatGPT. Another Codex `0.144.4` earlier on PATH rejects the repository's agent configuration. Local profiles explicitly select the compatible npm CLI; no global config changes were made.
- `nodulus doctor --json` reports all four configured profiles available; `opencode models ollama` lists the requested model. These are readiness checks, not completed inference proof.
- Command: `nodulus run --workflow develop-reviewed --request-file .nodulus/requests/observability-obs-001.md --json`.
- Run ID: `bcfc23eb-847c-45f1-b285-d094a82a4ed0`.
- Assignment: [OBS-001 request](../../../examples/development-workflow/.nodulus/requests/observability-obs-001.md), one scenario only. The existing request/settings were backed up locally before merging the workflow definitions.
- Result: running at initial evidence capture; final outcome will be recorded after inspection. No claim of implemented OBS-001 or accepted model review is made yet.

Generated prompts, transports, raw outcomes, validation and checkpoints stay in the worktree's `.nodulus/runs/<run-id>/`. They are not committed. Preserve failures and correlate future corrections with new run IDs. Do not claim measured usage savings or cross-platform live proof from this Windows run.

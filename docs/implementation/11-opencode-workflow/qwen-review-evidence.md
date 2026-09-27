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
- Result: interrupted by the coordinator after Qwen test review accepted a vacuous passing test. The implementation stage had started; no product-source diff was produced. The draft skipped required persistence assertions when files were absent and rewrote scenario/evidence claims. Rejected files were preserved under `.nodulus/rejected/<run-id>/`; scenario requirements and pending evidence were restored. The checkpoint may still say running because interruption killed the process; this is not an active or completed workflow.

Generated prompts, transports, raw outcomes, validation and checkpoints stay in the worktree's `.nodulus/runs/<run-id>/`. They are not committed. Preserve failures and correlate future corrections with new run IDs. Do not claim measured usage savings or cross-platform live proof from this Windows run.

## Corrective monitoring and localhost verification

The coordinator added a fixed RED validator after the observed false acceptance. DEV-002 first failed because a model ACCEPT allowed passing/syntax-failing tests to advance; the validator then passed three real Vitest subprocess cases. It requires a successful build and an actual assertion-failing report, retains reports under `.nodulus/checkpoints/red/`, and fails closed on missing configuration. Assertion relevance still needs model/coordinator review. It is attached to the test writer and test reviewer so invalid tests cannot consume further review/implementation calls.

Correction round 1 used tests-only run `d4f202ca-547b-4e97-90a5-3a7a33ea3290`. Its artifact claimed three assertion failures. Independent Vitest instead reported a duplicate declaration with zero tests; the fixed validator rejected it. The test also asserted raw request equality instead of the effective prompt with suffixes. The rejected draft is preserved locally. GPT-5.6 Sol independently rejected that checkpoint and supplied focused correction findings without editing files or invoking providers.

Correction round 2 (`59ddd856-60ba-4be7-b0f1-36ebd2d88253`) returned another passing test that only checked the existing fixture stdin type. The fixed writer gate stopped the workflow with `VALIDATOR_EXECUTION_FAILED`: expected assertion RED, observed exit 0. Its draft is archived locally. OBS-001 remains unimplemented and checkpoint A remains incomplete; the two correction rounds are exhausted. No further OBS-001 writing run was started.

The coordinator then assigned Qwen a separate, narrowly scoped maintenance task: repair only the DEV-002 guard test according to Sol's exact call-sequence finding and move its cleanup safety check out of finally. That task has the existing full quality validator and does not continue the observability feature. Maintenance run `c4c10b1a-90ce-40a7-85c9-9e4124ee3f1d` fixed cleanup but missed the exact call assertion. A one-line corrective request in run `3129e7a3-2fd0-4e15-a81a-6f39ab0027f2` then produced the required exact sequence. The coordinator read back the assertion. Both maintenance runs passed the fixed `npm run check` artifact validator; its SHA-256 matched the repository example. This is successful local Qwen work on the guard test, not OBS-001 completion.

Verified locally on 2026-09-27: `opencode.json` uses `http://127.0.0.1:11434/v1`; the Ollama API reports loaded `qwen3.5:9b` with context length 65536. Export of captured OpenCode session `ses_f1efa2db6ffe76V0HJ5IyKgBBC` reports every assistant message as provider `ollama`, model `qwen3.5:9b`, reported vendor cost 0. These Qwen calls used local inference, not GPT. Sol reviews and the coordinator chat still consume their own provider usage. No total hardware/electricity cost or account-usage savings are inferred.

Final workflow setup: the five stages remain configured, the writer/reviewer RED gates fail closed, the skill explicitly rejects skipped missing-feature assertions, and failed OBS-001 drafts remain outside the test suite. Sol final review and current-head hosted checks are recorded at the PR handoff; no running Qwen task is left after the bounded attempts. No runtime source change was accepted.

GPT-5.6 Sol final review: ACCEPT for workflow hardening only, with no blocking findings. Independently ran DEV-002 (3/3 passed), checked scoped whitespace and JSON parsing, confirmed both gate attachments and the unchanged final quality script. OBS-001 remains rejected/unimplemented.

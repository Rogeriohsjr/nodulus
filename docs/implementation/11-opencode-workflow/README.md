# 11: Develop with OpenCode and review with Codex

User-authorized follow-up to the repository development workflow. This slice adds OpenCode as a concrete provider and replaces the builder role with local `qwen3.5:9b` through Ollama. It keeps independent Codex checkpoints and the deterministic repository quality gate.

## Target workflow

1. `dev-tests`: OpenCode with `ollama/qwen3.5:9b` writes scenario tests and observes meaningful RED.
2. `dev-test-review`: Codex Luna checks the tests and independently confirms that RED is behavioral.
3. `dev-implement`: OpenCode with the same local model implements the smallest GREEN change.
4. `dev-review`: Codex GPT-5.6 Sol reviews the final change and reruns focused checks.
5. The fixed validator runs `npm run check`; model acceptance alone cannot complete the workflow.

The OpenCode process may edit only through its project-level permission configuration. The example denies external-directory access, subagents, web access, destructive Git operations, commits and pushes. Its dedicated `nodulus-response` agent denies every tool while correcting an invalid response envelope. Nodulus does not claim that prompt text enforces path isolation.

## Scenarios

- [x] PROV-007: `kind: opencode` invokes the configured executable with the selected model, project directory, `--thinking`, and raw JSON event output; it selects text from the final stopped assistant message, falling back to that message's reasoning only when text is absent, then passes it to the unchanged Nodulus outcome validator.
- [x] PROV-008: OpenCode version/model readiness, timeout, output-limit, nonzero exit, malformed event JSON, missing final stopped-message content and provider configuration failures return actionable errors before downstream nodes start.
- [x] DEV-003: the example maps OpenCode/Qwen test and implementation artifacts through a Luna test-review checkpoint and a GPT-5.6 Sol final-review checkpoint, then runs the deterministic quality gate.
- [x] LIVE-001: installed Nodulus invokes live OpenCode 1.18.32 with local Ollama `qwen3.5:9b` in an isolated exercise; observed RED, Luna acceptance, GREEN, Sol acceptance and final quality-gate evidence are retained separately.

## Method

PROV-007, PROV-008 and DEV-003 use scenario TDD through the production CLI/application entry points. Provider tests use a real fixture executable and real temporary files; only external inference is replaced. Configuration documentation is reviewed separately under the documented non-TDD exception. LIVE-001 is live compatibility proof after all fixture scenarios and `npm run check` pass.

Record setup failures separately from behavioral RED. Do not replay a writing OpenCode action as response repair. Do not mark macOS/Linux or Cursor compatibility as verified from this Windows live run.

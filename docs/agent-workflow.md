# Low-usage builder and reviewer

The default project model and builder remain GPT-6 Luna at medium reasoning. At the user's request on 2026-09-24, routine checkpoint review uses GPT-6 Sol at medium reasoning. Keep reviews narrowly scoped to control usage.

## Roles and context

- `.codex/agents/nodulus-builder.toml`: one assigned scenario; sole source writer.
- `.codex/agents/nodulus-reviewer.toml`: stable checkpoint review; no source edits.
- `.codex/agents/nodulus-escalation.toml`: short, focused Sol diagnosis when needed.
- Coordinator: chooses the next eligible scenario, supplies compact context, handles handoffs, verifies evidence, and accepts completion.

Use fresh subagent context with repository paths and the exact scenario; avoid copying the entire conversation. Select the model explicitly when the host's spawn interface requires it. Custom agent files are reusable configuration, not proof that a running agent loaded them.

Existing tasks retain their selected model. Project defaults apply when the client loads the configuration and may be overridden by explicit UI/session selections. This setup does not change global user settings or guarantee a hard usage cap.

## Checkpoint protocol

1. Assign one scenario to the builder after prerequisites are verified.
2. Builder writes the test/fixtures, runs RED, and stops at a test-review checkpoint. Bootstrap uses the documented non-TDD verification.
3. While the reviewer checks the frozen test, the coordinator may inspect prerequisites/docs, but nobody changes the reviewed files.
4. Reviewer returns ACCEPT or CHANGES_REQUIRED. ACCEPT at RED means the test is suitable, not that behavior works.
5. Builder implements to GREEN, records evidence, and returns a stable checkpoint.
6. Reviewer inspects the actual code/tests, checks [code quality](code-quality.md), and runs scoped verification. Builder supplies lint/typecheck evidence and the final `npm run check` result; reviewer checks any suppression and affected documentation. Coordinator marks accepted items only after review.
7. After two failed correction rounds, the Sol reviewer returns a focused diagnosis to the coordinator. Do not spawn another reviewer or repeat broad review loops.

One writer at a time. No continuous monitoring/polling loop, recursive delegation, or multiple implementers on dependent folders. Reuse a builder for the current slice; start fresh when its context becomes irrelevant. Keep reports to files, commands/results, and findings.

## Current assignment

The foundation/INIT-001 pilot is complete. On 2026-09-24 the user authorized all remaining stories, with Luna building, Sol reviewing and the coordinator committing accepted milestones. Folders 00 through 08 and folder 09 CI are now implemented; publication remains deferred. For follow-up maintenance, use the same stable checkpoints and the code-quality checklist. Keep real provider and hosted release evidence distinct; prepare release configuration without representing unperformed publication as complete.

## Usage rationale and limitations

The official credit rate card checked on 2026-09-23 lists GPT-6 Luna at 2.5/0.25/12.5 credits per million input/cached-input/output tokens, compared with Sol at 50/5/250. That is 20 times lower per-token credit rates, not a guarantee of 20 times cheaper completed tasks or identical plan-limit behavior. Both models consume usage. Retries, long context and coordination also cost usage.

Prefer Standard speed when the client exposes it; Fast mode has an additional multiplier. This repository does not claim to override the service tier of an already-running task or the host's subagent tool.

Sources: [pricing](https://learn.chatgpt.com/docs/pricing), [subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Pilot result

Foundation and INIT-001 completed locally on Windows with a Luna builder and independent Luna reviewer. Review found one instruction-reference bug; a stronger regression test exposed it before correction. Final typecheck/build and two scenario tests passed. No Sol escalation, live provider invocation, or publishing occurred. No per-agent billing measurement was available, so these results do not establish measured cost savings. The active coordinator retained its existing model; Luna defaults target future project sessions. This was the historical pilot checkpoint; the current status is in the implementation index.

## Folder 01 continuation result (2026-09-24)

The Luna builder and GPT-6 Sol reviewer completed INIT-002 through INIT-004. INIT-002 already passed and was recorded without fabricated RED. Sol requested stronger no-execution assertions at test review and found a Windows executable-extension bug at implementation review; the regression was demonstrated and fixed. Final local Windows typecheck/build and 8 scenario tests pass. No later folders, publishing, or live model calls were performed.

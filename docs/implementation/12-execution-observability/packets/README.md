# OBS-001 packet experiment

Authorized on 2026-09-28: improve task decomposition, let local Qwen write, monitor evidence/usage/artifacts, and report SDLC lessons. This is a new bounded experiment after the previous broad OBS-001 attempts were rejected.

Use the [task-packet skill](../../../../.agents/skills/nodulus-task-packets/SKILL.md). The coordinator authors specifications and validates results; Qwen authors tests and product code. Sol reviews a stable checkpoint only.

| Packet | Observable subset | Dependency | State |
| --- | --- | --- | --- |
| P01a | Combined timing fixture and persistence test | Existing real provider test helper | Rejected: Qwen confused stdin content with a path |
| P01b | Existing fixture proves saved file location and exact stdin contents after execution | Explicit correction packet, no new fixture | Rejected: read the test but stopped before editing |
| P02 | Codex persists effective stdin before spawn; preserves outcome behavior | Accepted P01b RED and frozen test | Blocked; not dispatched |
| P03 | Qwen reviews actual diff and reruns the focused test | P02 GREEN | Blocked; not dispatched |
| P04 | Sol final review, full check, report | Stable P03 checkpoint | Product review blocked; setup review and experiment report only |

The scoped production output is `.nodulus/runs/<run-id>/calls/<call-id>/stdin.txt` for Codex calls. Metadata request.json, transport links, Cursor/OpenCode coverage, repair/resume and later OBS scenarios remain pending. This subset must not be labelled full OBS-001 acceptance. The corrected P01b checks persistence and content after execution; it does not prove process-start timing. P02 must await persistence before spawn, but a dedicated process-start probe remains a future test. This subset must not be represented as full prelaunch-ordering test coverage.

Read [the initial test packet](p01-codex-stdin-test.md), [its narrowed correction](p01b-persisted-stdin-test.md), [implementation packet](p02-codex-stdin-implementation.md), and [experiment report](report.md). No meaningful RED or product implementation was accepted. The initial call and its one permitted correction are exhausted; another experiment requires a new, explicit budget and hypothesis.

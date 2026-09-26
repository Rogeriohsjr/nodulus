# Evidence: execution observability plan

## Documentation task

- Date: 2026-09-25.
- Scope: online source research, repository baseline inspection, scenario/design/implementation handoff documentation only.
- Baseline: main `1519183`, `feat: add OpenCode development workflows (#7)`.
- Sources and limitations: [research.md](research.md).
- Document validation: a scoped Python check passed for 10 Markdown files and 86 local link targets, balanced code fences, unique OBS-001 through OBS-012 headings and no prematurely checked implementation boxes. Manual consistency review covered scenario/checkpoint mapping, baseline versus proposal, nullable costs and deferred live proof. `git diff --check` passed on Windows. This verifies document structure, not runtime behavior or provider billing.
- Runtime implementation, scenario creation/execution, lint/typecheck/full check and live-provider calls: **not performed for this slice**. Documentation follows the explicit non-TDD exception in [testing policy](../../testing.md).

## Future runtime evidence

| Checkpoint | Relevant RED | GREEN / regression evidence | Review | Status |
| --- | --- | --- | --- | --- |
| A / OBS-001,002 | Pending | Pending | Pending | Not started |
| B / OBS-003,004,005 | Pending | Pending | Pending | Not started |
| C / OBS-006,007 | Pending | Pending | Pending | Not started |
| D / OBS-008,009 | Pending | Pending | Pending | Not started |
| E / OBS-010 | Pending | Pending | Pending | Not started |
| F / OBS-011 | Pending | Pending | Pending | Not started |

For every row record actual test names, exact commands, the meaningful failing assertion, passing result, source revision, OS/Node version and unresolved limitations. Record lint/typecheck/full check at the appropriate checkpoints. Never replace a pending entry with an expected result from scenarios.md.

## Future live compatibility: OBS-012

| Provider | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Codex | Pending | Pending | Pending |
| Cursor | Pending | Pending | Pending |
| OpenCode/Ollama | Pending | Pending | Pending |

Prior provider invocation proof in folders 10/11 does not establish this slice's telemetry, cost or exact-input capture. For each future cell, record explicit authorization, CLI/model/Nodulus versions, fixture-GREEN prerequisite, command/result, sanitized evidence references and observed completeness. Unsupported usage remains an accepted limitation, not a fabricated measurement. Actual billing reconciliation remains out of scope.

# INS scenarios and observable assertions

| ID | Production path | Observable acceptance |
| --- | --- | --- |
| INS-001 | `tests/scenarios/ins-001-inspect-workflow.test.ts`; public API and CLI `inspect workflow` | Captured graph, exact mappings/contracts/policies; shared runtime Ajv schemas and mapping rules; provider and validator sentinels remain absent. |
| INS-002 | `tests/scenarios/ins-002-inspect-run.test.ts`; public API and CLI `inspect run` | Success, needs_input, error and interrupted checkpoints explain events, calls, attempts, artifacts, validation and uncertainty. Uncertain calls block input advice; contradictory validation is diagnosed; repeated reads leave files unchanged. |
| INS-003 | `tests/scenarios/ins-003-export-run.test.ts`; API/CLI `inspect export` | Stable versioned output, safe schema/profile summaries, no raw private strings or absolute paths, deterministic repeated export, no source mutation. |
| INS-004 | `tests/scenarios/ins-004-replay-run.test.ts`; API/CLI `inspect replay` | Candidates checked against captured schemas; unknown contracts and engine/schema drift are explicit; provider and executable-validator sentinels remain untouched. |
| INS-005 | `tests/scenarios/ins-005-damaged-evidence.test.ts`; inspection/replay paths | Corrupt checkpoints, malformed events/responses and legacy engine versions produce diagnostics without guesses, rewrites or repairs. |
| INS-006 | `tests/scenarios/pkg-001-installed-archive.test.ts`; clean installed archive | Actual archive CLI and package API exercise all four commands against real projects/runs, including paths with spaces and Unicode; provider invocation count remains unchanged during inspection/replay. |

## Assertions to freeze before implementation

- Assert observable JSON fields and exit codes rather than source layout or private call order.
- Fixture profiles use a provider process that records any invocation and fails; offline paths must not create the record.
- Executable validator fixtures write a sentinel and fail; default replay must leave the sentinel absent.
- Snapshot the original run directory file hashes before and after every read/export/replay operation.
- Keep absent evidence `unknown`/`null` with a diagnostic; never equate schema validity with semantic correctness.
- This slice has no actionful replay mode. Executable validators are always skipped and named in the result; any trusted script execution requires a separate future design and scenario.

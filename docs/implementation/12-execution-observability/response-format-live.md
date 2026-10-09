# Windows evidence for explicit JSON responses

On 2026-10-08, Luna implemented explicit raw JSON instructions and a serialized exact artifact in the installed smoke request, after Sol accepted both focused RED checkpoints. Sol independently passed six runtime cases, PKG-015, and strict TypeScript validation, and accepted GREEN. Core source SHA-256 was `EE62119385914D0CA5D3BE307D59A18AA544213AD6E7A60C378ABD4750EC4A17`; installed helper SHA-256 was `AEB9E789E9DEBB87E43A30B4FF0D6A81F17DFFFFB6BAF5CC080AAD3D248DCA04`.

The coordinator ran opt-in installed smokes sequentially on Windows 10.0.26300 x64 and Node v24.15.0. Each passing run verified the installed CLI's run/status, exact accepted and saved artifact, one launched call, successful transport, captured request/stdin/telemetry, valid saved validation/result, and contained relative references before unconditional scratch cleanup.

| Provider | Recorded CLI version / requested model | Result | Reported input/output | Receipt |
| --- | --- | --- | --- | --- |
| Codex | 0.156.1 / `gpt-6-luna` | PASS, 1/1, 10.17 seconds | 20,899 / 47 | [Codex](live-evidence/2026-10-08-windows-codex-response-format.json) |
| Cursor | 2026.10.01-e373342 / provider default | PASS, 1/1, 12.44 seconds | 11,237 / 182 | [Cursor](live-evidence/2026-10-08-windows-cursor-response-format.json) |
| OpenCode/Ollama | 1.18.32 / `ollama/qwen3.5:9b`; Ollama 0.35.0 | PASS on one bounded retry, 9.99 seconds; first attempt failed | 1,304 / 235 on passing run | [OpenCode](live-evidence/2026-10-08-windows-opencode-response-format.json) |

All three successful receipts report coverage `complete`, reported model null, local archive version 1.0.0 and archive SHA-256 `c164ae83a6e56802a940585dfbbfc0adf60adad96a4ecffe8ad68d8ac82a9f9e`. This is the tested archive, not a new public version. Later receipt/document additions change packaged documentation. Provider-reported token counts retain their own semantics; normalized counters are null for Codex/Cursor and 1,304/235 for OpenCode. Reported cost is unknown for Codex/Cursor and zero for loopback OpenCode; these fields do not establish a bill.

OpenCode's first installed smoke failed 1/1 in 8.74 seconds. Its [sanitized classification](live-evidence/2026-10-08-windows-opencode-response-format-failure.json) records `RESPONSE_REPAIR_UNAVAILABLE` after a launched, completed transport with exit 0 and no timeout or output limit. The original rejected text was deleted, so its exact defect is unknown. One bounded diagnostic run using the same request/profile privately observed a valid JSON `success` response, valid validation and exact expected artifact values. One subsequent bounded installed-smoke retry passed; no source, model or profile change intervened. This mixed result is retained, rather than claiming every attempt passed or attributing the first failure to a specific cause.

The successful Cursor receipt reports a different version from the initial readiness probe (2026.09.23-86fc751). Earlier failed calls did not retain per-attempt version receipts. Comparisons do not establish that the prompt change alone caused the later pass.

Receipts contain only allowlisted metadata. Their relative references identify raw files checked before cleanup; raw prompts, provider output, credentials and profiles are not retained. Historical results remain in [the outcome-protocol follow-up](outcome-protocol-live.md). macOS/Linux live cells and folder 09 REL-003 external guard exercises remain open. Three-platform fixture CI is separate proof. No publication or merge was performed.

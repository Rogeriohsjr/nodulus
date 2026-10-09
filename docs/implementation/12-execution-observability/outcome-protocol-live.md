# Windows follow-up for the outcome prompt

On 2026-10-08, Luna implemented the prompt contract regression after Sol accepted the three-provider RED checkpoint. Sol accepted GREEN and independently passed the three focused scenarios and strict TypeScript check. The accepted core source SHA-256 was `331D8130AF7C2D67672CBB9CBD4EB0F7B17CAD84AAC135BB1E420D7102CE3870`. Local `npm run check` passed lint, typecheck, 324 runtime tests in 75 files, and 15 installed-archive tests.

The coordinator then ran each opt-in installed-archive smoke once, sequentially, on Windows 10.0.26300 x64 and Node v24.15.0. These results apply to that source checkpoint and those installed provider versions, not to other operating systems or later prompt changes.

| Provider | Version / requested model | Result | Observed evidence |
| --- | --- | --- | --- |
| Codex | 0.156.1 / `gpt-6-luna` | PASS, 1/1, 27.25 seconds | Installed run/status, exact artifact, successful transport, saved validation/result and capture references verified before cleanup. Reported input 20,844, output 47, reasoning 0; cost unknown. |
| Cursor | Initial readiness: 2026.09.23-86fc751 / provider default; per-attempt version not retained | FAIL, 1/1, 11.69 seconds | Completed transport with exit 0; installed workflow reported `RESPONSE_REPAIR_UNAVAILABLE`. |
| OpenCode/Ollama | 1.18.32 / `ollama/qwen3.5:9b`, Ollama 0.35.0 | FAIL, 1/1, 9.51 seconds | Installed workflow accepted the artifact; its message was `LIVE-opencode-artifact.` instead of the assertion's `LIVE-opencode-artifact`. The unquoted request placed a period directly after that marker. |

The [Codex receipt](live-evidence/2026-10-08-windows-codex.json) contains only the collector's allowlisted metadata. Archive version was 1.0.0, SHA-256 `8b29d62f4b5cd0193f0d253cc967676de205c6e61b39dfd6ba074ed6e77984d5`; run `94392832-feed-4fe8-9424-a045b8275e33`, call `b6c2e4c0-8fd9-41ea-80c6-760af112ab98`. Version 1.0.0 is the local source manifest version, not a new public release. Relative references describe files checked before scratch cleanup; the raw files are not retained. Reported token counters do not establish a charge.

One additional bounded Cursor diagnostic run used a fresh installed archive, the same profile and exact request, and privately inspected the owned saved run before unconditional cleanup. It reported `validation.valid: false`, `validation.code: INVALID_NODE_RESPONSE`, nonempty response, JSON parse failure, and both leading and trailing Markdown fence markers. Only known codes and structural booleans were exported; raw response, prompts, command arguments, credentials and validation messages were not exported. This establishes the response-format failure for this diagnostic run. It does not establish the cause of earlier replies deleted by the original harness.

Follow-up work will make the raw JSON format explicit and quote the exact live marker without weakening parsing or artifact assertions. The earlier Windows OpenCode/Ollama pass remains historical evidence in [evidence.md](evidence.md). macOS/Linux live cells and folder 09 REL-003 external guard exercises remain open.

The subsequent response-format implementation and live results are recorded in [the latest Windows evidence](response-format-live.md). They do not replace the outcomes above.

# P02: persist Codex's effective stdin

Run only after the coordinator accepts P01 RED and freezes its test hash. Phase: implementation. May edit ONLY `src/adapters/providers/default-provider-port.ts`. Do not change the accepted test, docs, settings or any other file.

Read `invokeCodex` in that file and `tests/scenarios/obs-001-codex-stdin.test.ts`.

Required behavior: after `transportPrompt` is assembled, and BEFORE the existing `runProcess(executable, args, ...)`, create a unique call directory under `path.join(cwd, ".nodulus", "runs", invocation.runId, "calls", callId)` and await writing stdin.txt in UTF-8 with exactly transportPrompt. Use Node's `randomUUID` for callId. Await mkdir/writeFile; existing async filesystem imports are already present. Let an I/O failure propagate before spawning rather than silently ignoring it.

Do not change argv, sandbox, response parsing, timeout, output limits, final message envelope, existing transport storage or other providers. Do not add metadata or metrics fields: those belong to later packets. This packet needs no new public provider-port API.

Run `npm run build`, `npx vitest run tests/scenarios/obs-001-codex-stdin.test.ts`, `npm run lint`, and `npm run typecheck`. Expected: one focused test GREEN, no lint/type errors. Report actual results and stop. Return one `dev-work.v1` result artifact with summary, changedFiles and validation only. Do not mark full OBS-001 complete or commit/push.

P01 correction, narrowed scope: ONLY verify persisted Codex stdin AFTER the call. Prelaunch timing is a later packet, not accepted here. Edit ONLY tests/scenarios/obs-001-codex-stdin.test.ts. No other edits.
Replace the incorrect test body with this sequence using the existing real helper:
1. const result = await runDefaultProviderCli(project, "Multiline text\nUnicode: Ω"); assert result.code equals 0.
2. const [call] = readProviderCalls(logPath). call.stdin is CONTENT, never a file path.
3. callsDir is path.join(project, ".nodulus", "runs", result.envelope.runId, "calls"). Use expect(existsSync(callsDir)).toBe(true). Missing callsDir is the expected RED. Never throw a harness-bug error for this missing feature.
4. Read directory entries in callsDir; assert exactly one entry. persistedPath = path.join(callsDir, entries[0], "stdin.txt"). Assert existsSync(persistedPath) true.
5. Read that file as UTF-8. Assert savedText === call.stdin, and that savedText contains "Multiline text", "Unicode: Ω" and "Codex transport envelope".
Import readdirSync from node:fs. Remove unused imports. Rename test title to "OBS-001 Codex persists exact effective stdin". Retain the helper cleanup in finally.
Run npm run build and npx vitest run tests/scenarios/obs-001-codex-stdin.test.ts. Expected one test fails at existsSync(callsDir), false expected true. Do not implement source. Return exact actual failure in dev-work.v1. No fixture rewrite is needed for this narrowed packet.

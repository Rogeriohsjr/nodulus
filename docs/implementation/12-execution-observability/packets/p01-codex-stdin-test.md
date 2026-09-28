# P01: write one Codex prelaunch stdin test

Phase: tests only. May edit ONLY `tests/scenarios/obs-001-codex-stdin.test.ts`. No source, docs, settings, skills or other test edits. Full OBS-001 is not this packet.

Read `tests/support/provider-adapter-scenarios.ts` and the first test in `tests/scenarios/prov-001-protocol-translation.test.ts`. Use `createProviderScenario("codex")`, `runDefaultProviderCli(project, request)` and `cleanupProviderProject(project)`; do not mock any internal module.

Requirement: Codex must save the exact final stdin to `.nodulus/runs/<run-id>/calls/<call-id>/stdin.txt` BEFORE spawning its inference process. The content includes the assembled node prompt AND `Codex transport envelope` suffix, not just the user's request text. A call ID is opaque: enumerate exactly one child directory rather than hardcoding an ID. No request.json metadata is required in this packet.

Fixture recipe:

1. Create the real temporary project using the helper. It creates `.nodulus/fixtures/codex-fixture.mjs` plus a real executable wrapper.
2. Overwrite ONLY that temporary generated script with a small Node .mjs fixture (inside the test's own project, not repository files). It must handle `--version` with a version string and `login status` with success without creating inference observations.
3. For `exec`, find `--output-last-message` in argv. Its value is `<run>/provider/example/attempt-001/last-message.txt`. Resolve the run root with `path.resolve(path.dirname(outputPath), "../../..")`.
4. At the start of the exec process, BEFORE reading stdin, inspect `<run>/calls`. Record whether it has exactly one child with stdin.txt, and read those bytes if present. Absence is recorded as false, not thrown, so the fixture still completes normally.
5. Read all actual stdin. Write an observation JSON file at `<project>/.nodulus/fixtures/observed-stdin.json`, containing the existence observation, saved text and received stdin. Use `process.cwd()` for project root.
6. Write the normal Codex last-message envelope to outputPath: outer object with `response` string containing a success outcome with artifact `name: example`, `contract: example.v1`, `data: {message: "fixture result"}`. Emit a simple JSONL `turn.completed` event to stdout, exit 0.

Test assertions (unconditional): run CLI exit 0 and accepted fixture result; observation indicates one pre-existing stdin file; saved text equals received stdin exactly; text includes the supplied multiline Unicode request AND Codex transport suffix. After the run, independently enumerate the run's calls directory and compare the persisted file too. Use the existing temporary project path with spaces/Unicode. Always clean it up with the existing helper.

Run `npm run build`, then `npx vitest run tests/scenarios/obs-001-codex-stdin.test.ts`. The expected RED is the assertion that a persisted stdin file existed when exec began: current product saves no such file. A syntax error, unknown variable, fixture crash or passing test is NOT RED. Fix harness errors, but leave product behavior unchanged.

Stop after actual RED. Report the exact command, exit/test count and failing assertion. Return one `dev-work.v1` result artifact using only summary, changedFiles and validation. Do not implement P02 or rewrite the requirement.

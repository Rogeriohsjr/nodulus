# 07-provider-adapters: Integrate Codex, Cursor and OpenCode

**Status:** Claude adapter and observed-usage parser are accepted by Sol; the local `npm run check` passes on Windows. A bounded installed-archive run captured Haiku success and a controlled Nodulus error with Claude Code CLI 2.1.295. Sonnet live smoke and macOS/Linux compatibility remain pending. **Prerequisite:** 06-repair-recovery. **Method:** TDD for adapters; live compatibility verification is separate.

A caller selects a supported installed provider without changing the workflow engine.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

See [adapter compatibility and settings](compatibility.md) for the explicit profile shape, process behavior, version checks, and unverified live compatibility.

## Acceptance scenarios

### PROV-001: Translate provider protocols

Given Codex and Cursor profiles, when equivalent workflows execute through their real adapters, then each receives supported arguments/context and its external response normalizes to the same internal protocol.

- [x] PROV-001 acceptance verified and evidence recorded.

### PROV-002: Handle discovery and authentication failures

Given missing executable, disabled profile, unsupported installed version, or auth failure, when doctor/run executes, then it reports an actionable error without guessing credentials or silently changing provider.

- [x] PROV-002 acceptance verified and evidence recorded.

### PROV-003: Handle portable process invocation

Given executable/project paths with spaces/Unicode and long input, when the adapter runs, then stdin/files/argv preserve data and Windows wrappers are handled without command interpolation.

- [x] PROV-003 acceptance verified and evidence recorded.

### PROV-004: Respect capabilities and usage

Given provider usage is missing or structured output/response-only correction is unsupported, when run executes, then capabilities govern behavior, unknown statistics remain null, and unsupported repair cannot replay actions.

- [x] PROV-004 acceptance verified and evidence recorded.

### PROV-005: Integrate Claude Code

Given a captured Claude profile and supported CLI, when a workflow invokes Claude, then readiness, bounded JSON transport, structured outcomes, safe options, and observed usage use the shared provider capture path; missing usage stays unknown and transport failures do not replay or start successor nodes.

- [x] PROV-005 current-main implementation source reviewed and accepted; historical acceptance evidence is retained in [evidence.md](evidence.md).
- [x] Bounded Windows Haiku smoke evidence captured with installed archive and Claude Code CLI 2.1.295 (success plus controlled Nodulus error).
- [ ] Sonnet live smoke and macOS/Linux compatibility verified; these cells remain pending.

### PROV-008: Select Cursor's final complete outcome

Given Cursor emits narration, tool progress and multiple assistant messages in stream-json, when the adapter normalizes its response, then it selects the final complete assistant text, requires a successful terminal result and process exit, and preserves transport and usage evidence.

- [x] PROV-008 acceptance verified and evidence recorded; live stream-json compatibility remains separate.

## Implementation guidance

Read current official provider documentation and installed --help before choosing flags. Record supported tool versions, OS support, protocol samples, authentication prerequisites and capabilities in an adapter compatibility document. Do not bake assumed flags into the core.
For deterministic tests launch actual local executable fixtures that emulate verified external protocol samples. Exercise the real adapters, parser and process runner. Fixtures prove our translation against the documented samples, not the current vendor service. Add separately authorized small live smoke checks for each provider/platform; report unsupported combinations explicitly.

## Developer sequence

- [x] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [x] Run it before implementation; record the relevant RED assertion.
- [x] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [x] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [x] Both real adapters pass all protocol variants with executable fixtures.
- [x] Record authoritative protocol sources and tested versions.
- [x] Record live smoke results or explicitly leave live verification pending; do not imply fixture proof is live proof.
- [x] Run available accumulated checks and record limitations.
- [x] Review public contracts/docs; update evidence and only then mark this folder complete in the index.

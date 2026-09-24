# 07-provider-adapters: Integrate Codex and Cursor

**Status:** not started. **Prerequisite:** 06-repair-recovery. **Method:** TDD for adapters; live compatibility verification is separate.

A caller selects either installed provider without changing the workflow engine.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### PROV-001: Translate provider protocols

Given Codex and Cursor profiles, when equivalent workflows execute through their real adapters, then each receives supported arguments/context and its external response normalizes to the same internal protocol.

- [ ] PROV-001 acceptance verified and evidence recorded.

### PROV-002: Handle discovery and authentication failures

Given missing executable, disabled profile, unsupported installed version, or auth failure, when doctor/run executes, then it reports an actionable error without guessing credentials or silently changing provider.

- [ ] PROV-002 acceptance verified and evidence recorded.

### PROV-003: Handle portable process invocation

Given executable/project paths with spaces/Unicode and long input, when the adapter runs, then stdin/files/argv preserve data and Windows wrappers are handled without command interpolation.

- [ ] PROV-003 acceptance verified and evidence recorded.

### PROV-004: Respect capabilities and usage

Given provider usage is missing or structured output/response-only correction is unsupported, when run executes, then capabilities govern behavior, unknown statistics remain null, and unsupported repair cannot replay actions.

- [ ] PROV-004 acceptance verified and evidence recorded.

## Implementation guidance

Read current official provider documentation and installed --help before choosing flags. Record supported tool versions, OS support, protocol samples, authentication prerequisites and capabilities in an adapter compatibility document. Do not bake assumed flags into the core.
For deterministic tests launch actual local executable fixtures that emulate verified external protocol samples. Exercise the real adapters, parser and process runner. Fixtures prove our translation against the documented samples, not the current vendor service. Add separately authorized small live smoke checks for each provider/platform; report unsupported combinations explicitly.

## Developer sequence

- [ ] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [ ] Run it before implementation; record the relevant RED assertion.
- [ ] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [ ] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [ ] Both real adapters pass all protocol variants with executable fixtures.
- [ ] Record authoritative protocol sources and tested versions.
- [ ] Record live smoke results or explicitly leave live verification pending; do not imply fixture proof is live proof.
- [ ] Run available accumulated checks and record limitations.
- [ ] Review public contracts/docs; update evidence and only then mark this folder complete in the index.


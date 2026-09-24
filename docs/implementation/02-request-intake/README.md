# 02-request-intake: Accept requests and reference files

**Status:** not started. **Prerequisite:** 01-initialize. **Method:** TDD.

A caller can submit short or long instructions with explicit context and receive a persisted run identity.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### REQ-001: Normalize three request sources

Given equivalent inline, UTF-8 file, and stdin requests, when run accepts each, then request.md and normalized inputs preserve the same text under distinct run IDs.

- [ ] REQ-001 acceptance verified and evidence recorded.

### REQ-002: Reject ambiguous or unreadable input

Given conflicting request flags, absent request source, or unreadable request file, when run starts, then it fails with an actionable error and never invokes a provider; errors before run creation have null runId.

- [ ] REQ-002 acceptance verified and evidence recorded.

### REQ-003: Resolve and capture references

Given snapshot and workspace references with spaces/Unicode in paths, when intake runs from another cwd, then manifest paths resolve against project root, CLI file paths against cwd, and paths/hashes/content policy are persisted.

- [ ] REQ-003 acceptance verified and evidence recorded.

### REQ-004: Reject broken definitions

Given missing instructions, invalid workflow schema, unknown profile, or invalid mapping, when preflight runs, then configuration failure is recorded and no provider is invoked.

- [ ] REQ-004 acceptance verified and evidence recorded.

### REQ-005: Preserve large context

Given a long brief and ordered instruction files, when intake captures them, then content is preserved without shell interpolation or silent truncation.

- [ ] REQ-005 acceptance verified and evidence recorded.

## Implementation guidance

Create workflow/node/config schemas, definition loading, request normalization and filesystem run creation. Save initial context and events. Missing required caller data is detected here; full pause/resume behavior is completed in 05. Structural preflight can reject malformed mappings now; full graph validation is extended in 04.
These tests call the production application intake entry point used by run; successful intake is an internal milestone, not a public terminal-success shortcut. Do not ship run claiming completion before node execution exists.

## Developer sequence

- [ ] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [ ] Run it before implementation; record the relevant RED assertion.
- [ ] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [ ] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [ ] REQ scenarios cover real files and exact preserved request text.
- [ ] Paths and hashes are asserted from disk; no filesystem mocks.
- [ ] Keep incomplete run command behavior explicit until slice 03.
- [ ] Run available accumulated checks and record limitations.
- [ ] Review public contracts/docs; update evidence and only then mark this folder complete in the index.


# 01-initialize: Initialize a project and discover configuration

**Status:** complete locally on Windows; INIT-002 through INIT-004 accepted by independent GPT-6 Sol review. **Prerequisite:** 00-foundation. **Method:** TDD, with preexisting GREEN recorded for INIT-002.

A person or agent can initialize a project, inspect available providers, and understand setup errors.

The INIT-001 scaffold contains no configured provider profile. Configure one before attempting to run the example workflow. `doctor` reports executable-path availability only; it does not test authentication/model readiness or launch provider commands.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### INIT-001: Create a usable project

Given an empty temporary project, when init runs, then settings, example workflow/node/instructions/contracts, and a runs ignore rule are created; help explains their use.

- [x] INIT-001 acceptance verified and evidence recorded.

### INIT-002: Preserve existing work

Given edited settings/instructions and an existing .gitignore, when init runs again, then existing content is preserved and only missing defaults/ignore entries are added.

- [x] INIT-002 acceptance verified and evidence recorded.

### INIT-003: Explain provider readiness

Given available, absent, and disabled provider profiles, when doctor runs, then it reports each state without invoking inference or inventing credentials/models.

- [x] INIT-003 acceptance verified and evidence recorded.

### INIT-004: Return machine-readable usage errors

Given unknown arguments or invalid JSON settings, when the command runs with --json, then it returns one error envelope and exit 1 without a stack trace or progress text on stdout.

- [x] INIT-004 acceptance verified and evidence recorded.

## Implementation guidance

Settings use `schemaVersion: 1`, a non-empty `defaultWorkflow` string, and a `providerProfiles` object keyed by name. Each profile requires `enabled: boolean` and `executable: string`; extra profile metadata is preserved. `doctor` reports enabled existing executables as available, disabled profiles as disabled, and missing executables as unavailable. An empty profile map is reported clearly. Doctor only checks local executable paths and `PATH`; it does not call them.

The JSON CLI envelope is `{schemaVersion:1,status,runId,result}`. Parser and settings errors return `status: "error"`, `runId: null`, and a result with a non-empty code and actionable message. Preserve the settings shape when adding fields; do not overwrite user's `.gitignore`. Example definitions are versioned fixtures and become executable in later slices.

## Developer sequence

- [x] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [x] Run it before implementation; record the relevant RED assertion.
- [x] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [x] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [x] Each INIT case has RED/GREEN evidence or explicitly recorded preexisting GREEN (INIT-002).
- [x] Run repeated init against real files and compare user-edited contents.
- [x] Verify stdout/stderr and help through the production parser.
- [x] Run available accumulated checks and record limitations.
- [x] Review public contracts/docs; update evidence and only then mark this folder complete in the index.

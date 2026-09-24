# Scenario-driven TDD

## Required loop

Write scenario and real fixtures -> run -> observe missing-behavior failure -> implement -> rerun -> refactor green.

Record RED before implementation. A test already passing documents existing coverage; do not break the product to manufacture RED. Missing runners, compilation errors, or unrelated import failures are setup issues, not acceptance failures. Do not label skipped tests RED.

Primary tests resemble E2E through the production entry point, replacing only uncontrolled external boundaries. In-process tests invoke the exported CLI handler with argv/streams and the real composition root except for the provider. Process tests invoke the compiled binary with local provider fixture executables. Both share production parsing, orchestration, persistence, and validation.

## Real components and permitted doubles

| Component | Treatment |
| --- | --- |
| Workflow, nodes, mappings, retries, pause/resume | Real |
| Markdown reader, JSON parsing, schema validation | Real |
| Request/reference files, checkpoints, JSONL logs | Real temporary filesystem |
| Project validation scripts and process runner | Real executable fixture scripts |
| CLI parsing, stdout/stderr and exit mapping | Real |
| External LLM inference/service | Scripted boundary fake returning raw responses |
| External provider executable in adapter tests | Local fixture process emulating its protocol; real adapter/runner |
| Future external database/service | Boundary fake only when introduced |
| IDs and time | Assert shape, ordering, ranges; avoid global time mocks |

Do not mock fs, RunStore, InstructionReader, ArtifactValidator, or process execution for convenience. A local script we control is exercised, not mocked. A fixture process replacing a provider represents the external tool boundary only.

## Fixture and assertion rules

Copy tracked fixtures into a fresh temporary project per test. Create actual Markdown instructions, workflow/node/profile JSON, schemas, requests, manifests, answers, raw response transcripts, and .mjs validator scripts. Use process.execPath for Node scripts.

Provider doubles must reject unexpected invocations. Capture requests to prove input mappings and repair feedback. Assert observable outcomes, accepted artifacts, diagnostic codes, real files, logs, and checkpoints. For failure paths assert later nodes were never invoked. Avoid private-method call sequences and source-text assertions.

Use fresh application instances for resume and at least one separate-process resume scenario. Simulate crash windows with controlled fixture processes and synchronization, not long sleeps. Include spaces/Unicode paths. Delete only temporary workspaces owned by the test.

## Planned commands

Slice 00 establishes `npm run typecheck`, `npm run build`, `npm run test:scenarios -- <test-file>`, and `npm run test:scenarios`. These foundation commands now exist. Slice 08 will add `npm run test:package`; package checks are not implemented yet.

Vitest does not replace type checking. After each slice, run focused tests and accumulated scenarios. Record platform/revision. A local Windows pass is not proof of macOS/Linux compatibility.

## Explicit exceptions

| Work | Why not behavioral TDD | Replacement verification |
| --- | --- | --- |
| Initial package/compiler/runner setup | No product entry point yet | Install, typecheck/build, temporary runner probe, remove probe |
| Docs and skill metadata | No runtime behavior | Links/consistency review and skill validation |
| Actions YAML, permissions and OIDC wiring | Hosted integration | Static validation where available plus actual hosted job evidence |
| Package ownership/registry settings | External administration | Verify authorized repository/package identity and configuration |
| Release notes/tag/publish wiring | External release integration | Dry run, then authorized release and registry/install verification |

Packaging/install behavior and custom release-decision logic DO require test-first development. Infrastructure is not a blanket exception. Dry runs do not prove hosted publishing.

## Evidence and completion

Each slice has evidence.md. For each scenario record test path/name, RED command and relevant assertion, GREEN command/outcome, revision, environment, and remaining live checks. Check boxes only when evidenced. Record setup failures separately and distinguish targeted reruns from full-suite results.

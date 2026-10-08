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

## Validation commands

Slice 00 establishes `npm run typecheck`, `npm run build`, `npm run test:scenarios`. These foundation commands now exist. Slice 08 separates `npm run test:package` from `npm run test:scenarios` because archive tests perform a clean build; `npm test` runs both sequentially. For one focused file, run `npm run build` followed by `npx vitest run tests/scenarios/<test-file>`; appending a file to the full scenario script does not narrow its existing directory argument.

`npm run check` is the final local quality gate: lint, typecheck, then the sequential runtime and package suites. See [code quality](code-quality.md) for rule scope and the AI handoff checklist. Use `npm run lint:fix` only for changes you will inspect.

Live provider smokes are separate because they install a freshly built local archive into an isolated prefix, require an authenticated provider CLI, and may consume provider usage. Each smoke uses the installed Nodulus CLI, a tiny known artifact request, captured request/transport/telemetry and validation records, and a bounded provider timeout. Every test is skipped unless its explicit flag equals `1`; live tests are outside `npm test` and `npm run check`. See the OBS-012 commands below.

### OBS-012 installed-archive provider smokes

Run one provider command at a time; each smoke rebuilds `dist` before packing:

- Codex (Windows): `$env:NODULUS_LIVE_CODEX='1'; $env:NODULUS_CODEX_EXECUTABLE='C:\Users\Admin\AppData\Roaming\npm\codex.cmd'; npm run test:live:codex`
- Cursor (Windows): `$env:NODULUS_LIVE_CURSOR='1'; $env:NODULUS_CURSOR_EXECUTABLE='agent'; npm run test:live:cursor`
- OpenCode/Ollama (Windows): `$env:NODULUS_LIVE_OPENCODE='1'; $env:NODULUS_LIVE_OPENCODE_CONFIG=(Resolve-Path 'opencode.json').Path; $env:NODULUS_LIVE_OPENCODE_MODEL='ollama/qwen-nodulus-coder:latest'; npm run test:live:opencode`

Portable environment names are `NODULUS_LIVE_CODEX` / `NODULUS_CODEX_EXECUTABLE` / optional `NODULUS_LIVE_CODEX_MODEL`, `NODULUS_LIVE_CURSOR` / `NODULUS_CURSOR_EXECUTABLE` / optional `NODULUS_LIVE_CURSOR_MODEL`, and `NODULUS_LIVE_OPENCODE` / `NODULUS_OPENCODE_EXECUTABLE` / `NODULUS_LIVE_OPENCODE_CONFIG` / optional `NODULUS_LIVE_OPENCODE_MODEL`. Set `NODULUS_LIVE_EVIDENCE` to write sanitized allowlisted evidence JSON. The Codex smoke uses a read-only sandbox, low reasoning effort, no extra capabilities, and an isolated Git repository. The OpenCode smoke accepts only an Ollama model served over loopback HTTP, denies tools and disables compaction. Optional missing usage remains null/unavailable.

On Windows, the verified standalone Codex executable is `C:\Users\Admin\AppData\Roaming\npm\codex.cmd` (0.156.1). The app-bundled 0.144.4 CLI may reject repository role configuration; use the standalone executable override when needed. Cursor `2026.09.23-86fc751` and OpenCode 1.18.32 with Ollama 0.35.0/model availability have been checked for readiness only; readiness is not live observability proof. Authenticated provider CLIs and supported local environments are required. Success evidence records package/archive hash, run/call IDs, provider/model and nullable reported model, CLI/Node/OS versions, coverage/counters, and relative references. If a live run fails and `NODULUS_LIVE_EVIDENCE` is set, the harness writes a separate `.failure.json` file containing only a fixed-schema stage/exit/status/error-code and run/call/request/transport availability summary. Envelope statuses are limited to `success`, `needs_input`, and `error`; unknown status values and unobserved filesystem/metric facts are null. It excludes envelope messages, stdout/stderr, argv, paths, profiles, prompts, credentials and raw transport contents. The failure code is selected from an allowlist; generic `PROVIDER_FAILURE` does not identify a vendor-specific cause. See [OBS-012 evidence](implementation/12-execution-observability/evidence.md) for the live compatibility matrix. Never infer macOS/Linux live compatibility from Windows results.

Vitest does not replace type checking. After each slice, run focused tests and accumulated scenarios. Record platform/revision. A local Windows pass is not proof of macOS/Linux compatibility.

## Explicit exceptions

| Work | Why not behavioral TDD | Replacement verification |
| --- | --- | --- |
| Initial package/compiler/runner setup | No product entry point yet | Install, typecheck/build, temporary runner probe, remove probe |
| Lint/tooling configuration and behavior-preserving lint cleanup | Static development tooling, not a new product behavior | Prove representative violations fail, remove probes, lint/typecheck and run accumulated scenarios; verify hosted lint jobs |
| Docs and skill metadata | No runtime behavior | Links/consistency review and skill validation |
| Actions YAML, permissions and OIDC wiring | Hosted integration | Static validation where available plus actual hosted job evidence |
| Package ownership/registry settings | External administration | Verify authorized repository/package identity and configuration |
| Release notes/tag/publish wiring | External release integration | Dry run, then authorized release and registry/install verification |

Packaging/install behavior and custom release-decision logic DO require test-first development. Infrastructure is not a blanket exception. Dry runs do not prove hosted publishing.

## Evidence and completion

Each slice has evidence.md. For each scenario record test path/name, RED command and relevant assertion, GREEN command/outcome, revision, environment, and remaining live checks. Check boxes only when evidenced. Record setup failures separately and distinguish targeted reruns from full-suite results.

The planned [execution observability slice](implementation/12-execution-observability/README.md) applies this policy to actual request capture, provider event fixtures, incomplete usage, cost provenance and fresh-process resume. OBS-001–005 now have real process fixtures and recorded RED/GREEN; OBS-006–012 remain planned. Offline fixtures are the required behavioral evidence; optional live-provider compatibility and actual billing are separate claims.

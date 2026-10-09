# Nodulus user guide

Nodulus runs ordered workflows whose outputs are checked against JSON Schema contracts. The `nodulus` CLI writes project definitions under `.nodulus/` and keeps run state under `.nodulus/runs/`.

## Install and upgrade

Use Node.js 24 and its bundled npm. The public package name is `@rogeriohsjr/nodulus`; the executable remains `nodulus`.

Version 1.0.0 is available on the [public npm registry](https://www.npmjs.com/package/@rogeriohsjr/nodulus). Install or upgrade with:

```sh
npm install --global @rogeriohsjr/nodulus@latest
nodulus --help
nodulus --version
```

For reproducible installs, replace `latest` with an exact published version. Nodulus does not update itself. Installing a new version leaves project definitions and saved runs in their project directories; resume still checks compatibility.

To install directly from a source checkout, build and pack locally:

```sh
npm ci
npm run build
npm pack
npm install --global ./rogeriohsjr-nodulus-1.0.0.tgz
```

Use the actual archive filename printed by `npm pack` when the checkout version changes.

## Initialize and configure a project

Run `nodulus init` in an empty project directory, or pass `--project <path>`. Initialization creates a starter example:

```text
.nodulus/settings.json
.nodulus/workflows/example.json
.nodulus/nodes/example.json
.nodulus/instructions/example.md
.nodulus/contracts/example.v1.schema.json
```

The `example.v1` contract requires an object with a non-empty `message` string. The example has an unconfigured provider profile so you can choose and authenticate the provider you intend to use before running it. Add a profile to `providerProfiles` in settings and set the example node's `providerProfile` to that profile name. The built-in Codex, Cursor, OpenCode and Claude Code adapters use `kind: "codex"`, `kind: "cursor"`, `kind: "opencode"` or `kind: "claude"`, `enabled: true`, and an `executable` path or command name. Authentication and local model configuration remain in the provider's own CLI/configuration; do not store credentials in Nodulus settings.

The Cursor adapter uses `agent -p --output-format stream-json` and the project workspace. It selects text from the last complete assistant message and requires a successful terminal result and process exit. Cursor's aggregate result text is not treated as the Nodulus outcome.

Use `nodulus doctor --json` to inspect settings and executable availability. The doctor check does not sign in or run a model.

## Run a workflow

```sh
nodulus run --workflow example --request "Summarize this document" --json
nodulus run --workflow example --request-file brief.md --references-file refs.json --json
nodulus run --workflow example --request-stdin --json
```

Machine output is one JSON envelope on stdout. Exit 0 means `success`, exit 2 means `needs_input`, and exit 1 means `error`. A successful result contains validated artifacts with their declared names and contracts. The runtime validates output schemas even when the provider supports structured output.

## Route bounded feedback

A workflow may declare a `feedbackRouting` region with a decision artifact, an allowlist of route codes, reentry-safe nodes, and positive safe-integer limits for iterations, provider calls, and elapsed time. A decision can re-enter an allowed node in that region or continue to the next workflow node. Earlier outputs are reused; outputs in the replayed suffix receive new generation identities. Review nodes should return the exact artifact references supplied by the runtime with their decision. Built-in CLI adapters check the persisted region deadline around version and authentication/model readiness and before inference dispatch; local child-process fixtures verify this behavior without live-provider calls.

The [normalization and review example](../examples/feedback-routing/README.md) shows a `FIX_TEXT` correction route followed by an `ACCEPT` continuation. Its local fixture demonstrates Unicode normalization, empty text, finite limits, and an installed-package runnable flow without contacting a model provider. Feedback routing is part of this source branch; use the branch build or a package release containing the feature.

## Inspect a workflow

This source change adds a read-only workflow inspection command and API. It reads the workflow, node, contract, instruction and settings files under the selected project and returns the resolved graph, mappings, declared contracts, and allowlisted effective profile policies. It does not start providers or validators, or create or change run records.

```sh
nodulus inspect workflow example --project . --json
```

The JSON response contains the inspection result or structured diagnostics for invalid and missing references. The public API is `inspectWorkflow(projectRoot, workflowId)`. When a Codex profile omits `sandbox`, inspection reports the effective default as `read-only`. This is configured policy data; inspection does not verify provider enforcement. This command is available from this source change and is not claimed in the published npm package.

## Inspect a saved run

Use the saved checkpoint and event evidence to explain a run without resuming it:

```sh
nodulus inspect run <run-id> --project . --json
```

The report includes status, attempts, provider-call evidence, accepted artifact references, validation evidence, uncertainty and conservative next actions. For routed runs it also reports the captured route policy, last selected route code and target, region budget counters, event-derived generation status, and whether each generation still matches its live artifact file. Active elapsed usage is marked as checkpoint-reported until completion evidence freezes it. Damaged generation or route evidence is diagnostic and is not listed as current. If the checkpoint is missing or unreadable, the result reports `status: "unavailable"` with diagnostics. An incomplete or possibly launched provider call blocks actions that could replay uncertain work.

The public API is `inspectRun(projectRoot, runId)`. Inspection only reads the run. It does not invoke providers or executable validators.

## Export a diagnostic

```sh
nodulus inspect export <run-id> --project . --json
```

Export returns a deterministic, versioned diagnostic envelope. It includes saved workflow metadata, attempts, timeline, artifact references and validation summaries. Routed runs add structural policy, last decision code/target, budget usage/reached flags, and generation metadata without feedback text or artifact contents. It omits request and caller-input text, instructions and prompts, provider responses, credentials, profile names/model identifiers/capabilities, schema literal values and annotations, and absolute machine paths. Captured contract schemas are represented by safe structural summaries. The source run is not changed. The public API is `exportRunDiagnostic(projectRoot, runId)`.

## Replay captured schemas offline

```sh
nodulus inspect replay <run-id> --project . --json
```

Replay revalidates saved provider candidates against the JSON Schemas captured with that run. For routed runs, it can label candidate attempts with their saved generation status; schema validity remains separate from route acceptance. It reports candidate results, contract and engine-version drift, and executable validators it skipped. It never starts a provider or project validator script; those external checks are not repeated. A candidate with an unknown or mismatched captured contract is reported as unknown rather than treated as valid or invalid. The public API is `replaySavedRun(projectRoot, runId)`.

These inspection, export and replay commands are included in this source revision and its tested package archive; they are not claimed to be available in the currently published npm package.

## Answer and resume

When a workflow returns `needs_input`, save its run ID, pending request ID, and requested answer contract. Write a JSON object satisfying that answer contract, then resume the same run:

```sh
nodulus status <run-id> --json
nodulus resume <run-id> --request-id <pending-request-id> --answers-file answers.json --json
```

The CLI returns immediately on clarification. It persists the pending request and accepted earlier work, and resume does not replay completed nodes. Use the ID returned by Nodulus; model-provided labels are not trusted as runtime IDs.

## Errors and saved runs

Errors use the same JSON envelope shape and include an actionable `code` and `message`. Errors that occur before a run is created have `runId: null`; errors during execution retain the run and attempt records for inspection with `nodulus status <run-id> --json`. Credentials are excluded from captured provider settings. Unknown usage and cost values are reported as `null`.

The project's `.nodulus/runs/` directory is generated state. Keep it out of source control unless your project deliberately needs to retain run history.

## Codex node execution policies

The development-workflow change adds Codex profile `sandbox` (`read-only` by default, or explicit `workspace-write`) and optional `reasoningEffort` (`minimal`, `low`, `medium`, `high`, `xhigh`). Supported effort still depends on the selected model. Nodulus captures these choices for resume and passes them to Codex with approval policy `never`; unsupported values fail before provider probes. No sandbox-bypass mode or arbitrary CLI argument list is accepted. These settings are not available in npm 1.0.1; use a release including this change or build this branch.

## OpenCode local execution

An OpenCode profile requires a complete model ID such as `ollama/qwen3.5:9b`. Nodulus verifies the OpenCode version and exact model listing before inference, sends the captured prompt on stdin, and runs with `--thinking`. It consumes raw JSON events only from the final assistant message whose `step_finish` reason is `stop`: text parts take precedence, with reasoning parts used only when that final message has no text. The selected content goes to the normal Nodulus outcome validator. If that validation rejects an OpenCode response with a captured session ID, a profile that explicitly lists `"capabilities": ["responseRepair"]` can request up to two corrections through the same session's `nodulus-response` agent; it saves each correction's transport separately and never replays the writing `build` invocation. Define that primary agent in the project's `opencode.json` with every tool denied, using the development-workflow example as the reference. OpenCode permissions are enforced by the project configuration; inspect them before allowing edits or shell commands. Nodulus rejects arbitrary provider argument arrays.

## Claude Code execution

Set `kind: "claude"` and the `executable` path or command in a provider profile. Nodulus checks the CLI version and `claude auth status` before a run, then sends the captured prompt on stdin in print mode with JSON structured output. Optional `model`, `maxTurns`, `maxBudgetUsd`, `tools`, and `safeMode` profile values are captured for resume; invalid turn/budget values stop before inference. When `tools` is the empty string, Nodulus also disables MCP configuration for that call. See [provider compatibility](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/implementation/07-provider-adapters/compatibility.md) for the supported flags and [Claude smoke example](https://github.com/Rogeriohsjr/nodulus/tree/main/examples/claude-smoke) for additive local setup. Run the example's copy commands from a Nodulus source checkout. A bounded Windows run with the installed archive and Claude Code CLI 2.1.295 captured Haiku success and a controlled inner Nodulus error. The CLI reported `$0.0007042` and `$0.000527845` respectively; these are usage estimates, not verified invoices. Fixture replays make no additional provider calls. Sonnet live smoke and macOS/Linux compatibility remain pending.

See the repository's [development example](https://github.com/Rogeriohsjr/nodulus/tree/main/examples/development-workflow) for test-author, test-review, implementation and final-review nodes. Workflow sequencing does not automatically repair rejected reviews or commit changes.


## Inspect effective requests and the timeline

OBS-001/002 are available in this source change; use a release containing it or build this branch. Each built-in provider inference call writes `.nodulus/runs/<run-id>/calls/<call-id>/request.json` and `stdin.txt` **before launch**. The stdin file contains the exact UTF-8 text sent after adapter instructions or repair feedback were added. If that persistence fails, inference does not start. Readiness/version probes are separate and are not model calls.

`request.json` records run/node/attempt/call identity, operation, parent repair call, profile ID, requested model, command arguments and cwd. Its run-relative `refs` link the base prompt, effective stdin, call transport, raw response, validation, invocation and accepted attempt result. A result ref is an expected location: failed/invalid attempts need not have an accepted `result.json`. `transport.json` records bounded stdout/stderr, exit/timeout/output-limit diagnostics and elapsed time. Existing `provider/` records remain available. The new metadata does not serialize environment variables or arbitrary profile fields; prompt/output content is preserved as supplied and can contain sensitive data.

Every newly written `events.jsonl` record has a UTC ISO timestamp and an increasing per-run sequence. Order by sequence. `provider.call.started`, `provider.call.completed` and `node.validation.completed` join on `callId`; response-only repairs have their own IDs, logical attempts and parent IDs. Resume continues the sequence without rewriting older events. A completed call means the provider boundary returned or threw, not that its artifact passed validation. Its `failed` flag describes a thrown/invalid-return boundary failure; inspect validation and terminal outcomes separately. Core timing includes the adapter/readiness work; transport timing measures the child process, not model compute time.

Use these files directly for detailed inspection. OBS-003–009 save call-level telemetry and expose coverage-aware status summaries, including interrupted and resumed calls. Optional OBS-010 pricing captures a validated rate card at intake and reports reproducible estimates separately from provider-reported cost; see [provider usage](provider-usage.md). A custom ProviderPort gets optional call IDs/events but must implement its own transport capture and verified telemetry to qualify for estimates. Do not commit generated runs or treat logs as the authoritative resume checkpoint.

## Plan and implement small tasks

Use [the task workflow guide](task-workflow.md) for `nodulus-task setup`, repository context manifests, local Qwen planning, reviewed-test selection, execution and receipts. This is a supervised workflow; failed phases require bounded recovery and independent review.

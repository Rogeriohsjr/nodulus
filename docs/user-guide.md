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

The `example.v1` contract requires an object with a non-empty `message` string. The example has an unconfigured provider profile so you can choose and authenticate the provider you intend to use before running it. Add a profile to `providerProfiles` in settings and set the example node's `providerProfile` to that profile name. The built-in Codex, Cursor and OpenCode adapters use `kind: "codex"`, `kind: "cursor"` or `kind: "opencode"`, `enabled: true`, and an `executable` path or command name. Authentication and local model configuration remain in the provider's own CLI/configuration; do not store credentials in Nodulus settings.

Use `nodulus doctor --json` to inspect settings and executable availability. The doctor check does not sign in or run a model.

## Run a workflow

```sh
nodulus run --workflow example --request "Summarize this document" --json
nodulus run --workflow example --request-file brief.md --references-file refs.json --json
nodulus run --workflow example --request-stdin --json
```

Machine output is one JSON envelope on stdout. Exit 0 means `success`, exit 2 means `needs_input`, and exit 1 means `error`. A successful result contains validated artifacts with their declared names and contracts. The runtime validates output schemas even when the provider supports structured output.

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

See the repository's [development example](https://github.com/Rogeriohsjr/nodulus/tree/main/examples/development-workflow) for test-author, test-review, implementation and final-review nodes. Workflow sequencing does not automatically repair rejected reviews or commit changes.

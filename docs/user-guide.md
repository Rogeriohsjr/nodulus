# Nodulus user guide

Nodulus runs ordered workflows whose outputs are checked against JSON Schema contracts. The `nodulus` CLI writes project definitions under `.nodulus/` and keeps run state under `.nodulus/runs/`.

## Install locally

This repository package is still private and uses the local placeholder name `nodulus`. For a local install, build and pack it from the checkout, then install that archive:

```sh
npm run build
npm pack
npm install --global ./nodulus-0.0.0.tgz
nodulus --help
nodulus --version
```

To upgrade a local install, install the new tarball explicitly. Nodulus does not update itself. Once an owned npm scope and public release are configured, the intended install forms are `npm install --global @<your-scope>/nodulus@latest` for the newest published version or `npm install --global @<your-scope>/nodulus@1.2.3` to pin an exact version. These are placeholders for a future package-ownership decision; this private package is not available from the public registry.

## Initialize and configure a project

Run `nodulus init` in an empty project directory, or pass `--project <path>`. Initialization creates a starter example:

```text
.nodulus/settings.json
.nodulus/workflows/example.json
.nodulus/nodes/example.json
.nodulus/instructions/example.md
.nodulus/contracts/example.v1.schema.json
```

The `example.v1` contract requires an object with a non-empty `message` string. The example has an unconfigured provider profile so you can choose and authenticate the provider you intend to use before running it. Add a profile to `providerProfiles` in settings and set the example node's `providerProfile` to that profile name. The built-in Codex/Cursor adapters use `kind: "codex"` or `kind: "cursor"`, `enabled: true`, and an `executable` path or command name. Authentication remains in the provider's own CLI; do not store credentials in Nodulus settings.

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

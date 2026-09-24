# Architecture and protocol

Status: v1 contract; folders 00 through 08 are implemented and reviewed, with hosted Windows/macOS/Linux validation. The implementation index records deferred publication and live-provider proof. Update affected scenarios before changing this contract.

## Scope and stack

TypeScript strict mode, supported Node.js LTS (select and record in slice 00), npm, Commander, Ajv/JSON Schema, Vitest, GitHub Actions, semantic-release. Distribute compiled JavaScript and declarations. One package initially, exporting an application API and a CLI binary.

```text
CLI / future UI -> application core -> domain contracts and ports
composition root -> concrete adapters implementing the ports
```

Suggested source layout: `src/cli`, `src/core/{workflow,nodes,artifacts,execution,ports}`, `src/adapters/{llm,instructions,storage,validation}`, `src/system-contracts`. Core code never imports concrete adapters. Ports: Provider, InstructionReader, RunStore, ArtifactValidator. Add methods only as scenarios need them.

Sequential execution is ordinary code. Dynamic graphs, LLM supervisors, parallel nodes, remote databases, UI, and MCP servers are outside v1.

## Domain

- nInstruction: one or more ordered Markdown files per node.
- nArtifact: named data governed by a versioned JSON Schema, optionally checked by a real validation script.
- nNode: provider profile reference, instructions, named input mappings, expected outputs.
- nWorkflow: ordered nodes mapping workflow inputs or earlier accepted artifacts into later inputs.
- Provider profile: named tool/executable, model, enabled flag, capabilities, and timeout. Changing a profile affects new runs; existing runs retain their resolved configuration.
- System outcome: exactly `success`, `needs_input`, or `error`; these names replace earlier draft synonyms. Package-owned system contracts cannot be overridden by project contracts.

## CLI baseline

Commands: `init`, `doctor`, `run`, `status`, `resume`, `--help`, `--version`.
`--project <path>` is explicit; otherwise find the nearest ancestor with `.nodulus/settings.json`. Init defaults to cwd.

```text
nodulus run --workflow example --request "Short task" --json
nodulus run --workflow example --request-file brief.md --references-file refs.json --json
nodulus run --workflow example --request-stdin --json
nodulus status <run-id> --json
nodulus resume <run-id> --request-id <id> --answers-file answers.json --json
```

Workflows may also declare named caller inputs as `inputs: {goal: {contract: "goal.v1"}}`. Supply these separately through the application `callerInputs` object or CLI `--inputs-file values.json`. Missing/invalid declared caller data produces a persisted clarification before any node invocation; request text remains a separate required source.

Node input mappings use `{from: "request"}`, `{from: "caller.goal", contract: "goal.v1"}`, or `{from: "analyze.findings", contract: "finding.v1"}`. Prior-artifact mappings require an exact matching declared contract ID. References match declared node/output pairs, including dotted names; ambiguous pairs fail preflight. An empty mapping supplies no inputs. Each node gets its own instructions and only its mapped input values.

Exactly one request source. CLI file arguments resolve against caller cwd; manifest entries and definition paths resolve against project root. Read UTF-8 text. Never silently truncate required instructions/context.

Machine mode returns immediately on clarification. One JSON object on stdout; diagnostics on stderr. Exit 0 = success, 2 = needs_input, 1 = error, including usage/configuration failures. Normalize parser errors when `--json` is present.

CLI envelope: `{schemaVersion:1,status,runId:string|null,result}`. Errors before run creation have null runId. Runtime assigns trusted identity and source metadata; do not trust model-supplied identity.

Provider proposal shapes:

```text
success: {status:"success",artifacts:[{name,contract,data}]}
needs_input: {status:"needs_input",request:{id,questions:[{id,message}],answerContract}}
error: {status:"error",error:{code,message}}
```

Slice 03 implements the exact schemas and additional-property policy. Validate outcome first, then expected artifact names/contracts/data and script checks. Reject missing, duplicate, and unexpected output names. Contract IDs are versioned (e.g. review.v1); normal validation does not fetch remote schemas.

## Execution

Run states: running, needs_input, success, error. Track active node, attempts, completed nodes, and accepted outputs. Persist before advancing or returning.

Default budget: one initial execution plus two response-only corrections. Save all raw responses and validation reports. Corrections must not replay tool actions; if the provider cannot support response-only correction, return an actionable error instead of retrying a full agent execution.

Schema validity does not establish semantic correctness. A review artifact with pass=false may be valid; an explicit business check determines whether that prevents progression.

Missing caller data creates a pending request with an answer contract. Missing predecessor outputs are configuration/execution defects, not user questions. Validate request ID and answers before mutating a paused run. Pending request IDs are runtime-generated; use the returned saved ID rather than a model-provided label. Accepted answers are saved by request ID, with subsequent clarifications receiving fresh IDs. Never replay completed nodes. A crashed attempt with uncertain side effects requires explicit recovery, not automatic re-execution.

## Persistence

Version definitions under `.nodulus/{settings.json,workflows/,nodes/,instructions/,contracts/,validators/}`. Ignore generated runs in Git.

```text
.nodulus/runs/<run-id>/
  run.json
  events.jsonl
  request.md
  inputs.json
  references.json
  context/
  nodes/<node-id>/attempt-001/
    invocation.json
    prompt.md
    response.raw.txt
    stderr.log
    validation.json
    result.json
  nodes/<node-id>/artifacts/
  pending/
  answers/
  result.json
```

run.json is the checkpoint; logs alone cannot resume a run. Use atomic same-directory state replacement and exclusive per-run locking. Terminal result.json exists only after success/error. A pause lives in run.json and pending/. Attempt result.json records only an accepted outcome.

Capture definitions, instructions, schema/engine versions, and resolved configuration. References choose snapshot or workspace mode. Save paths and hashes; detect changed workspace references on resume and require an explicit decision rather than silently adopting changes.

Record elapsed time, available usage/cache counts, and costs. Unknown metrics are null; estimates identify pricing provenance. Keep credentials out of captured configuration/logs. Diagnose an incomplete trailing JSONL line without treating it as checkpoint corruption.

## Platform and version compatibility

Windows/macOS are primary; test Linux too. Use Node path/process APIs and argument arrays, no bash-only runtime dependency. Exercise spaces, Unicode, executable wrappers, cancellation, timeout, and child cleanup.

Engine and schema versions are separate. Resume checks compatibility and provider availability without adopting current profile changes. Unsupported formats fail clearly; no silent migration or overwrite.

## Design provenance

This portable handoff consolidates the user's Nodulus module notes, execution canvas, and Design workflow orchestration discussion. No private vault/chat access is required to implement it.
References: [TypeScript](https://www.typescriptlang.org/tsconfig/strict.html), [Commander](https://github.com/tj/commander.js), [Ajv](https://ajv.js.org/), [Vitest](https://vitest.dev/guide/).

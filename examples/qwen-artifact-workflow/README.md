# Supervised local Qwen artifact workflow

This repository-specific example records the working alternative used to finish OBS-001/002. Qwen returns source as a validated artifact; the coordinator inspects and applies it, runs fixed tests and requests independent review. It does not automatically apply files, run tests, or advance a rejected review. The existing tool-writing [development workflow](../development-workflow/README.md) remains separate.

Use a dedicated checkout with Node 24, OpenCode 1.18.32 and Ollama. The observed Windows machine already had `qwen2.5-coder:14b`; this example creates an alias with a 16K context and an 8192 output-token cap. These are measured local choices, not required Nodulus defaults. Creating the alias requires that base model to be installed; no model download is part of the workflow.

```sh
ollama create qwen-nodulus-coder -f examples/qwen-artifact-workflow/Modelfile
```

Inspect and merge this example's `.nodulus/` definitions and `opencode.json` into the worktree root. Preserve other workflows/settings. Only Ollama is enabled; both the main and auxiliary model are local, and the endpoint is `http://127.0.0.1:11434/v1`. Both OpenCode agents deny every tool. JSON-object mode improves syntax but does not guarantee contract or code correctness. Verify the endpoint/model with `opencode models ollama` and Ollama's local `/api/ps` response during a call.

The `file-changes.v1` path enum is deliberately scoped to the OBS-001 helper as an example. Before each assignment, set it to the actual allowed file paths. Supply a small request file containing the requirement, current source, exact helper signatures, fixed test command, expected RED or correction evidence and a complete outcome example. Never assume the tool-denied model can read the repository. For generated files, request plain source inside `content`, without Markdown fences. The `edits` variant requires exact old text that matches once.

```sh
node dist/bin.js run --workflow qwen-artifact --request-file .nodulus/requests/packet.md --json
node dist/bin.js run --workflow qwen-review --request-file .nodulus/requests/review.md --json
```

Build this branch first or use an installed version with these features. Run one workflow at a time. Each workflow uses one primary local call and permits at most two response-only envelope repairs. Model output caps and timeout constrain each call, not the total workflow budget. Set an explicit coordinator call budget before dispatch and reassess repeated failure.

A success status means the artifact matched its contract. Independently verify allowed paths, unchanged base hashes, no source fences, imports, test semantics and actual RED/GREEN before accepting or applying it. Apply only reviewed contents in the isolated checkout. Preserve the raw rejected artifact and record any coordinator corrections separately. The checked-in example intentionally provides no automatic apply command: a safe product version needs path confinement, stale-base detection and atomic application tests.

For review, supply the accepted diff/source and actual check evidence; the reviewer has no filesystem access. Read `decision` and `findings`: a schema-valid `changes_required` artifact is a rejected review even though the Nodulus run succeeded. A separate GPT-5.6 Sol checkpoint performs final code review under the user's existing authorization; this example contains no automatic cloud call.

See the [task-packet skill](../../.agents/skills/nodulus-task-packets/SKILL.md) and [execution report](../../docs/implementation/12-execution-observability/qwen-execution-report.md). Full prompts/transports stay in the local run store, outside source control.

## Documentation after implementation

After checks pass, run `node dist/bin.js run --workflow qwen-document --request-file .nodulus/requests/documentation.md --json`, then apply the same independent review before saving its contents. Supply accepted source behavior and exact evidence. This dedicated node uses a single full-content artifact representation, with one explicitly allowed Markdown path (`docs/provider-usage.md` in this example). Change the contract's allowed path for another assignment. It cannot write files itself. In OBS-003–005, both documentation calls produced valid artifacts, but their prose still required factual corrections; see the [hiccup history](../../docs/implementation/12-execution-observability/qwen-hiccups.md).

The tool-writing example now chains documentation between implementation and both reviews. The artifact example keeps dispatch/application supervised until a tested generic applicator exists. Neither a schema-valid document nor a nonempty file proves its claims.

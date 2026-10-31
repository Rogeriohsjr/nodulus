# Nodulus

An open-source TypeScript CLI for LLM workflows with validated artifacts and resumable execution.

Install the [public npm package](https://www.npmjs.com/package/@rogeriohsjr/nodulus) with Node.js 24:

```sh
npm install --global @rogeriohsjr/nodulus@latest
nodulus --version
nodulus --help
```

For project setup and usage, see the [Nodulus user guide](docs/user-guide.md).

Status: folders 00 through 08 are implemented and independently reviewed: initialization, request capture, validated node outcomes, sequential workflows, persisted pause/resume, bounded repair/crash detection, Codex/Cursor adapters, and local package installation/upgrades. Hosted Windows, macOS and Linux checks exercise the scenario and package install/upgrade suites. The public package identity is `@rogeriohsjr/nodulus`; release and registry validation status is recorded in folder 09. The generated project has no configured provider. Adapter tests use real local fixture executables; Codex, OpenCode/Ollama, and Cursor have separate Windows live proof, while macOS/Linux live-provider compatibility remains pending.

The source checkout also includes reviewed bounded feedback routing and read-only inspection/export/replay. Schema-version-2 workflows add bounded concurrent branches, artifact joins, independent terminal paths, named outputs and durable multiple-question resume. All parallel phases have independent local acceptance; the complete Windows quality gate passed644 runtime and19 installed-package tests. Earlier phase heads passed hosted validation, while the final example head and integration still require fresh platform checks. See the [parallel checkpoint evidence](https://github.com/Rogeriohsjr/nodulus/blob/426e74f2a79152c8a150a3182df13c2c9f36764b/docs/implementation/16-parallel-workflows/phase5-evidence.md) for exact results and limits. Source and archive validation are separate from package publication.

Try the [parallel review example](examples/parallel-review/README.md) from a locally built archive. It demonstrates concurrent reviews, a join, an independent audit path and ordered outputs through the installed CLI.

For schema-version-2 graph runs, `getRunStatus` returns `pendingRequests` after verifying a stable saved pause. Caller-input questions come first, followed by node questions in workflow declaration order; `pendingRequest` is the first item for compatibility. Answered questions remain in checkpoint history. Other graph states return an empty list. Corrupt pause evidence raises `RUN_STATE_INVALID`, and `inspectRun` reports it as unavailable. Inspection retains uncertainty actions when provider-call evidence is incomplete. These reads use saved evidence without running providers or executable validators.

`inspectRun` also verifies accepted graph artifact references while other branches are running and after completion. Its artifact list follows captured node/output declaration order and checks saved hashes, schemas, validation, invocation and ordered call/acceptance events. For nonpaused graph snapshots, a corrupted accepted node receives a diagnostic while independently verified nodes remain visible. Raw checkpoint phases stay separate from verified artifact acceptance. Contradictory saved routing evidence retains the existing conservative artifact suppression.

Recovery inspection names nodes with unresolved provider completion or unverified process cleanup and selects safe actions that do not replay uncertain calls. Required node outputs must always be valid artifacts; a contract can represent an empty result or no findings. A node error or failed required validation closes admission of later work.

Start with the [implementation sequence](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/implementation/README.md). Each numbered folder contains scenarios, implementation guidance, checkboxes, and an evidence record.

- [User scenarios](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/user-scenarios.md)
- [Architecture](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/architecture.md)
- [Code quality and AI checklist](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/code-quality.md)
- [Testing policy](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/testing.md)
- [Codex guidance](https://github.com/Rogeriohsjr/nodulus/blob/main/AGENTS.md)
- [Skill usage and developer assignment examples](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/codex-skills.md)

Repository skills: `$nodulus-scenario-tdd` and `$nodulus-delivery-validation`.

For development, use Node.js 24, run `npm ci`, then `npm run check` to run lint, typecheck, scenarios and package checks.

For a local bounded feedback-routing walkthrough, see [the normalization and review example](examples/feedback-routing/README.md). It uses a controlled child-process fixture and the exported API without calling a live provider.

## Contribute and license

Issues and pull requests are welcome. See the [contribution guide](https://github.com/Rogeriohsjr/nodulus/blob/main/CONTRIBUTING.md) for the development workflow and test expectations.

Copyright 2026 Rogeriohsjr and Nodulus contributors. Licensed under [Apache-2.0](LICENSE), with attribution in [NOTICE](NOTICE). You may use, copy, modify and redistribute this project under those terms.

## Develop with Nodulus

The [development workflow example](https://github.com/Rogeriohsjr/nodulus/tree/main/examples/development-workflow) connects an OpenCode/Qwen test author, Luna test reviewer, OpenCode/Qwen implementer and GPT-5.6 Sol final reviewer. An actual `npm run check` validator gates completion. A separate verification workflow checks existing work, and escalation is optional. See the example for isolated-worktree setup, required CLI versions and live-validation limitations.

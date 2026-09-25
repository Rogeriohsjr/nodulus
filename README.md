# Nodulus

An open-source TypeScript CLI for LLM workflows with validated artifacts and resumable execution.

For local package installation and usage, see the [Nodulus user guide](docs/user-guide.md).

Status: folders 00 through 08 are implemented and independently reviewed: initialization, request capture, validated node outcomes, sequential workflows, persisted pause/resume, bounded repair/crash detection, Codex/Cursor adapters, and local package installation/upgrades. Hosted Windows, macOS and Linux checks exercise 115 scenario tests and package install/upgrade tests. The public package identity is `@rogeriohsjr/nodulus`; release and registry validation status is recorded in folder 09. The generated project has no configured provider; adapter tests use real local fixture executables, with live vendor compatibility unverified.

Start with the [implementation sequence](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/implementation/README.md). Each numbered folder contains scenarios, implementation guidance, checkboxes, and an evidence record.

- [User scenarios](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/user-scenarios.md)
- [Architecture](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/architecture.md)
- [Code quality and AI checklist](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/code-quality.md)
- [Testing policy](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/testing.md)
- [Codex guidance](https://github.com/Rogeriohsjr/nodulus/blob/main/AGENTS.md)
- [Skill usage and developer assignment examples](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/codex-skills.md)

Repository skills: `$nodulus-scenario-tdd` and `$nodulus-delivery-validation`.

For development, use Node.js 24, run `npm ci`, then `npm run check` to run lint, typecheck, scenarios and package checks.

## Contribute and license

Issues and pull requests are welcome. See the [contribution guide](https://github.com/Rogeriohsjr/nodulus/blob/main/CONTRIBUTING.md) for the development workflow and test expectations.

Copyright 2026 Rogeriohsjr and Nodulus contributors. Licensed under [Apache-2.0](LICENSE), with attribution in [NOTICE](NOTICE). You may use, copy, modify and redistribute this project under those terms.

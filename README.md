# Nodulus

A TypeScript CLI under development for LLM workflows with validated artifacts and resumable execution.

For local package installation and usage, see the [Nodulus user guide](docs/user-guide.md).

Status: folders 00 through 08 are implemented and independently reviewed on Windows: initialization, request capture, validated node outcomes, sequential workflows, persisted pause/resume, bounded repair/crash detection, Codex/Cursor adapters, and local package installation/upgrades. The generated project has no configured provider; adapter tests use local fixture executables, with live vendor compatibility unverified. Hosted cross-platform verification and release preparation are tracked in the implementation sequence below.

Start with the [implementation sequence](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/implementation/README.md). Each numbered folder contains scenarios, implementation guidance, checkboxes, and an evidence record.

- [User scenarios](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/user-scenarios.md)
- [Architecture](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/architecture.md)
- [Testing policy](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/testing.md)
- [Codex guidance](https://github.com/Rogeriohsjr/nodulus/blob/main/AGENTS.md)
- [Skill usage and developer assignment examples](https://github.com/Rogeriohsjr/nodulus/blob/main/docs/codex-skills.md)

Repository skills: `$nodulus-scenario-tdd` and `$nodulus-delivery-validation`.

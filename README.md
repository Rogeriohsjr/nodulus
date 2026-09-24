# Nodulus

A TypeScript CLI under development for LLM workflows with validated artifacts and resumable execution.

Status: folders 00 through 07 are implemented and independently reviewed on Windows: initialization, request capture, validated node outcomes, sequential workflows, persisted pause/resume, bounded repair/crash detection, and Codex/Cursor adapters. The generated project has no configured provider; adapter tests use local fixture executables, with live vendor compatibility unverified. Packaging and hosted cross-platform verification are tracked in the implementation sequence below.

Start with [the implementation sequence](docs/implementation/README.md). Each numbered folder contains scenarios, implementation guidance, checkboxes, and an evidence record.

- [User scenarios](docs/user-scenarios.md)
- [Architecture](docs/architecture.md)
- [Testing policy](docs/testing.md)
- [Codex guidance](AGENTS.md)
- [Skill usage and developer assignment examples](docs/codex-skills.md)

Repository skills: `$nodulus-scenario-tdd` and `$nodulus-delivery-validation`.

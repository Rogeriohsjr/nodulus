# Nodulus

A TypeScript CLI under development for LLM workflows with validated artifacts and resumable execution.

Status: folders 00 through 06 are implemented and independently reviewed on Windows: initialization, request capture, validated node outcomes, sequential workflows, persisted pause/resume, and bounded repair/crash detection. The generated project has no configured provider; current execution tests supply an external-provider fake. Vendor adapters, packaging, and hosted cross-platform verification are tracked in the implementation sequence below.

Start with [the implementation sequence](docs/implementation/README.md). Each numbered folder contains scenarios, implementation guidance, checkboxes, and an evidence record.

- [User scenarios](docs/user-scenarios.md)
- [Architecture](docs/architecture.md)
- [Testing policy](docs/testing.md)
- [Codex guidance](AGENTS.md)
- [Skill usage and developer assignment examples](docs/codex-skills.md)

Repository skills: `$nodulus-scenario-tdd` and `$nodulus-delivery-validation`.

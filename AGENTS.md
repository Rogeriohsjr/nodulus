# Working on Nodulus

Read [the sequence](docs/implementation/README.md), [architecture](docs/architecture.md), and [testing policy](docs/testing.md) before implementation.

- Work on the requested numbered folder. Verify prerequisites; do not silently implement later folders.
- Use [.agents/skills/nodulus-scenario-tdd/SKILL.md](.agents/skills/nodulus-scenario-tdd/SKILL.md) for runtime behavior and regression fixes.
- Use [.agents/skills/nodulus-delivery-validation/SKILL.md](.agents/skills/nodulus-delivery-validation/SKILL.md) for bootstrap, packaging, CI, and release work.
- Write a scenario test, observe its relevant failure, then implement and refactor. Missing runners, syntax errors, and unrelated import failures are not behavioral RED evidence.
- Exercise production entry points and real internal modules. Use real temporary files, schemas, Markdown, and child-process fixture scripts. Replace only external LLM/service boundaries.
- Core code must not depend on CLI formatting or concrete provider/storage implementations. Scenario tests still exercise those real internal adapters.
- Mark checkboxes only with recorded evidence. Keep local, hosted, and live-provider proof distinct.
- Non-TDD exceptions are item-specific in docs/testing.md and still require verification.
- These plans do not authorize publishing, creating external releases, or paid/live provider calls. Follow current task authorization.
- Preserve unrelated changes. Do not edit the original Obsidian notes as a side effect of repository work.
- For authorized builder/reviewer work, follow [the low-usage agent workflow](docs/agent-workflow.md): Luna builder, Sol reviewer, and stable, focused review checkpoints.

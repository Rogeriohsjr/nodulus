# Codex implementation skills

For coordinated builder/reviewer work, use [the low-usage agent workflow](agent-workflow.md). The builder uses Luna and the reviewer uses Sol at focused checkpoints.

The repository includes two portable skills under `.agents/skills`, the repository skill location documented by [OpenAI](https://learn.chatgpt.com/docs/build-skills).

- [nodulus-scenario-tdd](../.agents/skills/nodulus-scenario-tdd/SKILL.md): runtime slices and regressions, observed RED/GREEN, real local components, only external boundary doubles.
- [nodulus-delivery-validation](../.agents/skills/nodulus-delivery-validation/SKILL.md): bootstrap, installed-package checks, CI/release verification, and explicit non-TDD exceptions.

Assign a folder and skill together, for example:

```text
Use $nodulus-scenario-tdd to implement docs/implementation/05-clarification-resume.
Verify prerequisite evidence. Follow each scenario test-first and update the
folder's evidence and checkboxes. Stop before the next folder.
```

For the initial assignment use `$nodulus-delivery-validation` with `docs/implementation/00-foundation`.
If the current Codex session has not discovered the new skills, open their SKILL.md files explicitly; they contain the same procedure. These files guide development of Nodulus, not the provider agents executing a user's workflow.

# Contributing to Nodulus

Bug reports, documentation improvements and pull requests are welcome. For a substantial feature or architecture change, open a GitHub issue first so we can agree on the user scenario and scope.

## Develop and verify

Use Node.js 24. Fork the repository, create a branch, and run:

```sh
npm ci
npm run check
```

Read [AGENTS.md](AGENTS.md), the [implementation sequence](docs/implementation/README.md), [architecture](docs/architecture.md), [testing policy](docs/testing.md) and [code-quality checklist](docs/code-quality.md).

For runtime behavior, write a scenario through a production entry point and observe its meaningful failure before implementing. Use actual temporary files, schemas and fixture scripts; replace only external LLM/service boundaries. Do not make live provider calls part of automated tests. For documented non-TDD configuration changes, record the replacement verification.

Keep changes focused and update affected documentation. Run `npm run check` before opening a pull request; this runs lint, typecheck and the runtime/package suites sequentially. Include the problem, resulting behavior and validation evidence in your PR. CI validates Windows, macOS and Linux. Maintainers review contributions before merging; a contribution does not grant repository write or package-publishing permissions.

## Pull request titles and releases

The repository uses squash merging with the PR title as the default commit title and a blank commit body. Use this format:

```text
type(optional-scope)!: clear description
```

The scope and `!` are optional. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. A non-empty description is required.

- `fix(cli): preserve paused runs` produces a patch release.
- `feat: add a workflow option` produces a minor release.
- `refactor!: remove an obsolete workflow format` produces a major release.
- `docs: clarify local installation` produces a patch release under this project's policy.

Use `!` in the title for every breaking change: the squash body is blank, so a `BREAKING CHANGE:` footer in a PR description or an individual branch commit will not reliably reach release analysis. Branch commits need not each follow this format; the final PR title must describe the complete change. Keep the validated title when merging instead of manually replacing the squash commit message.

The `Validate PR title` workflow checks new/reopened PRs, new commits, title edits and transitions out of draft. Drafts use the same title format. This is a format check; reviewers still assess whether the type and description accurately describe the change. See folder 09 for release policy and rollout evidence. Contributors do not need npm credentials to develop or test.

## License and attribution

Nodulus is licensed under [Apache-2.0](LICENSE), with project attribution in [NOTICE](NOTICE). Contributions intentionally submitted for inclusion are provided under the same license unless explicitly stated otherwise, as described in section 5 of the license. Submit only material you are authorized to contribute. Keep applicable third-party notices with any third-party material.

You may use, copy, modify and redistribute Nodulus under the license terms. Preserve the applicable license and attribution notices and identify modified files when distributing modifications. There is no requirement to send your changes upstream, although contributions are welcome.

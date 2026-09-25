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

Use descriptive Conventional Commit messages such as `fix: preserve paused runs` or `feat: add a workflow option`. Breaking changes must be identified. See folder 09 for the release policy; contributors do not need npm credentials to develop or test.

## License and attribution

Nodulus is licensed under [Apache-2.0](LICENSE), with project attribution in [NOTICE](NOTICE). Contributions intentionally submitted for inclusion are provided under the same license unless explicitly stated otherwise, as described in section 5 of the license. Submit only material you are authorized to contribute. Keep applicable third-party notices with any third-party material.

You may use, copy, modify and redistribute Nodulus under the license terms. Preserve the applicable license and attribution notices and identify modified files when distributing modifications. There is no requirement to send your changes upstream, although contributions are welcome.

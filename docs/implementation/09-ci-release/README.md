# 09-ci-release: Validate platforms and publish releases

**Status:** REL-001 is verified on hosted Windows/macOS/Linux. Public version 1.0.0 and its clean registry installation are verified; automated/OIDC release 1.0.1 and upgrading from 1.0.0 are verified. External release-guard exercises remain open. **Prerequisite:** 08-package-install. **Method:** Non-TDD hosted configuration; test-first for any custom decision code.

After a main-branch merge passes checks and the repository owner explicitly enables publishing, users can obtain a versioned release. The package is Apache-2.0 under `@rogeriohsjr/nodulus`. Automated publishing is enabled: npm trust and the repository opt-in are configured, with a main-only publishing environment.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### REL-001: Gate changes across platforms

Given a proposed change, when CI runs, then Windows/macOS/Linux execute lint, typecheck, build, scenarios and package install checks without live LLM credentials; failures prevent release.

- [x] REL-001 acceptance verified and evidence recorded.

### REL-002: Publish after a validated merge

Given a new eligible main commit and successful required jobs, when release runs, then one version/tag/release and npm package correspond to the tested commit.

- [x] REL-002 acceptance verified and evidence recorded.

### REL-003: Avoid duplicate or unsafe publishing

Given a fork PR, failed checks or rerun of an already released commit, when workflows execute, then they cannot publish an unauthorized or duplicate release.

- [ ] REL-003 acceptance verified and evidence recorded.

### REL-004: Verify the public upgrade path

Given an authorized published version, when a clean consumer installs that exact registry version, then its reported version and basic workflow match the release and users can upgrade using documented commands.

- [x] REL-004 acceptance verified and evidence recorded.

## Implementation guidance

The workflow in `.github/workflows/ci-release.yml` runs Node 24 lint, typecheck, build, scenario and package checks on Windows, macOS and Linux for PRs to `main` and pushes to `main`/`codex/**`. The release job depends on every matrix leg, checks out `github.sha` again, and only runs on a non-deletion push to canonical `Rogeriohsjr/nodulus` when the repository variable `NODULUS_PUBLISH_ENABLED` is exactly `true`. It also stops unless `package.json` has `private: false`. The release environment is named `npm-publish`; restrict deployment branches to `main` before enabling the repository variable. Required reviewers are optional and would add a manual approval to each release.

Use semantic-release with explicit rules: every unreleased commit message gets at least a patch, `feat` gets minor, and breaking changes get major. The configured catch-all includes docs, chores, tests, CI, refactors and untyped messages. The Conventional Commits preset treats a `!` after the type/scope (for example `fix!: reject invalid mappings`) or a `BREAKING CHANGE:` footer as breaking metadata. semantic-release analyzes commits after the last release tag, so a rerun with no new commits creates no second version. The dry-run scenario exercises this against a disposable local Git remote. If release concurrency batches several main commits, one release may contain multiple merges; do not promise one package per merge. The workflow does not create release commits, so it cannot trigger itself through a version-bump commit.

The release job grants only `contents: write` and `id-token: write`; npm authentication uses GitHub Actions trusted publishing/OIDC and deliberately does not configure a long-lived npm token or `registry-url`. The package `repository.url` names this GitHub repository so it can match the npm trusted-publisher configuration. The `GITHUB_TOKEN` publishes the GitHub release and tag. The job is absent for fork PR events and gated to the canonical repository. npm documents private-repository provenance as unsupported; provenance is only expected when both source repository and package are public. This does not require changing repository visibility for this workflow, but an actual npm trust relationship still must be configured and verified. Keep publishing disabled until an owner configures the protected environment, opt-in variable, trusted publisher and package identity, and authorizes publication.

The local policy tests invoke the actual semantic-release commit analyzer, and the dry run uses a local bare Git remote without the npm/GitHub publishing plugins. Workflow YAML validation and these dry runs are preliminary: record hosted matrix URLs and terminal jobs after the workflow is pushed. Package scope/name ownership, GitHub/npm trusted publisher setup and external publishing require current-task authorization. REL-002 and REL-004 are verified by automated release 1.0.1 and the clean-consumer upgrade from 1.0.0; see the latest evidence checkpoint.

References checked on 2026-09-24: [semantic-release commit analyzer](https://github.com/semantic-release/commit-analyzer), [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/), [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), and [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0). semantic-release v25.0.9 requires Node `^22.14.0 || >=24.10.0`; npm trusted publishing requires npm CLI `>=11.5.1` and Node `>=22.14.0`.

## PR titles

The repository is configured for squash-only merges with `PR_TITLE` and a blank body. [CONTRIBUTING.md](../../../CONTRIBUTING.md) defines the Conventional Commit title format and allowed types. `!` is required in the title for a breaking change because the PR body is not copied into the squash commit.

The metadata-only `pr-title.yml` workflow runs on PR open/reopen/edit/synchronize/ready-for-review events against `main`. It uses a pinned third-party validator with read-only PR permission and no checkout. This hosted configuration uses the explicit non-TDD exception. The workflow is merged into `main`; hosted invalid-title failure and corrected-title success are verified. `Validate PR title` is required in branch protection, with existing review requirements preserved. See evidence for the exact runs.

## Developer sequence

- [x] Identify applicable non-TDD exception and its verification plan.
- [x] Validate configuration and dry-run version/release policy, including docs-only changes.
- [x] Record successful Windows/macOS/Linux hosted job URLs and exact SHA.
- [x] Record actual authorized npm version/tag/release and clean registry-install proof.
- [ ] Verify rerun/fork/failed-check release guards and document unresolved admin prerequisites.
- [x] Run available accumulated checks and record limitations.
- [ ] Review public contracts/docs; update evidence and only then mark this folder complete in the index.

REL-003 is partially verified: local tagged rerun and static guards pass, and hosted PR/failed-check runs skipped publishing. Actual fork, authorized publication rerun, and concurrency verification remain deferred. The full folder stays open until publication acceptance is verified.

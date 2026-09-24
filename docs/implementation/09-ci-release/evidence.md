# Evidence: 09-ci-release

Status: local policy tests and workflow configuration are green; cross-platform fixes for hosted run `36013867131` are ready for independent review and rerun. No repository release/tag, registry operation, or external publication was performed; the scenario creates and tags only a disposable local bare Git fixture.

## Environment

- Baseline revision: `5ab78462da197bcc531effe3420d3b3b04d81789` (working tree contains uncommitted 09 changes).
- Platform/runtime: Windows, Node `v24.15.0`, npm `11.12.1`.
- Owner/date: builder / 2026-09-24.
- `semantic-release@25.0.9`, `@semantic-release/commit-analyzer@13.0.1`, and `conventional-changelog-conventionalcommits@9.3.1` are developer dependencies; no runtime package dependency was added. The analyzer and notes generator use the same preset. Preset v9.3.1 is compatible with semantic-release v25's writer v8; preset v10.4.0 failed the dry run because it requires writer v9.
- No repository release/tag, registry mutation, paid service, or live provider call.

## Scenario evidence

| Scenario | Test file and test name | RED command / meaningful failure | GREEN command / result | Remaining proof |
| --- | --- | --- | --- | --- |
| REL-001 | `tests/scenarios/rel-001-release-policy.test.ts`, policy matrix and docs-only dry-run | Initial focused run: 11 tests; 7 failed and 4 passed. Default analyzer returned `null` for docs/chore/test/ci/refactor/untyped messages instead of patch. A semantic-release dry run over a disposable bare Git remote reported no release for its docs-only commit. Feature/minor, breaking/major, mixed highest-bump and empty-input cases passed. A follow-up syntax regression showed `fix!:` produced patch under the Angular parser (1 failed / 12 passed). | Final focused command: 13/13 passed. Actual semantic-release CLI calculated `1.0.1` for docs-only; after adding/pushing local tag `v1.0.1`, the next dry run reported no relevant changes/no new version. `feat`→minor, breaking `!`/footer→major, mixed highest-bump and empty-input cases passed. Dry run uses production rules and matching preset but excludes npm/GitHub publishing plugins. | Hosted matrix on Windows/macOS/Linux is not run. No hosted or registry publication. |
| REL-002 | release workflow | Configuration is a non-TDD hosted-integration exception. | Static YAML parse/guard assertions passed; release requires all matrix legs, checks out the same `github.sha`, and remains disabled by default. A separate manifest check stops while `package.json` is private. | Hosted matrix URLs, protected environment setup, npm trusted publisher and actual authorized release are unverified. |
| REL-003 | no-release and publication guards | Analyzer empty-input behavior passed in REL-001; no unreleased commits yields `null`. Initial workflow configuration is a non-TDD hosted-integration exception. | Local dry-run proves a second semantic-release run after a tag does not calculate another version. Static YAML assertions confirm push-main/canonical-repository/opt-in gates, package-private guard, separate release permissions, and non-canceling release serialization. | Hosted fork-PR, failed-check, rerun, and concurrency behavior remain unverified. |
| REL-004 | public registry install/upgrade | Not run; no publication or registry package identity is authorized. | Not run | Requires package ownership, trusted-publisher setup, an authorized release, and clean registry-install proof. |
| PROV-001 / PROV-003 hosted regression | `tests/scenarios/prov-001-protocol-translation.test.ts`, `tests/scenarios/prov-003-portable-invocation.test.ts`, and REL-001 disposable Git dry-run | Hosted PR run `36013867131`: macOS provider tests compared symlinked `/var` and canonical `/private/var` paths as strings; macOS and Ubuntu release-policy tests inherited `GITHUB_REF=refs/pull/1/merge`, so semantic-release skipped the fixture's local `main` branch. | Compared provider paths through `realpathSync` while retaining the same filesystem target assertion. Reproducing with `GITHUB_REF=refs/pull/1/merge` and `GITHUB_ACTIONS=true` first failed the expected dry-run version assertion; after removing only `GITHUB_*` variables from the disposable semantic-release child environment, the focused 3-file suite passed (20/20). | Hosted rerun pending; Windows/macOS/Linux hosted matrix remains required. |
| REL-001 hosted URL portability regression | `tests/scenarios/rel-001-release-policy.test.ts`, disposable bare-remote semantic-release dry-run | Hosted PR run `36014310374` (macOS and Ubuntu jobs `107682751228`, `107682751558`) failed in the release-notes generator with `Invalid URL`: the fixture supplied a native absolute remote path as `repositoryUrl`, which was treated as a URL on POSIX. This was a hosted-only failure; the Windows focused suite had passed. | Fixture now sets `repositoryUrl` using `pathToFileURL(remote).href` while keeping the real local bare Git remote and release-notes generator. Windows focused suite: 13/13 passed; typecheck and diff-check passed. | Hosted rerun pending. |

The initial analyzer test import error (`default is not a function`) was test harness setup, not RED evidence; switching to the package's documented named `analyzeCommits` export produced the behavioral failures recorded above.

## Accumulated validation

- RED: `npx vitest run tests/scenarios/rel-001-release-policy.test.ts`: 7 failed / 4 passed at the main policy checkpoint; a follow-up parser syntax check was 1 failed / 12 passed before the preset correction.
- GREEN: same focused command, 13/13 passed; local semantic-release docs-only and tagged-rerun dry run passed.
- Workflow static validation: a local `js-yaml` parse and assertions confirmed PR/main/codex triggers, three-OS matrix, read-only validation token, default-off opt-in, canonical main gate, exact SHA checkout, package-private stop, release permissions and non-canceling serialization.
- `npm run typecheck`: passed.
- `npm test`: runtime 36 files / 115 tests passed; package 1 file / 5 tests passed, sequentially.
- `git diff --check`: passed.
- Hosted workflows and registry/live release checks: not run.
- Hosted regression reproduction: `GITHUB_REF=refs/pull/1/merge` and `GITHUB_ACTIONS=true` plus the focused three-file command failed only the release dry-run branch assertion (provider scenarios passed). After the fixture-only environment isolation and canonical path comparisons, the same command passed 3 files / 20 tests. These test fixes do not establish hosted rerun evidence.
- Hosted URL regression: run `36014310374` exposed POSIX URL parsing of the fixture's native absolute path. With `repositoryUrl` converted to a `file:` URL through Node's `pathToFileURL`, `npx vitest run tests/scenarios/rel-001-release-policy.test.ts` passed 13/13 on Windows; typecheck and diff-check passed. Hosted rerun remains pending.

## Handoff

- Files changed for hosted regressions: provider scenario path comparisons use resolved filesystem paths; the disposable semantic-release process excludes `GITHUB_*` branch metadata while preserving other environment variables; its fixture repository URL uses a proper file URL. The production runtime and workflow configuration are unchanged.
- Earlier folder 09 files: `.releaserc.json`, `.github/workflows/ci-release.yml`, release-policy tests, package developer dependencies/lockfile, folder documentation, and this evidence.
- Action references are pinned to upstream release commits `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1) and `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0); Node is pinned to major 24 in CI and release jobs.
- Package remains `private: true`; the repo opt-in variable and protected npm environment have not been configured. No folder 09 acceptance checkbox is checked.
- npm's trusted-publisher instructions require the package `repository.url` to match its GitHub repo; this metadata is present. Private source repositories do not receive npm provenance, but the official docs describe that as a provenance limitation rather than a trusted-publishing restriction. No trust relationship has been created or tested.
- `.releaserc.json` uses explicit major/minor rules and a message catch-all patch rule, with matching Conventional Commits analysis and release-notes presets.
- No hosted job, public package ownership, trusted-publisher configuration, npm release, or registry install was performed.

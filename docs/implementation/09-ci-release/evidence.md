# Evidence: 09-ci-release

Status: local policy tests and workflow configuration are green; independent review and all hosted/registry evidence remain pending. No repository release/tag, registry operation, or external publication was performed; the scenario creates and tags only a disposable local bare Git fixture.

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

The initial analyzer test import error (`default is not a function`) was test harness setup, not RED evidence; switching to the package's documented named `analyzeCommits` export produced the behavioral failures recorded above.

## Accumulated validation

- RED: `npx vitest run tests/scenarios/rel-001-release-policy.test.ts`: 7 failed / 4 passed at the main policy checkpoint; a follow-up parser syntax check was 1 failed / 12 passed before the preset correction.
- GREEN: same focused command, 13/13 passed; local semantic-release docs-only and tagged-rerun dry run passed.
- Workflow static validation: a local `js-yaml` parse and assertions confirmed PR/main/codex triggers, three-OS matrix, read-only validation token, default-off opt-in, canonical main gate, exact SHA checkout, package-private stop, release permissions and non-canceling serialization.
- `npm run typecheck`: passed.
- `npm test`: runtime 36 files / 115 tests passed; package 1 file / 5 tests passed, sequentially.
- `git diff --check`: passed.
- Hosted workflows and registry/live release checks: not run.

## Handoff

- Files changed: `.releaserc.json`, `.github/workflows/ci-release.yml`, release-policy tests, package developer dependencies/lockfile, folder documentation, and this evidence.
- Action references are pinned to upstream release commits `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1) and `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0); Node is pinned to major 24 in CI and release jobs.
- Package remains `private: true`; the repo opt-in variable and protected npm environment have not been configured. No folder 09 acceptance checkbox is checked.
- npm's trusted-publisher instructions require the package `repository.url` to match its GitHub repo; this metadata is present. Private source repositories do not receive npm provenance, but the official docs describe that as a provenance limitation rather than a trusted-publishing restriction. No trust relationship has been created or tested.
- `.releaserc.json` uses explicit major/minor rules and a message catch-all patch rule, with matching Conventional Commits analysis and release-notes presets.
- No hosted job, public package ownership, trusted-publisher configuration, npm release, or registry install was performed.

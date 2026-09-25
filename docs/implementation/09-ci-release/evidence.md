# Evidence: 09-ci-release

Status: local policy tests and both hosted matrices are green. The process-liveness regression was corrected, independently reviewed, and verified by the final code-checkpoint runs below. Public Apache-2.0 publication is now authorized; the scoped package is prepared but not yet published. Repository opt-in and npm trust are pending. No repository release/tag, registry operation, or external publication was performed; the scenario creates and tags only a disposable local bare Git fixture.

## Environment

- Baseline revision: `5ab78462da197bcc531effe3420d3b3b04d81789` (initial folder 09 baseline).
- Platform/runtime: Windows, Node `v24.15.0`, npm `11.12.1`.
- Owner/date: builder / 2026-09-24.
- `semantic-release@25.0.9`, `@semantic-release/commit-analyzer@13.0.1`, and `conventional-changelog-conventionalcommits@9.3.1` are developer dependencies; no runtime package dependency was added. The analyzer and notes generator use the same preset. Preset v9.3.1 is compatible with semantic-release v25's writer v8; preset v10.4.0 failed the dry run because it requires writer v9.
- No repository release/tag, registry mutation, paid service, or live provider call.

## Scenario evidence

| Scenario | Test file and test name | RED command / meaningful failure | GREEN command / result | Remaining proof |
| --- | --- | --- | --- | --- |
| REL-001 | `tests/scenarios/rel-001-release-policy.test.ts`, policy matrix and docs-only dry-run | Initial focused run: 11 tests; 7 failed and 4 passed. Default analyzer returned `null` for docs/chore/test/ci/refactor/untyped messages instead of patch. A semantic-release dry run over a disposable bare Git remote reported no release for its docs-only commit. Feature/minor, breaking/major, mixed highest-bump and empty-input cases passed. A follow-up syntax regression showed `fix!:` produced patch under the Angular parser (1 failed / 12 passed). | Final focused command: 13/13 passed. Actual semantic-release CLI calculated `1.0.1` for docs-only; after adding/pushing local tag `v1.0.1`, the next dry run reported no relevant changes/no new version. `feat`→minor, breaking `!`/footer→major, mixed highest-bump and empty-input cases passed. Dry run uses production rules and matching preset but excludes npm/GitHub publishing plugins. | Hosted PR matrix passed on all three platforms; see job links below. No hosted or registry publication. |
| REL-002 | release workflow | Configuration is a non-TDD hosted-integration exception. | Static YAML parse/guard assertions passed; release requires all matrix legs, checks out the same `github.sha`, and remains disabled by default. A separate manifest check stops while `package.json` is private. | Protected environment setup, npm trusted publisher and actual authorized release are unverified. |
| REL-003 | no-release and publication guards | Analyzer empty-input behavior passed in REL-001; no unreleased commits yields `null`. Initial workflow configuration is a non-TDD hosted-integration exception. | Local dry-run proves a second semantic-release run after a tag does not calculate another version. Static YAML assertions confirm push-main/canonical-repository/opt-in gates, package-private guard, separate release permissions, and non-canceling release serialization. | Hosted fork-PR, failed-check, rerun, and concurrency behavior remain unverified. |
| REL-004 | public registry install/upgrade | Not run; no publication or registry package identity is authorized. | Not run | Requires package ownership, trusted-publisher setup, an authorized release, and clean registry-install proof. |
| PROV-001 / PROV-003 hosted regression | `tests/scenarios/prov-001-protocol-translation.test.ts`, `tests/scenarios/prov-003-portable-invocation.test.ts`, and REL-001 disposable Git dry-run | Hosted PR run `36013867131`: macOS provider tests compared symlinked `/var` and canonical `/private/var` paths as strings; macOS and Ubuntu release-policy tests inherited `GITHUB_REF=refs/pull/1/merge`, so semantic-release skipped the fixture's local `main` branch. | Compared provider paths through `realpathSync` while retaining the same filesystem target assertion. Reproducing with `GITHUB_REF=refs/pull/1/merge` and `GITHUB_ACTIONS=true` first failed the expected dry-run version assertion; after removing only `GITHUB_*` variables from the disposable semantic-release child environment, the focused 3-file suite passed (20/20). | Hosted PR rerun passed on all three platforms; see below. |
| REL-001 hosted URL portability regression | `tests/scenarios/rel-001-release-policy.test.ts`, disposable bare-remote semantic-release dry-run | Hosted PR run `36014310374` (macOS and Ubuntu jobs `107682751228`, `107682751558`) failed in the release-notes generator with `Invalid URL`: the fixture supplied a native absolute remote path as `repositoryUrl`, which was treated as a URL on POSIX. This was a hosted-only failure; the Windows focused suite had passed. | Fixture now sets `repositoryUrl` using `pathToFileURL(remote).href` while keeping the real local bare Git remote and release-notes generator. Windows focused suite: 13/13 passed; typecheck and diff-check passed. | Hosted PR rerun passed on all three platforms; see below. |

The initial analyzer test import error (`default is not a function`) was test harness setup, not RED evidence; switching to the package's documented named `analyzeCommits` export produced the behavioral failures recorded above.

## Accumulated validation

- RED: `npx vitest run tests/scenarios/rel-001-release-policy.test.ts`: 7 failed / 4 passed at the main policy checkpoint; a follow-up parser syntax check was 1 failed / 12 passed before the preset correction.
- GREEN: same focused command, 13/13 passed; local semantic-release docs-only and tagged-rerun dry run passed.
- Workflow static validation: a local `js-yaml` parse and assertions confirmed PR/main/codex triggers, three-OS matrix, read-only validation token, default-off opt-in, canonical main gate, exact SHA checkout, package-private stop, release permissions and non-canceling serialization.
- `npm run typecheck`: passed.
- `npm test`: runtime 36 files / 115 tests passed; package 1 file / 5 tests passed, sequentially.
- `git diff --check`: passed.
- Hosted PR matrix: passed on Windows/macOS/Linux (links below). Registry/live release checks: not run.
- Hosted regression reproduction: `GITHUB_REF=refs/pull/1/merge` and `GITHUB_ACTIONS=true` plus the focused three-file command failed only the release dry-run branch assertion (provider scenarios passed). After the fixture-only environment isolation and canonical path comparisons, the same command passed 3 files / 20 tests. These test fixes do not establish hosted rerun evidence.
- Hosted URL regression: run `36014310374` exposed POSIX URL parsing of the fixture's native absolute path. With `repositoryUrl` converted to a `file:` URL through Node's `pathToFileURL`, `npx vitest run tests/scenarios/rel-001-release-policy.test.ts` passed 13/13 on Windows; typecheck and diff-check passed. Hosted PR rerun passed on all three platforms (links below).

## Handoff

- Files changed for hosted regressions: provider scenario path comparisons use resolved filesystem paths; the disposable semantic-release process excludes `GITHUB_*` branch metadata while preserving other environment variables; its fixture repository URL uses a proper file URL. The production runtime and workflow configuration are unchanged.
- Earlier folder 09 files: `.releaserc.json`, `.github/workflows/ci-release.yml`, release-policy tests, package developer dependencies/lockfile, folder documentation, and this evidence.
- Action references are pinned to upstream release commits `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1) and `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0); Node is pinned to major 24 in CI and release jobs.
- At the initial CI checkpoint the package was `private: true`. The current authorized public manifest uses `@rogeriohsjr/nodulus`, `private: false` and Apache-2.0. Repository opt-in and npm trust remain pending; REL-001 has hosted proof and actual publishing acceptance remains open.
- npm's trusted-publisher instructions require the package `repository.url` to match its GitHub repo; this metadata is present. Private source repositories do not receive npm provenance, but the official docs describe that as a provenance limitation rather than a trusted-publishing restriction. No trust relationship has been created or tested.
- `.releaserc.json` uses explicit major/minor rules and a message catch-all patch rule, with matching Conventional Commits analysis and release-notes presets.
- No public package ownership, trusted-publisher configuration, npm release, or registry install was performed.

## Hosted cross-platform checkpoint

Code revision: `12850dac06194cea1b8265b92c446de21126e81f`.

[PR run 36014741762](https://github.com/Rogeriohsjr/nodulus/actions/runs/36014741762) completed successfully. Each job ran typecheck, build, 115 scenario tests and five real package install/upgrade tests:

- [Windows](https://github.com/Rogeriohsjr/nodulus/actions/runs/36014741762/job/107684246530): success.
- [macOS](https://github.com/Rogeriohsjr/nodulus/actions/runs/36014741762/job/107684246391): success.
- [Linux](https://github.com/Rogeriohsjr/nodulus/actions/runs/36014741762/job/107684246177): success.

Publishing was skipped. The separate [push run](https://github.com/Rogeriohsjr/nodulus/actions/runs/36014736123) passed Windows/macOS but caught an intermittent Linux SAFE-003 descendant liveness assertion. Folder 06 evidence records that regression and its bounded termination check; completion requires a fresh matrix after review. PR success is not used to dismiss that failure.

GitHub Actions wiring is the documented non-TDD exception. The workflow's release dependency and observed skipped release jobs are verified; branch protection, environment administration, actual fork publication protection, publishing concurrency and registry behavior are not claimed as exercised. Luna implemented the slices; Sol independently reviewed stable checkpoints and each hosted correction.

## Final code-checkpoint verification

Revision `494a603ecd65930efe5ca7b988f1854c4e4fb4ea` passed both [push run 36015576381](https://github.com/Rogeriohsjr/nodulus/actions/runs/36015576381) and [PR run 36015586594](https://github.com/Rogeriohsjr/nodulus/actions/runs/36015586594). All six validation jobs succeeded; both publication jobs were skipped.

| Platform | PR job | Push job | Result |
| --- | --- | --- | --- |
| Windows | [107687148112](https://github.com/Rogeriohsjr/nodulus/actions/runs/36015586594/job/107687148112) | [107687112170](https://github.com/Rogeriohsjr/nodulus/actions/runs/36015576381/job/107687112170) | Success |
| macOS | [107687148627](https://github.com/Rogeriohsjr/nodulus/actions/runs/36015586594/job/107687148627) | [107687111689](https://github.com/Rogeriohsjr/nodulus/actions/runs/36015576381/job/107687111689) | Success |
| Linux | [107687148955](https://github.com/Rogeriohsjr/nodulus/actions/runs/36015586594/job/107687148955) | [107687111861](https://github.com/Rogeriohsjr/nodulus/actions/runs/36015576381/job/107687111861) | Success |

Each job passed typecheck, build, 115 runtime/release scenario tests and five real package tests. Sol independently accepted the SAFE-003 liveness correction and reran its five focused tests. Documentation review checked 33 tracked Markdown files with zero missing local links and a clean diff check. This record identifies the tested code checkpoint; later documentation-only commits retain CI checks in the PR.

All work authorized for local-first delivery is implemented, reviewed, committed and pushed. The full publication folder intentionally remains open: package identity, protected environment/trusted-publisher administration, actual release, external release-guard exercises and registry install/upgrade are deferred. Live Codex/Cursor inference remains unverified.

## Public-release preparation

The user authorized public source, copying/modification and community contributions. Apache-2.0 LICENSE, project NOTICE, CONTRIBUTING guidance and scoped package metadata are prepared. `npm whoami` returned `rogeriohsjr`; the registry lookup for `@rogeriohsjr/nodulus` returned 404 before first publication. No package ownership is claimed from that lookup alone.

Local `npm run check` passed lint/typecheck, 115 runtime/release scenarios and six package scenarios. Sol accepted the public package implementation. Markdown link checks passed for 35 files. This is package readiness, not evidence of registry publication; external results follow separately.

## Public repository and initial publish attempt

The repository visibility was changed to public under the user's authorization, and GitHub detected Apache-2.0. PR #1 merged as `59826b4533904dac88db8abdd313915aaa5231cf` after all Windows/macOS/Linux PR and push checks passed at `729f702`. The merge tree matched the tested tree. The `npm-publish` GitHub environment now allows only the `main` branch; automatic publication opt-in remains unset pending npm trust.

The initial `npm publish --access public` on Windows/npm 11.12.1 paused for browser authentication. npm warned that normalization removed the CLI bin entry, so the attempt was canceled before authentication and no version was published. `npm publish --dry-run --access public --json` reproduced the warning. Sol traced the installed npm normalizer and found that the bin entry is retained: the warning describes normalizing `./dist/bin.js` to `dist/bin.js`, despite its misleading removal wording. The metadata will use the canonical path, with a real publish dry-run regression before retrying.

The merged main revision also passed all three hosted validation jobs in [run 36077227656](https://github.com/Rogeriohsjr/nodulus/actions/runs/36077227656); the release job remained skipped.

## PR title gate preparation

User requested validation of the PR title used in Git history. GitHub settings were read back as squash-only, `squash_merge_commit_title: PR_TITLE`, and `squash_merge_commit_message: BLANK`; no merge-setting changes were needed. The existing review requirements are preserved.

The metadata-only `pr-title.yml` uses `pull_request_target` for main-targeted PR opened/reopened/edited/synchronize/ready-for-review events. It grants only PR read permission, never checks out PR code and pins `amannn/action-semantic-pull-request` v6.1.1 to verified upstream commit `48f256284bd46cdaab1048c3721360e808335d50`. Allowed conventional types, optional scope, breaking `!` and a nonblank subject are documented for humans and AI agents.

This is the Actions configuration non-TDD exception. Local js-yaml parsing and assertions verified trigger events, read-only permissions, single pinned action, check name and the subject regex accepting text/rejecting whitespace. No custom release decision code or runtime behavior changed. The workflow must first exist on main before GitHub can run it; hosted title-failure/title-success evidence and required-check activation remain pending until that bootstrap merge. Do not count an ordinary CI matrix as title-validation evidence.

PR-title preparation checks: `npm run check` passed lint, typecheck, 115 runtime scenarios and seven package tests. Local Markdown links passed for 35 tracked files. Sol accepted the workflow and documentation; hosted activation is still pending.

## Hosted PR title rollout

PR #3 was merged to activate the metadata-only title workflow. This follow-up records the hosted invalid-title and corrected-title checks and branch-protection activation. Results will be recorded after observing each terminal check; no runtime behavior changes.

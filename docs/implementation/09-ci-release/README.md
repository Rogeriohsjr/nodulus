# 09-ci-release: Validate platforms and publish releases

**Status:** not started. **Prerequisite:** 08-package-install. **Method:** Non-TDD hosted configuration; test-first for any custom decision code.

After a main-branch merge passes checks, users can obtain a versioned release.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### REL-001: Gate changes across platforms

Given a proposed change, when CI runs, then Windows/macOS/Linux execute typecheck, build, scenarios and package install checks without live LLM credentials; failures prevent release.

- [ ] REL-001 acceptance verified and evidence recorded.

### REL-002: Publish after a validated merge

Given a new eligible main commit and successful required jobs, when release runs, then one version/tag/release and npm package correspond to the tested commit.

- [ ] REL-002 acceptance verified and evidence recorded.

### REL-003: Avoid duplicate or unsafe publishing

Given a fork PR, failed checks or rerun of an already released commit, when workflows execute, then they cannot publish an unauthorized or duplicate release.

- [ ] REL-003 acceptance verified and evidence recorded.

### REL-004: Verify the public upgrade path

Given an authorized published version, when a clean consumer installs that exact registry version, then its reported version and basic workflow match the release and users can upgrade using documented commands.

- [ ] REL-004 acceptance verified and evidence recorded.

## Implementation guidance

Configure OS matrix and npm trusted publishing/OIDC with least permissions on the release job only. Serialize releases, release only main, and never publish from fork/PR jobs. Validate the same commit that is released.
Use semantic-release. Product policy: each unreleased merge to main receives at least a patch version after checks; feature/breaking metadata raises the bump. Configure rules explicitly because default semantic-release may skip docs/chore changes. If release concurrency batches several commits, one release may contain multiple merges; document this rather than promising one package per merge. Avoid automated release commits that recursively trigger new versions.
Dry-run release/version calculation, inspect package contents, then record hosted run URLs and terminal jobs. Package name/scope ownership, GitHub/npm trusted publisher setup and external publishing require current-task authorization. Leave those evidence boxes open if unavailable; local YAML validity is not delivery completion.

## Developer sequence

- [ ] Identify applicable non-TDD exception and its verification plan.
- [ ] Validate configuration and dry-run version/release policy, including docs-only changes.
- [ ] Record successful Windows/macOS/Linux hosted job URLs and exact SHA.
- [ ] Record actual authorized npm version/tag/release and clean registry-install proof.
- [ ] Verify rerun/fork/failed-check release guards and document unresolved admin prerequisites.
- [ ] Run available accumulated checks and record limitations.
- [ ] Review public contracts/docs; update evidence and only then mark this folder complete in the index.


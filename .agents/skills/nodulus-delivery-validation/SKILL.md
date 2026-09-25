---
name: nodulus-delivery-validation
description: Build and verify Nodulus toolchain, package installation, CI, and release slices while distinguishing testable package behavior from non-TDD hosted configuration. Use for implementation folders 00, 08, and 09.
---

# Verify Nodulus delivery

Read `AGENTS.md`, `docs/testing.md`, and the assigned implementation folder under `docs/implementation`. Verify its prerequisites and current task authorization.

Classify each item before working:

- Toolchain bootstrap: no behavioral RED is required before a runtime exists. Prove dependency install, compiler/build, and a temporary test-runner probe; remove that probe and do not count it as acceptance coverage.
- Package/install/upgrade behavior: write an acceptance test first and observe RED. Exercise the actual npm archive in an isolated prefix/consumer, real files, and external-provider fixture executable. A source-checkout run is insufficient.
- Custom release decision logic: test first, including documentation-only merges and duplicate-release handling.
- Actions YAML, OIDC, registry administration, and release wiring: record the non-TDD exception and replacement evidence. Static checks and dry runs are preliminary; hosted and registry outcomes require their own evidence.

Follow the release policy in folder 09. Verify release jobs use the same tested revision, publish only from main, serialize publication, and cannot run from fork PRs. Keep package ownership and authentication prerequisites explicit. These instructions are not authorization to publish or invoke paid providers.

Record exact commands, SHA, platform results, workflow URLs, package/version, and archive/registry-install results in evidence.md as applicable. Leave unavailable external checks open. Do not check the folder complete when only its local subset passed.

For documentation-only work validate local links, scenario/checklist consistency and skill metadata. Keep status honest: documentation does not implement the planned commands.

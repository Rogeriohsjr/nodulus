# Evidence: 08-package-install

Checkpoint history: counts and remaining work below describe this slice at acceptance time. See the [current implementation status](../README.md) and [hosted validation](../09-ci-release/evidence.md#final-code-checkpoint-verification) for later completion.

Status: local archive/install/upgrade scenarios accepted after independent Sol review. Registry publication remains deferred.

## Environment

- Platform/runtime: Windows, Node 24.15.0 / npm local runtime
- Working package identity remains private `nodulus@0.0.0` as a local placeholder.
- Owner/date: builder / 2026-09-24
- No registry mutation, publication, external release, or folder 09 work.

## Scenario evidence

| Scenario | Test file | RED evidence | GREEN evidence | Remaining proof |
| --- | --- | --- | --- | --- |
| PKG-001 | `tests/scenarios/pkg-001-installed-archive.test.ts`, `PKG-001 installs and runs the actual archive CLI, initializer, and fixture workflow` | Initial `npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts`: installed archive `--help` succeeded, then `--version` exited 1 because Commander did not recognize it. | `npm run test:package`: passed. It packs and installs the actual archive in an isolated prefix, invokes the installed npm `.bin` shim, checks `--help`/manifest-derived `--version`, initializes an isolated project, and completes a default-adapter workflow through a real local Codex-protocol fixture executable. | Local archive and fixture proof only; no registry or live provider. |
| PKG-002 | Same file, `PKG-002 includes the user guide and starter assets while excluding development files`; `PKG-002 resolves every local link in the installed package Markdown` | Initial archive lacked `docs/user-guide.md`; follow-up RED found obsolete `dist/core/execute-single-node.*` files in the archive and a README link to an unpackaged developer document. | `npm run test:package`: passed. Archive allowlist includes compiled CLI/API, root README, and user guide; archive excludes tests and agent/config development files. The suite seeds stale JS/declaration/map outputs, performs a real clean build, and proves they are absent from the archive. Installed Markdown local links resolve; developer references in README use stable repository URLs. README links to the installed guide, which documents setup, run, `needs_input`, resume, errors, and the `example.v1` starter contract. PKG-001 confirms installed `init` emits starter settings/workflow/node/instructions/schema. | Future scope ownership and registry package configuration remain placeholders. |
| PKG-003 | Same file, `PKG-003 upgrades from a real older archive and resumes a paused run without changing captured definitions` | No RED was manufactured: this scenario passed at the test checkpoint. | `npm run test:package`: passed. A separately staged package copy is packed as the real `nodulus-0.0.0-fixture.1.tgz`; the current package is packed as `nodulus-0.0.0.tgz`. The old archive is installed, its CLI reports its installed manifest version, a local executable fixture pauses a run, then npm upgrades from the current tarball. The test verifies old run checkpoint and definitions bytes remain unchanged immediately after install, the upgraded CLI reports the new manifest version, and resume succeeds with exactly two provider invocations total. | The two archive versions have the same compiled source; this proves local npm upgrade data preservation/version resolution, not a runtime-format migration between engine implementations. |
| PKG-004 | Same file, `PKG-004 imports the installed application API without CLI argv or stdout effects` | Initial isolated ESM consumer import failed because the package declared no import export. | `npm run test:package`: passed. A separate consumer directory imports `runWorkflow` by package name from the isolated prefix, supplies a provider port, writes its result to a file, and observes empty stdout/stderr. | This local consumer proof does not establish downstream user adoption or registry resolution. |

The test harness packs and installs local npm archives only. Package test temporaries, prefixes, projects, and tarballs are removed after the suite. The prior fixture changes only the manifest version in a staged package copy; the working-tree package version is not edited.

## Accumulated validation

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run test:scenarios`: 35 files passed, 102 tests passed; package tests run separately so their clean build cannot remove `dist` during concurrent CLI scenarios.
- `npm run test:package`: 1 file passed, 5 tests passed; it seeds stale generated outputs, performs a clean build, then archives and installs.
- `npm test`: sequentially runs both suites; runtime 102/102 and package 5/5 passed.
- A first combined Vitest run exposed a harness race when the package test built inside the concurrent scenario suite; the package file is now excluded from that suite and remains covered by `npm test`/`npm run test:package`.
- `git diff --check`: passed.
- Registry/hosted/live provider checks: not run and not authorized.

## Handoff

- Files changed: package metadata/scripts, manifest-backed CLI version output, user guide and README link, archive scenario test, and this evidence.
- Package remains `private: true` with placeholder name/version. The guide presents future `@<your-scope>/nodulus@latest` and exact-version installs as placeholders only; no self-updater is included.
- No folder 09 actions/configuration or publication work started.

Sol independently passed all 5 package cases after the archive corrections. Runtime suite passed 102 tests; npm test runs runtime and package suites sequentially. Folder 09 is next.

## Public identity follow-up

PKG-005 verifies the actual archive has `@rogeriohsjr/nodulus`, public access, Apache-2.0 metadata and shipped LICENSE/NOTICE. Scoped imports and scoped archive upgrades use real isolated consumers. The test compares versions against `npm pack` metadata so later releases remain valid.

RED: focused package suite failed four cases and passed two with the original unscoped/private manifest: public metadata mismatch, scoped consumer import failure, scoped prior tarball filename mismatch and missing shipped NOTICE. GREEN: after manifest/lock/file-list changes, all six package tests passed. Full `npm run check` passed lint, typecheck, 115 runtime scenarios and six package tests on Windows. Sol accepted implementation and documentation was corrected to distinguish current public authorization from historical private checkpoints. Registry publication is tracked separately in folder 09.

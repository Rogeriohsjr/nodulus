# 08-package-install: Install and upgrade the package

**Status:** accepted locally on Windows after independent Sol review; public scoped packaging is accepted; registry publication is tracked in folder 09. **Prerequisite:** 07-provider-adapters. **Method:** TDD for package behavior; registry and hosted delivery remain separate.

Users install a usable CLI and developers import the reusable core.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### PKG-001: Install the actual archive

Given npm pack output, when installed into an isolated prefix, then its binary executes help/version/init and a fixture-provider workflow without depending on source checkout or devDependencies.

- [x] PKG-001 acceptance verified and evidence recorded.

### PKG-002: Ship discoverable documentation

Given only the installed package, when a caller explores help/examples/contracts, then setup, run, needs_input, resume and errors are documented with usable shipped files.

- [x] PKG-002 acceptance verified and evidence recorded.

### PKG-003: Preserve user data across upgrade

Given an installed prior fixture version and a paused run, when upgrading from a new local tarball, then definitions/runs survive and resume either succeeds under declared compatibility or refuses clearly without modification.

- [x] PKG-003 acceptance verified and evidence recorded.

### PKG-004: Expose a CLI-independent core

Given a separate temporary consumer, when it imports the packaged API, then it runs a workflow with supplied adapters without parsing argv or writing CLI output.

- [x] PKG-004 acceptance verified and evidence recorded.

### PKG-005: Ship the public identity and attribution

Given the packed archive, when installed into an isolated consumer, then its manifest uses `@rogeriohsjr/nodulus`, public publishing access and Apache-2.0, and its LICENSE/NOTICE files are present. Future versions must retain the same package identity without a test hardcoding the initial version.

- [x] PKG-005 acceptance verified and evidence recorded.

### PKG-006: Publish without metadata correction warnings

Given the built package, when the actual npm publish command runs in dry-run mode, then it succeeds without correcting or warning about the CLI bin mapping. This check does not publish or prove registry acceptance.

- [x] PKG-006 acceptance verified and evidence recorded.

## Implementation guidance

Write install/archive tests first. Add package bin/exports/files declarations, build outputs, schemas and user docs. Use an isolated installation prefix and clean consumer directories so checkout node_modules cannot hide missing runtime dependencies/assets. Use local tarballs; no registry mutation required.
The authorized npm identity is `@rogeriohsjr/nodulus`, licensed Apache-2.0. Document global install/upgrade, latest-per-invocation and exact version pinning. Publishing makes updates available; it does not update existing installs automatically. No self-updater in v1.

## Developer sequence

- [x] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [x] Run it before implementation; record the relevant RED assertion.
- [x] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [x] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [x] Run test:package against an actual archive and isolated install.
- [x] Verify shipped schemas/examples and importable API.
- [x] Record upgrade preservation and explicit incompatibility behavior.
- [x] Run available accumulated checks and record limitations.
- [x] Review public contracts/docs; update evidence and only then mark this folder complete in the index.

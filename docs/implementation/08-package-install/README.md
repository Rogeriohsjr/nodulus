# 08-package-install: Install and upgrade the package

**Status:** not started. **Prerequisite:** 07-provider-adapters. **Method:** TDD for package behavior; docs/metadata review is non-TDD.

Users install a usable CLI and developers import the reusable core.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### PKG-001: Install the actual archive

Given npm pack output, when installed into an isolated prefix, then its binary executes help/version/init and a fixture-provider workflow without depending on source checkout or devDependencies.

- [ ] PKG-001 acceptance verified and evidence recorded.

### PKG-002: Ship discoverable documentation

Given only the installed package, when a caller explores help/examples/contracts, then setup, run, needs_input, resume and errors are documented with usable shipped files.

- [ ] PKG-002 acceptance verified and evidence recorded.

### PKG-003: Preserve user data across upgrade

Given an installed prior fixture version and a paused run, when upgrading from a new local tarball, then definitions/runs survive and resume either succeeds under declared compatibility or refuses clearly without modification.

- [ ] PKG-003 acceptance verified and evidence recorded.

### PKG-004: Expose a CLI-independent core

Given a separate temporary consumer, when it imports the packaged API, then it runs a workflow with supplied adapters without parsing argv or writing CLI output.

- [ ] PKG-004 acceptance verified and evidence recorded.

## Implementation guidance

Write install/archive tests first. Add package bin/exports/files declarations, build outputs, schemas and user docs. Use an isolated installation prefix and clean consumer directories so checkout node_modules cannot hide missing runtime dependencies/assets. Use local tarballs; no registry mutation required.
Choose an owned npm scope later; examples use a clearly marked placeholder until configured. Document global install/upgrade, latest-per-invocation and exact version pinning. Publishing makes updates available; it does not update existing installs automatically. No self-updater in v1.

## Developer sequence

- [ ] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [ ] Run it before implementation; record the relevant RED assertion.
- [ ] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [ ] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [ ] Run test:package against an actual archive and isolated install.
- [ ] Verify shipped schemas/examples and importable API.
- [ ] Record upgrade preservation and explicit incompatibility behavior.
- [ ] Run available accumulated checks and record limitations.
- [ ] Review public contracts/docs; update evidence and only then mark this folder complete in the index.


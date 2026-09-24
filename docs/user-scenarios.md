# User scenario catalog

These are acceptance requirements, not existing product behavior. Each linked folder owns its Given/When/Then cases, implementation instructions, and evidence. Test names must include the stable scenario ID. Parameterized variants must remain visible in results.

## Bootstrap the developer toolchain

- [DEV-001: Reproduce the toolchain](implementation/00-foundation/README.md#dev-001-reproduce-the-toolchain)

## Initialize a project and discover configuration

- [INIT-001: Create a usable project](implementation/01-initialize/README.md#init-001-create-a-usable-project)
- [INIT-002: Preserve existing work](implementation/01-initialize/README.md#init-002-preserve-existing-work)
- [INIT-003: Explain provider readiness](implementation/01-initialize/README.md#init-003-explain-provider-readiness)
- [INIT-004: Return machine-readable usage errors](implementation/01-initialize/README.md#init-004-return-machine-readable-usage-errors)

## Accept requests and reference files

- [REQ-001: Normalize three request sources](implementation/02-request-intake/README.md#req-001-normalize-three-request-sources)
- [REQ-002: Reject ambiguous or unreadable input](implementation/02-request-intake/README.md#req-002-reject-ambiguous-or-unreadable-input)
- [REQ-003: Resolve and capture references](implementation/02-request-intake/README.md#req-003-resolve-and-capture-references)
- [REQ-004: Reject broken definitions](implementation/02-request-intake/README.md#req-004-reject-broken-definitions)
- [REQ-005: Preserve large context](implementation/02-request-intake/README.md#req-005-preserve-large-context)

## Execute one node and validate its outcome

- [NODE-001: Accept validated output](implementation/03-node-outcomes/README.md#node-001-accept-validated-output)
- [NODE-002: Reject invalid output](implementation/03-node-outcomes/README.md#node-002-reject-invalid-output)
- [NODE-003: Execute artifact checks](implementation/03-node-outcomes/README.md#node-003-execute-artifact-checks)
- [NODE-004: Distinguish review content from runtime outcome](implementation/03-node-outcomes/README.md#node-004-distinguish-review-content-from-runtime-outcome)
- [NODE-005: Normalize failure and clarification](implementation/03-node-outcomes/README.md#node-005-normalize-failure-and-clarification)
- [NODE-006: Protect system contracts](implementation/03-node-outcomes/README.md#node-006-protect-system-contracts)

## Connect validated nodes in sequence

- [FLOW-001: Map artifacts through a complete workflow](implementation/04-workflow-sequence/README.md#flow-001-map-artifacts-through-a-complete-workflow)
- [FLOW-002: Stop downstream execution](implementation/04-workflow-sequence/README.md#flow-002-stop-downstream-execution)
- [FLOW-003: Reject invalid wiring before inference](implementation/04-workflow-sequence/README.md#flow-003-reject-invalid-wiring-before-inference)
- [FLOW-004: Resolve shared profiles predictably](implementation/04-workflow-sequence/README.md#flow-004-resolve-shared-profiles-predictably)

## Pause, answer, and resume

- [ASK-001: Request missing initial input](implementation/05-clarification-resume/README.md#ask-001-request-missing-initial-input)
- [ASK-002: Resume a node clarification](implementation/05-clarification-resume/README.md#ask-002-resume-a-node-clarification)
- [ASK-003: Reject invalid answers safely](implementation/05-clarification-resume/README.md#ask-003-reject-invalid-answers-safely)
- [ASK-004: Handle repeated and terminal resume](implementation/05-clarification-resume/README.md#ask-004-handle-repeated-and-terminal-resume)
- [ASK-005: Guard captured context](implementation/05-clarification-resume/README.md#ask-005-guard-captured-context)

## Repair responses and recover safely

- [SAFE-001: Repair a malformed response](implementation/06-repair-recovery/README.md#safe-001-repair-a-malformed-response)
- [SAFE-002: Exhaust or refuse repair](implementation/06-repair-recovery/README.md#safe-002-exhaust-or-refuse-repair)
- [SAFE-003: Handle process and validator failures](implementation/06-repair-recovery/README.md#safe-003-handle-process-and-validator-failures)
- [SAFE-004: Protect concurrent and interrupted runs](implementation/06-repair-recovery/README.md#safe-004-protect-concurrent-and-interrupted-runs)
- [SAFE-005: Inspect logs and usage honestly](implementation/06-repair-recovery/README.md#safe-005-inspect-logs-and-usage-honestly)
- [SAFE-006: Retain accepted work after a crash](implementation/06-repair-recovery/README.md#safe-006-retain-accepted-work-after-a-crash)

## Integrate Codex and Cursor

- [PROV-001: Translate provider protocols](implementation/07-provider-adapters/README.md#prov-001-translate-provider-protocols)
- [PROV-002: Handle discovery and authentication failures](implementation/07-provider-adapters/README.md#prov-002-handle-discovery-and-authentication-failures)
- [PROV-003: Handle portable process invocation](implementation/07-provider-adapters/README.md#prov-003-handle-portable-process-invocation)
- [PROV-004: Respect capabilities and usage](implementation/07-provider-adapters/README.md#prov-004-respect-capabilities-and-usage)

## Install and upgrade the package

- [PKG-001: Install the actual archive](implementation/08-package-install/README.md#pkg-001-install-the-actual-archive)
- [PKG-002: Ship discoverable documentation](implementation/08-package-install/README.md#pkg-002-ship-discoverable-documentation)
- [PKG-003: Preserve user data across upgrade](implementation/08-package-install/README.md#pkg-003-preserve-user-data-across-upgrade)
- [PKG-004: Expose a CLI-independent core](implementation/08-package-install/README.md#pkg-004-expose-a-cli-independent-core)

## Validate platforms and publish releases

- [REL-001: Gate changes across platforms](implementation/09-ci-release/README.md#rel-001-gate-changes-across-platforms)
- [REL-002: Publish after a validated merge](implementation/09-ci-release/README.md#rel-002-publish-after-a-validated-merge)
- [REL-003: Avoid duplicate or unsafe publishing](implementation/09-ci-release/README.md#rel-003-avoid-duplicate-or-unsafe-publishing)
- [REL-004: Verify the public upgrade path](implementation/09-ci-release/README.md#rel-004-verify-the-public-upgrade-path)



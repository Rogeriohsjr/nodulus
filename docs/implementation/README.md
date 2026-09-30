# Implementation sequence

Status: folders 00 through 08 accepted, with hosted Windows/macOS/Linux validation. Public Apache-2.0 version 2.0.0 is published; earlier automated OIDC release and registry-upgrade evidence is retained in folder 09, which remains open for external release-guard proof.

Read [architecture](../architecture.md) and [testing policy](../testing.md). Work in numeric order; each folder depends on the preceding one. This keeps tests and implementation following the same user flow. A developer can implement one folder and hand off its evidence before the next begins.

| Done | Folder | User value | Method |
| --- | --- | --- | --- |
| [x] | [00-foundation](00-foundation/README.md) | Bootstrap the developer toolchain | Non-TDD setup only; runtime behavior starts in 01 |
| [x] | [01-initialize](01-initialize/README.md) | Initialize a project and discover configuration | TDD |
| [x] | [02-request-intake](02-request-intake/README.md) | Accept requests and reference files | TDD |
| [x] | [03-node-outcomes](03-node-outcomes/README.md) | Execute one node and validate its outcome | TDD |
| [x] | [04-workflow-sequence](04-workflow-sequence/README.md) | Connect validated nodes in sequence | TDD |
| [x] | [05-clarification-resume](05-clarification-resume/README.md) | Pause, answer, and resume | TDD |
| [x] | [06-repair-recovery](06-repair-recovery/README.md) | Repair responses and recover safely | TDD |
| [x] | [07-provider-adapters](07-provider-adapters/README.md) | Integrate Codex and Cursor | TDD for adapters; live compatibility verification is separate |
| [x] | [08-package-install](08-package-install/README.md) | Install and upgrade the package | TDD for package behavior; docs/metadata review is non-TDD |
| [ ] | [09-ci-release](09-ci-release/README.md) | Validate platforms (verified); publish releases (in progress) | Non-TDD hosted configuration; test-first for any custom decision code |

Follow-up maintenance uses the [code-quality plan and AI checklist](../code-quality.md), including `npm run check` before final implementation handoff. Lint/tooling verification is recorded separately from historical scenario RED/GREEN.

## Handoff procedure

1. Verify prerequisite checkboxes against their evidence; a checked box without proof is not a completed dependency.
2. Open the assigned folder, choose its first incomplete scenario, and follow its method.
3. Keep test filenames under tests/scenarios with scenario IDs in names. Create fixtures under tests/fixtures as the slice requires them; these are real inputs, not mock filesystem objects.
4. Update evidence.md with RED/GREEN or the documented non-TDD verification.
5. Check acceptance items only after verification; leave live/hosted work visibly pending.

Example assignment:

> Implement docs/implementation/03-node-outcomes using $nodulus-scenario-tdd. Verify prerequisites, implement scenario by scenario with observed RED then GREEN, and update its evidence/checklists. Do not start 04.

Foundation was implemented using $nodulus-delivery-validation and accepted locally on Windows. The subsequent Luna-builder/Sol-reviewer pass completed INIT-002 through INIT-004. Folders 02 through 08 are accepted. Folder 09 REL-001, REL-002 and REL-004 have hosted/registry proof; REL-003 retains external acceptance. Folder 10 adds bounded live Codex proof on Windows. Cursor and OpenCode/Ollama also have Windows live adapter proof; macOS/Linux live-provider invocation remains unverified.


## Follow-up: repository development workflow

[10-development-workflow](10-development-workflow/README.md) is the user-authorized dogfooding slice: explicit Codex execution policies, a four-checkpoint Luna/Sol workflow, and an isolated live coding pilot. Its prerequisites are the implemented runtime and installed package; remaining folder 09 release-guard exercises do not block local workflow testing. See its checklist and evidence before claiming live completion.

## Follow-up: OpenCode development workflow

[11-opencode-workflow](11-opencode-workflow/README.md) adds a local OpenCode/Ollama builder while retaining independent Luna test review, GPT-5.6 Sol final review and the fixed repository quality gate. Provider behavior is test-first; the live Windows exercise follows fixture GREEN and full local validation.

## Planned follow-up: execution observability

[12-execution-observability](12-execution-observability/README.md) contains research, the proposed log/usage/cost design, twelve scenarios and an ordered AI implementation checklist. **Documentation only: implementation has not started.** It builds on 06/07/10/11; all runtime and live-provider acceptance remains pending.

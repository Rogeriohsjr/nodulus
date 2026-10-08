# Windows archive-test deadline correction

On 2026-10-08, both hosted Windows jobs for `fd2a92d` failed PKG-012 at Vitest's default 5,000 ms deadline: [PR run 37860342852](https://github.com/Rogeriohsjr/nodulus/actions/runs/37860342852) and [push run 37860339121](https://github.com/Rogeriohsjr/nodulus/actions/runs/37860339121). Each job passed the 321 runtime tests and the other 14 archive tests. PKG-012 took 12–13 seconds because it builds, packs, installs and executes the actual archive before examining failure evidence.

The correction gives only PKG-012 the same 120,000 ms outer archive-test deadline used by adjacent package smoke tests. Its 10,000 ms provider timeout, exit-23 fixture, diagnostic values and secret-exclusion assertions are unchanged. This is a package-harness correction, not a production timeout or cancellation change, and the failing test is not presented as a runtime behavioral RED.

Sol reviewed the reported failure and accepted this exact deadline correction. `npx vitest run tests/scenarios/pkg-001-installed-archive.test.ts -t PKG-012` passed locally: one passed, 14 skipped, 8.17 seconds. Hosted results are recorded on [PR #24](https://github.com/Rogeriohsjr/nodulus/pull/24). The outcome-protocol regression is a separate child branch; its uncommitted RED checkpoint is excluded from this parent correction.

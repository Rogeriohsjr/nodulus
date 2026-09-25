# 00-foundation: Bootstrap the developer toolchain

**Status:** complete locally; independently reviewed (Windows). **Prerequisite:** None. **Method:** Non-TDD setup only; runtime behavior starts in 01.

A developer can install dependencies and run the checks without a provider account.

## Developer setup

Requires Node.js 24.x (Active LTS baseline) and npm. Run `npm ci`, `npm run typecheck`, `npm run build`, and `npm run test:scenarios`. The scenario command exits successfully while no scenario files exist; that result means discovery found an empty suite, not that runtime behavior passed.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### DEV-001: Reproduce the toolchain

Given a clean checkout on a supported OS, when the documented setup runs, then locked dependency installation, type checking, build, and test discovery succeed without credentials.

- [x] DEV-001 acceptance verified and evidence recorded.

## Implementation guidance

Select a supported Node LTS and compatible dependency versions; record the baseline in package engines and developer docs. Create strict TypeScript configuration, ESM build, Vitest configuration, npm scripts from the testing policy, and a lockfile. Keep test/support code out of the runtime build. Establish directories only as needed; do not implement workflows here.
Create a temporary runner probe to verify test execution, then remove it; this probe is not product acceptance coverage. Until 01 adds the first scenario, distinguish an empty suite from a passed behavior test.

## Developer sequence

- [x] Identify applicable non-TDD exception and its verification plan.
- [x] Record Node/npm/platform versions and supported baseline.
- [x] Verify clean install, typecheck, build and temporary runner probe; remove the probe.
- [x] Document exact developer commands and absence of runtime acceptance coverage.
- [x] Run available accumulated checks and record limitations.
- [x] Review public contracts/docs; update evidence and only then mark this folder complete in the index.

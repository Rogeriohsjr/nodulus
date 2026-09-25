# Evidence: 00-foundation

Checkpoint history: counts and remaining work below describe this slice at acceptance time. See the [current implementation status](../README.md) and [hosted validation](../09-ci-release/evidence.md#final-code-checkpoint-verification) for later completion.

Status: local setup verified and independently accepted. This slice establishes the toolchain only. No CLI or runtime behavior has been implemented.

## Environment

- Base revision: `5af3ae5efae548b40cb1ebc3492d38e7ab64af9f`
- Working diff: uncommitted; includes pre-existing user documentation changes. Foundation files are listed below.
- OS and Node/npm: Windows; Node.js `v24.15.0`; npm `11.12.1`
- Supported baseline: Node.js `>=24.0.0 <25` (24.x LTS)
- Owner/date: Codex, 2026-09-23

## Scenario evidence

| Scenario | Test file and test name | RED command / meaningful failure | GREEN command / result | Remaining proof |
| --- | --- | --- | --- | --- |
| DEV-001 | temporary `tests/scenarios/foundation.probe.test.ts`, `temporary runner probe executes` (removed after use) | N/A: package/compiler/runner setup is the explicit non-TDD exception in `docs/testing.md`; no runtime entry point exists to express a behavioral failure | `npm ci` installed locked dependencies; `npm run typecheck` passed; `npm run build` passed; `npx vitest run tests/scenarios/foundation.probe.test.ts` passed (1 file, 1 test); after probe removal, `npm run test:scenarios` discovered no files and exited 0 via `--passWithNoTests` | Local Windows only; no runtime acceptance coverage and no hosted/platform matrix |

Expand rows for parameterized cases. Paste concise assertion/output excerpts or link durable logs. Do not invent command output. For an applicable exception, replace RED with N/A, explain why, and record replacement verification.

## Accumulated validation

- Typecheck/build: `npm run typecheck` and `npm run build` passed after clean lockfile install; both passed again after probe removal.
- Scenario suite: `npm run test:scenarios` reported `No test files found, exiting with code 0`; this is empty-suite discovery, not a behavior pass.
- Package checks (when available): not run
- Hosted/live verification (when applicable): not run
- Install audit: `npm ci` reported 0 vulnerabilities.

## Handoff

- Files added: `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `src/index.ts` (empty ESM module marker only).
- Files updated: this folder's README and evidence record. Existing unrelated uncommitted documentation was left untouched.
- Contract decisions/deviations: Node 24.x is pinned as the supported LTS line; package is private and has no CLI or dependencies on any provider. Vitest permits the currently empty scenario directory to succeed while reporting no test files.
- Remaining issues and next eligible folder: independent Luna review accepted after rerunning install/typecheck/build, empty discovery and temporary probe (removed). Folder 01 may begin with INIT-001; first runtime behavior still requires its own meaningful RED checkpoint.

## Review acceptance

Independent Luna reviewer accepted the actual files and independently reproduced the setup checks. Coordinator accepted DEV-001 for local development; macOS/Linux evidence remains deferred to the hosted matrix in 09.

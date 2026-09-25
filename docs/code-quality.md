# Code quality and AI implementation checklist

This is the maintenance plan for changes after the initial scenario implementation. Keep the numbered scenario evidence as history; the implementation index and current CI describe today's status.

## Plan and handoff

1. Identify the user scenario, affected modules, dependencies and docs before editing. Preserve the core/adapter boundary. Assign one source writer and a focused reviewer when using agents.
2. For runtime changes, observe a meaningful failing scenario before implementation. Use real local files/scripts and production entry points; replace only external services. For lint configuration and behavior-preserving cleanup, use the explicit tooling exception in [testing policy](testing.md).
3. Implement the smallest complete change. Run focused scenarios and `npm run lint` / `npm run typecheck` while iterating. Inspect any `npm run lint:fix` diff; automatic fixes are not review evidence.
4. Before final implementation handoff, run `npm run check`. This runs lint, typecheck, runtime scenarios and real installed-package scenarios in sequence. Package checks rebuild `dist`, so do not run them concurrently with runtime tests.
5. Update public commands, contracts, developer instructions and affected acceptance evidence in the same change. Distinguish historical results from current results. Check local Markdown links and leave unavailable live-provider/publication proof open.
6. Report exact commands/results and remaining limitations. The reviewer checks correctness, negative scenarios, architectural dependencies, lint suppressions and documentation. Commit accepted changes and confirm hosted checks for the pushed revision.

## Gates

- Oxlint is a blocking check with zero warnings allowed, not an advisory report. The configuration is versioned in `.oxlintrc.json` and dependencies are locked in `package-lock.json`.
- `npm run lint` covers `src`, `tests` and `scripts`. Correctness rules are errors. Type-aware checking uses `oxlint-tsgolint`; production `src/**/*.ts` also enables `typescript/no-floating-promises`. Tests intentionally create promises to coordinate subprocesses, so this additional rule is scoped to production.
- In `src/core`, restricted-import rules reject paths into adapters, CLI or application composition, and CommonJS imports are banned. This is a static guard, not a complete dependency-graph proof; reviewers must also inspect indirect/barrel dependencies and computed module loading.
- TypeScript strict compilation remains a separate gate. Lint cannot establish runtime schema correctness or validate external JSON.
- Scenario tests protect observable behavior, including subprocess cancellation, persistence, mapping and resume. Real npm archive tests protect install/upgrade behavior.
- CI runs the gates on Windows, macOS and Linux. Release depends on the validation matrix; publishing remains disabled until separately authorized and configured.

Fix findings at their cause. Do not remove assertions, exclude production files, raise warning budgets or disable a rule globally to get a green run. A necessary exception must be narrowly scoped, explain the technical reason, and be called out for review. Preserve deliberate malformed fixtures used by negative tests. Avoid style-only rewrites of unrelated files.

No arbitrary coverage percentage or line-count target substitutes for scenario coverage and review. Formatting is kept consistent with nearby code; this plan does not introduce repository-wide formatting churn. Live provider checks and registry publication remain separate from local quality checks.

## Validation record

The initial lint/tooling rollout is a non-TDD configuration change. Oxlint was selected because its type-aware engine supports TypeScript 7; the available typescript-eslint version declared a TypeScript peer range below 6.1. No incompatible peer dependency was forced and the compiler was not downgraded. See [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware) and [typescript-eslint dependency compatibility](https://typescript-eslint.io/users/dependency-versions/). Its implementation evidence records deliberate temporary rule violations, their failing lint results, removal of the probes, accumulated checks and independent review. These probes are configuration verification, not product scenario tests.

### Initial rollout evidence (2026-09-24)

- Baseline: `0cc242e946e4050434d26523177da8cc8ec1f1fa` on Windows, Node 24.15.0. Added Oxlint 1.85.0 and oxlint-tsgolint 7.0.2003, locked in the dependency tree.
- Temporary probes inside a nested core directory produced blocking diagnostics for a static adapter import, an adapter re-export, a string-literal dynamic CLI import and CommonJS application loading (`eslint/no-restricted-imports`, `import/no-commonjs`). The probe caught a missing root `cli.js` pattern; the corrected pattern rejected it on rerun.
- A temporary production floating-promise probe produced `typescript/no-floating-promises`. All probe files were removed before final validation.
- `npm run lint` and `npm run lint:fix`: passed with zero warnings. Changes remove unused symbols, make diagnostic string conversions explicit, and bind the repair callback at capture rather than at invocation; no scenario assertions were removed.
- Computed dynamic import expressions and indirect dependencies still require review; the restricted-import rule does not prove arbitrary dependency graphs.
- Local Markdown links (34 files) and agent TOML syntax were checked. Historical slice evidence is labeled as history, current source layout/provider guidance is corrected, and local-install instructions include dependencies and Node 24.
- `npm run check`: passed lint, typecheck, 115 runtime/release scenarios and five installed-package tests on Windows. GPT-6 Sol independently accepted the diff and reran lint/typecheck/diff validation.
- Hosted validation runs the new lint step on Windows, macOS and Linux. Consult the current-head checks on [PR #1](https://github.com/Rogeriohsjr/nodulus/pull/1) for terminal hosted results; the older folder 09 checkpoint predates lint and is not lint proof.

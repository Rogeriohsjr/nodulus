# Bounded recovery of accepted task phases

This implements the planning report's **IMP-11 phase-aware recovery** in the packaged task helpers. It does not change core `nodulus resume`. The observability report's older IMP-11 refers to a different packaging fix.

`runPhase` saves the accepted full artifact, its digest and passing check-receipt digests only after checks and frozen hashes pass. Recovery verifies these records and current files, reruns trusted checks, rechecks hashes, and refreshes the source context before emitting a remaining-phase workflow.

| Accepted phases | Generated nodes |
| --- | --- |
| Code | Documentation, review |
| Code and documentation | Review |
| Documentation in a documentation-only task | Review |

```sh
node .nodulus/task-tools/runtime.mjs recover .
nodulus run --workflow task-recover --inputs-file .nodulus/task-recover-inputs.json --request-file correction.md --json
```

The helper creates `.nodulus/workflows/task-recover.json`, the needed `recovery-docs.json` / `recovery-review.json` node definitions, and `.nodulus/task-recover-inputs.json`. It preserves the original node templates. Setup installs `io.mjs`, `runtime.mjs`, `recovery.mjs` and `recovery-state.mjs` together.

Exactly one preparation is allowed per selected execution. Stale files, altered/missing evidence, failed rechecks, legacy executions without accepted artifacts, complete executions and unsupported phase order are rejected. A failed application check may leave the proposed edit for inspection. Never delete execution state to force replay. Local receipts are operator-owned evidence, not signed attestations. There is no concurrent-run lock, multi-file transaction, scheduler or whole-workflow token budget.

## Evidence boundary

- [x] Thirteen scenarios use real workflows, files and subprocesses, replacing only external inference. An aliased-entry regression covers symlink/junction paths used by macOS temporary directories.
- [x] Controlled live localhost Qwen run: one code inference/application, then an injected invalid documentation result; generated recovery calls documentation and review only. Recovery succeeds, the frozen test is unchanged and its assertion passes.
- [x] Installed-package regression observed missing helper files before the setup fix. Final package/hosted results are recorded in the [run report](qwen-recovery-report.md).
- [ ] Unattended implementation: substantial supervisor test/code/docs corrections were required.
- [ ] Parent OBS-006: the separate OBS006A nonzero-exit fixture characterizes existing partial-usage behavior; timeout, truncation, output-limit, readiness/crash cases remain outside this packet.

The documentation failure in the live demonstration was deliberately injected, not a spontaneous Qwen failure. See the run report for actual model failures and contribution attribution.

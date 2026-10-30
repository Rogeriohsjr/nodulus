# P14: atomic resource ownership

Start after the preceding accepted scheduler/state/repair checkpoints. This is the test-first PAR-014 packet. Luna owns new `tests/scenarios/par-014-resource-ownership.test.ts` and may add a small test-only configuration helper. Preserve earlier frozen tests/provider fixtures and production until the test review gate. Other agents may read; do not revert their work.

Use public `runWorkflow`, real project/contract/instruction files and the existing process-backed provider. Every case has explicit release barriers, invocation-entry checkpoint snapshots, bounded cleanup and exact final aliases. Node-list order is the ready tie-breaker. Do not infer concurrency from elapsed speed or raise existing fixture watchdogs.

The frozen policy is within one run. Missing resource entries mean `workspace`, a wildcard conflicting with every nonempty resource set. Explicit `[]` declares independence even from that wildcard. Ordinary named keys conflict only on intersection. Entire key sets are reserved atomically, and a blocked candidate owns neither a slot nor a partial reservation.

## Cases

1. Omit the whole resource map with concurrency above one: independent roots serialize. The next node's invocation-entry snapshot must show the previous accepted node. Also cover one omitted node entry in an otherwise explicit map. Include a valid prototype-name node ID such as `constructor` with its resource entry omitted while a sibling has a named key: only an own map entry may override the workspace default. The graph's safe ID grammar permits constructor; Root source inspection found the current optional bracket lookup can inherit Object.prototype.constructor. This is a candidate behavioral gap until its actual test observes RED; do not forbid the valid ID or change the declared resource policy to avoid it.
2. `workspace` and an ordinary named key serialize even though their strings differ; do not advertise disjoint-key concurrency for the wildcard.
3. `workspace` and an explicit empty set overlap before either child is released, within the configured slot limit.
4. Disjoint ordinary named key sets overlap, while intersecting ordinary sets serialize through acceptance.
5. Ready nodes declared as holder `[a]`, blocked `[a,b]`, independent `[b]`, and another independent path run with enough slots to expose head-of-line blocking. Holder and the independent paths must start while blocked remains unstarted. The blocked candidate must not reserve `b` or consume a slot while waiting for `a`; after both keys are free, it starts once. Use saved acceptance snapshots and final node/call counts to rule out duplicate admission.

The P11 executable-validator tests already prove a slot remains held through validation. Include a conflicting-resource successor's entry snapshot showing acceptance of the previous resource owner so reservations cannot end at provider response arrival.

Run build, lint, typecheck and focused cases with verified permissions. Existing P10 implementation may already satisfy this policy: record characterization GREEN honestly. Diagnose any missing progress with actual checkpoint/child evidence; a bare marker timeout does not establish its cause. Freeze hashes and stop for Sol/coordinator review before a production correction. Scope any correction to the graph scheduler/writer after observed failure; do not add cross-run coordination or filesystem sandbox claims.

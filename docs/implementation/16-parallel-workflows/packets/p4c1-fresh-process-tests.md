# P4C1 fresh-process continuation test packet

Preparation only. Dispatch after Root/Sol accept B2 and its focused GREEN. Root and the separate Luna checked the existing drivers and frozen PAR031 fixture. Source stays unchanged in this packet.

## Ownership and real boundaries

Luna owns exactly two new files: tests/scenarios/par-033-fresh-process-resume.test.ts and tests/fixtures/par-033-fresh-resume-driver.mjs. Reuse the frozen par-031-graph-provider.mjs unchanged (SHA256 36CE63620BE97C9CA0C4C6090B9D56DCEB03EB0820D361CCFB95FACC0940EF32), copied into the owned project with the same real platform wrappers and captured profiles. Reuse existing project helpers, not private PAR031 functions.

Do not use workflow-driver.mjs: it supplies an inline fake ProviderPort that spawnSyncs invocation JSON, bypassing the default provider's readiness/capture/transport behavior. Leave that legacy driver and clarification-resume.ts untouched.

Execute the new driver at its tracked tests/fixtures path so its ../../dist imports resolve; copy only the Codex CLI fixture into the temporary project. The driver imports public runWorkflow/resumeWorkflow from ../../dist/index.js and createDefaultProviderPort(projectRoot) from ../../dist/adapters/providers/default-provider-port.js. A thin forwarding observer records actual invoke/repair/availability/call-evidence activity, including each invocation's answers and call metadata. Preserve exact method arguments, controls and return types; track public and delegated promise settlements. Emit one bounded, uniquely identified JSON result/error envelope plus observations and exit naturally only after owned activity settles. The parent consumes stdout/stderr on success and failure, verifies the envelope identity and operation, and asserts driver close/exit. No paid/live provider is used.

## One real three-process scenario

Build dist after the source freeze before running the case. Create seed -> [B,A], resources [], concurrency 2 and the same isolated A/B answer contracts as PAR031. Start runWorkflow in fresh Node child 1 asynchronously. Observe seed acceptance and both actual initial question marker files/PIDs before releasing either child response. Release A, observe its durable UUID question in the committed checkpoint/pending evidence while B remains live, then release B and await the initial driver close. Admission closure makes this gate necessary; immediate fixture answers can otherwise prevent the sibling from starting.

Capture both runtime request UUIDs, attempt1/call IDs, seed accepted state and all referenced bytes/hashes, immutable inputs, events and raw metrics. Child2 submits valid A answers and must return needs_input with only B unanswered and the singular alias equal to B. It must make no provider method call, fixture probe/inference, call event or metric addition. Child3 submits valid B answers and must return success.

Assert exactly one new invoke for each A/B, attempt2, new call ID and parentCallId equal to that node's original question call ID. Check each exact flat answer object in the driver observation and the fixture's real prompt answer section. Seed must have no new readiness/invoke/call and its accepted record, artifact/result/validation/response evidence remain unchanged. Require exact final outputs/aliases, truthful successful transport files, old event/metric prefixes and exactly two new call-keyed metrics. Check appended event sequence from the saved checkpoint counter, without assuming unsequenced intake events begin at1.

Use raw saved evidence and returned public results. Schema 2 getRunStatus projection belongs to P5 and is outside this test. Sol accepted this packet with the tracked-driver-path, envelope/stdio/close and live-barrier guards above; test authoring remains undispatched until B2 acceptance.

## Bounds, failure evidence and acceptance

One absolute 20s scenario deadline covers all three public driver operations and barrier waits; keep the 20s profile bound, 60s provider-fixture watchdog, one shared 10s cleanup deadline and 35s case ceiling. Attach rejection consumers immediately to concurrently started waits. Retain driver handles, close outcomes/stdout/stderr and each known native PID identity. Release both initial barriers in finally, drain public/delegated activity and all driver/provider processes within the shared cleanup deadline, then delete only after exact native canonical ownership and all exit guards pass with no primary or cleanup error. Preserve the project and primary/cleanup diagnostics on uncertainty. Never widen bounds or turn uncertainty into successful cleanup.

At committed 84190d2, graph resume is absent, but this test is intentionally sequenced after B2. Its first run may be a passing characterization; record that honestly. Any RED must identify the actual failed fresh-process invariant rather than setup/import/lint failure. Root/Sol review the frozen tests, Root runs them, and any runtime fix requires a relevant observed failure and a separate narrow source packet. Lock/crash/corruption/version/workspace-reference/caller-input matrices and CLI/package delivery are excluded here.

# P4E2 answered continuation across another pause

Preparation only. Root identified this additional valid scheduling state while reviewing the two P4E REDs. Sol confirmed it against the actual scheduler and writer and corrected the earlier latest-wave-only continuation recommendation. It remains a required separate regression before P4 acceptance; it has not been executed.

The future author owns only `tests/scenarios/par-035-queued-answer-continuation.test.ts` and `tests/fixtures/par-035-queued-answer-provider.mjs`. Preserve the accepted PAR031/PAR033 and frozen P4E files, all support and production source. Use the real public APIs, default Codex adapter, temporary project and owned local CLI processes. The fixture replaces only external inference.

## Controlled graph and chronology

Use declaration order `seed, d, a, c, b`, three concurrency slots, and dependencies `d <- seed`, `a <- seed`, `b <- seed`, `c <- d`. Set all resources explicitly: `{seed:[],d:[],a:[],c:["shared"],b:["shared"]}`. An omitted resource entry defaults to exclusive workspace access and would invalidate this overlap. Map valid ancestor reports explicitly, and require valid declared artifacts from every node that succeeds.

1. Accept seed, then hold real D1/A1/B1 fixture children at their entry barriers. C is not ready because D is not accepted. Require matching run/node/call/attempt markers and active checkpoint states.
2. Release A1 and B1 to return their first questions while D remains held. Observe both committed runtime requests and closed admission before releasing D. D1 then succeeds during drain. The public pause returns A1/B1 in declaration order; D and seed are accepted and C is still unstarted.
3. Commit A1's valid answer as a partial submission and assert zero provider methods. Submit B1's final answer. On continuation, A2 and C1 enter, C owns B's exclusive resource, and B remains pending at its answered B1 call. Hold both actual A2/C1 children. Assert no B2 availability probe, call admission, marker or fixture inference, using the saved per-wave observer baseline.
4. Release A2 to ask its second question while C remains held. Observe the committed A2 request with C active and B still pending at B1. Release C1 to produce its valid artifact. The new pause lists only A2. B1 remains answered, absent from public outstanding requests, and still matches B's current pending call/attempt. C is now accepted.
5. Answer A2. Require exactly one A3 and one B2, with A3 parent=A2 and merged own A answers, and B2 parent=B1 with its original B answer. Both actual prompts and structured invocations must carry the right values. Require final success and declared output alias order without replay/probes of accepted seed, D or C.

Expected inference identities are exactly seed1, D1, A1, B1, A2, C1, A3 and B2. Use event and current checkpoint evidence to establish admission/resource order; no wall-clock speed comparison or guessed race is an acceptance criterion. The controlled live fixture barriers establish the intermediate states deterministically.

## Evidence and lifecycle

Capture pending and answer bytes/refs/hashes, original question calls/results/validation/raw responses, accepted seed/D/C manifests and artifacts, immutable inputs and every saved history prefix. Verify current B remains on B1 until the final continuation and all old files remain unchanged afterward. Require contiguous appended event sequences from each saved nextEventSequence, call-keyed metric preservation, exact per-wave availability/invocation counts, honest completed transport evidence and no crossed answers.

Use one absolute 20-second scenario/profile deadline, shared 10-second cleanup deadline from cleanup entry, 35-second case ceiling and 60-second fixture watchdog. Release all gates, drain public operations and then all enrolled delegated operations under the same cleanup deadline. Rely on actual child close/adapter settlement, with PID checks only at controlled live barriers. Delete only on success and exact native-owned-project identity; retain primary failures and uncertainties without fabricating cleanup errors.

Freeze files for Root/Sol static review before Root's first behavior run. A first GREEN is characterization of the corrected history implementation. If RED, diagnose the actual missing queued continuation; fixture/schema/lint/type/runner failures are setup failures. No source changes are authorized by this test packet. Do not conflate this case with the two original P4E tests or claim complete P4 acceptance.

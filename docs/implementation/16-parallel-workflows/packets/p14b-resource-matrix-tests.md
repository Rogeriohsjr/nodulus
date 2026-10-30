# P14B: complete resource characterization

P14A is accepted: own-entry lookup executor `478C568588635304FB2BA31E9CB8695141D021A6394DED57EDA83459F513EC1F`, frozen constructor test `199E04207D881534AB0C0488AEF8434EE57BCB48AE6AD5064F09B3E4DAFE22F8`. Root personally read the exact diff; Sol accepted it; Root independently passed all 68 graph cases, exit 0, in p14a-root-green.log. No check is active now.

Luna owns appending seven characterization cases and small local test-only helpers to par-014-resource-ownership.test.ts. Preserve the constructor test and its helpers/assertions/bounds unchanged. Do not edit production, earlier tests or existing fixtures. You are not alone; preserve others' changes. Use real public runWorkflow, initialized project/schema/instruction files, the accepted process provider, actual checkpoint snapshots and real executable validators. Existing support modules may be read/reused without edits. No timers as concurrency proof or bounds increases.

Append these seven cases (the constructor case already covers a partial resource map's omitted entry):

1. Whole resource map omitted: two roots serialize under the workspace default.
2. Explicit workspace versus a named key: serialize despite different names.
3. Workspace versus explicit empty array: both actual children start before either is released.
4. Disjoint ordinary multi-key sets: overlap before either is released.
5. Intersecting ordinary sets: serialize through accepted publication.
6. Atomic ownership / skip blocked / no reserved waiting slot, with roots holder[a], blocked[a,b], independent[b], other[c], maxConcurrency 3. Holder, independent and other must all start while blocked remains unstarted. Add afterHolder[a] depending on holder. Release holder while independent remains held: afterHolder must start and blocked remain unstarted, proving the blocked candidate reserves neither b initially nor a when b is busy. Release afterHolder and independent; blocked's invocation-entry checkpoint must show both accepted. Hold other as appropriate to prove independent progress. Five calls, exactly once each, final explicit aliases.
7. Resource ownership through real executable validation, not just slot retention: roots owner[disk], blocked[disk], independent[], observer[], maxConcurrency 2. Owner and independent start. Release owner's provider, hold its actual validator at its started marker, then release independent. Observer must start while owner is still validating and blocked remains unstarted. Release owner's validator: blocked may enter only with owner accepted in its entry checkpoint. Finish/drain all four. Reuse P11's real validator approach without editing P11 or its support. This distinguishes resource lifetime from the already tested max-slot lifetime.

Serial cases need actual child barriers, second unstarted while first held, saved pre-admission state when appropriate, second invocation-entry first accepted, peak 1 and exact final artifacts/calls. Overlap cases need both real started markers before any release, max overlap within cap and exact data/aliases. Do not assume provider entry order equals ready declaration order when concurrency is permitted. Use guaranteed release/drain and remove only verified safe generated projects; retain uncertain process projects with diagnostics.

Run build/lint/typecheck and one focused file attempt, freeze full file hash/results, then stop for test review. Existing scheduler may already satisfy all seven: label GREEN characterization honestly, not invented RED. If any fail, retain actual checkpoint/child evidence and stop for diagnosis; a missing marker alone does not establish the cause. No full suite or production correction without the next gate.

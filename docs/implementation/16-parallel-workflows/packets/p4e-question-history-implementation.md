# P4E verified question history implementation

Root observed two relevant RED cases after static Root/Sol acceptance. Sequential A/B questions reject answered A1 after accepted A2; repeated A questions reject answered A1 after pending A2. The retained real runs and exact failures are recorded in phase4-evidence.md. Sol diagnosed the actual helper/application paths before this implementation dispatch. Tests and fixtures remain frozen.

## Ownership

One Luna owns `src/core/graph-resume-evidence.ts` and only necessary current-continuation integration in `src/application/resume-workflow.ts`. The existing application loop may already be correct once the verified ledger's requests mean current pending continuations; avoid an unnecessary rewrite. Preserve the writer, executor, runner, adapters, schemas, all tests/fixtures/support and unrelated work. Root owns docs/git/QA. Sol independently reviews the frozen diff. This is a new bounded source packet after an explicit diagnosis, not another blind B2 correction.

## Three verified views

1. All ledger entries remain immutable history. Verify every runtime UUID, node/call/attempt, request ref/hash and content, original provider start/completion evidence, result/validation/raw response, answer ref/hash/contract and answer event. Allow multiple questions per node only when previous questions were answered. Historical entries must agree with their original calls and chronology, rather than the node's newer current call. Preserve all accepted-manifest and optional-metric policies.
2. Current pending continuations are exactly the latest question for each node whose checkpoint phase is pending and whose current call/attempt matches that question. Include an already answered question from an earlier wave when its node has not yet been readmitted. Exclude all historical requests of accepted nodes. Return these current continuations in workflow declaration order as the ledger requests used by application selection/remaining/continuation logic. A pending node without its exact verified latest question is invalid.
3. The latest pause wave is a separate event-backed set. Validate the latest `run.needs_input` IDs against question introduction events since the most recent prior `run.resumed`, in declaration order. The actual executor emits exactly one introduction form per request: first-question admission closure or a later draining node-pending event. Reject duplicate forms and introductions after the final pause. Include already answered IDs from that same wave during partial submissions. An unanswered historical entry outside that wave is invalid. The public outstanding projection contains only unanswered questions.

Use verified event sequence to establish request introduction, answer and pause/resume chronology; object property order is not history. Fold committed answers separately for each node in `request.answered` sequence order, preserving all distinct keys. Existing v1 merges previous answers then the new answer, with later keys winning; retain that policy. Keep original answer files and content-free events immutable. The final selected answer is validated and merged only for its own node, after all saved evidence checks and before the existing checkpoint-last commit.

## Queued continuation audit

Root found, and Sol confirmed, that current continuations can outlive their original pause wave. With three slots, initial D/A/B can run while C depends on D. D succeeds during the A/B question drain. On resume, newly ready C can acquire B's resource before B is readmitted; A2 then asks another question. The new pause lists A2, while B remains pending at its already answered B1 call. The next resume must continue both A2 and B1 with their own saved answers and parent call IDs. Restricting continuations to latest-pause IDs would lose B's lineage.

The two frozen tests establish the observed REDs; this additional scheduling state is source-backed design review, not a third observed test. A separate controlled-resource regression remains required before complete P4 acceptance. Do not silently claim it is covered by the two cases.

## Publication and gates

Do not change `GraphStateWriter` publication order or erase historical pending metadata. Keep all compatibility/request/answer guards before writes, preserve partial-answer zero dispatch, and never probe or admit an accepted node. Do not reconstruct missing optional metrics, change timeouts, add eager duplicate readiness probes or modify provider behavior.

Freeze the minimal source diff and actual hashes before any checks. Root/Sol inspect it; Root runs lint/typecheck/build and the unchanged ABAD8248/1CCD6CFB tests first, then appropriate accumulated controls. Maximum two bounded corrections before a fresh explicit diagnosis. No paid/live providers, publication, release or later phase work is authorized by this packet.

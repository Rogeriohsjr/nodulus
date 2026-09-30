# Qwen review-loop execution and hiccup report

2026-09-29, phase F. User authorized implementation after the model comparison. This checkpoint adds a bounded review-revision controller to the packaged task helper. It is **supervised development**, not an autonomous Qwen implementation. OBS-006–012 are not completed by this change.

## Accepted observations

- Scenario RED: behaviorless controller returned unsupported instead of accepted/exhausted. CLI RED: loop command was absent. Guard RED: prior completion was overwritten and crash inspection command was absent. Import/setup failures encountered later are not behavioral RED.
- Real files, checks and child-process inference fixtures exercise code/docs/review twice, exact feedback, fresh iteration IDs, frozen tests, terminal idempotence, failed check stop, external test mutation and abrupt process termination. Existing completion receipts are protected before inference and at final write.
- Installed local archive live exercise: **26.969 seconds**, six successful Nodulus runs, two iterations; local Qwen wrote value 1, documented it, requested value 2, revised it, updated documentation, and accepted. No supervisor changed exercise files. This was an explicitly controlled reviewer rejection, not evidence of independent defect discovery.
- Frozen test SHA-256: 68497228d2621d941419f5f1e351431b9cfbb4cebb89cab6b283a1f3ed6193a4, unchanged. Real RED asserted positive integer; final source exports 2 and document describes 2. Reentry produced no seventh run.
- Six live boundary calls reported normalized input **9,487**, output **502**, provider cost **0 USD**. This is local provider telemetry, not a measurement of electricity or Codex/Sol usage. Available transport records and call IDs are retained. Other failed builder calls have incomplete usage; do not infer zero.

## Attribution and limits

Qwen generated test/helper/controller/bridge drafts. The supervisor fixed test fixtures, rewrote the rejected controller, corrected helper state paths/read errors/lock cleanup, integrated CLI dispatch, added guard/package coverage, and corrected bridge diagnostics/path/imports. The bridge correction still supplied a placeholder output path; it was integrated explicitly at the assigned path with that deviation recorded. Raw drafts remain unchanged. Qwen's first review used the wrong artifact name and was rejected; its correction found no concrete flaws. GPT-5.6 Sol found completion collision and interruption inspection gaps; fixes and additional tests address them. Final independent review and full quality gate are recorded below when complete.

Supported: fresh selected runtime TDD packet; initial iteration plus 0–2 corrections; one code file and one document per iteration; valid review rejection loops with exact summary. Checks run again after both writes. Failed checks, malformed responses, unsafe proposals and uncertain interruptions stop. Automatic failed-check revision, crash continuation and additional stronger-review scheduling remain pending. Use an isolated checkout and one task executor; locks do not coordinate arbitrary editors or legacy commands.

## Machine/configuration experiments

Windows, Node 24.15.0, OpenCode 1.18.32, Ollama 0.35.0, RTX 5070 Ti 16 GiB and about 61.6 GiB system RAM. Qwen3.8 27B Q4_K_M remains installed; prior comparison is separate evidence. A reused-weight 12K-context alias was added with num_predict 8192, temperature 0.1 and seed 42. It did not solve the controller task; 600-second adapter cap still applied. The 8K 27B profile used roughly 79% GPU/21% CPU and about 14 tokens/s; 12K roughly 77% GPU/23% CPU and about 13 tokens/s in observations. These are samples, not a benchmark guarantee.

The eventual microtask/live profile used local Qwen2.5-Coder 14B, 8K context, 3072 requested output, title agent disabled, automatic compaction/pruning disabled, all tools denied and only Ollama enabled. Both model and small_model point to the same local alias. A temporary proxy binds only 127.0.0.1:11435 and forwards to 127.0.0.1:11434, forcing reasoning_effort none. No GPT builder fallback. Global OpenCode configuration and firewall were not changed. Alias/config experiments are local; the proxy is not a product dependency.

## Hiccups, causes and outcomes

| Observation | Evidence and likely explanation | Action and outcome |
| --- | --- | --- |
| 27B thinking exhausted time/output without final artifact | Low thinking consumed 4096 completion tokens and returned no final text. Larger context/output also timed out. More deliberation was not useful on these assignments; exact internal cause is unknown. | Tried no thinking and smaller packets. Some drafts arrived faster, but semantic mistakes remained. |
| Hidden title generation | Two upstream calls despite one Nodulus boundary call; fixed title argument did not remove it in the observed setup. | Disabling title agent reduced this to one observed request. Count provider-internal calls separately. |
| Automatic compaction after a complete answer | Captured main answer, summarization and continuation; overall call timed out. | Disabled automatic compaction for bounded artifact-only calls. This is unsuitable as a blanket recommendation for long interactive sessions. |
| One file was still too complex | Controller draft combined state, locking, journaling, application and transitions; rejected code skipped runPhase and fabricated success. | Split state/controller/bridge, one correction per packet, then explicitly attributed supervisor roadblock fixes. This did not establish autonomous implementation. |
| 14B fast but wrong | Controller drafts took about 17 seconds yet skipped application; bridge misread an explicit envelope example. | Executable assertions and source review prevented false acceptance. Keep semantic gates after JSON validation. |
| Review missed concrete defects | Qwen review offered generic approval; Sol found existing receipt overwrite and crash inspection gap. | Added regression scenarios, exclusive receipt creation and read-only loop-status. Keep independent review at stable checkpoints. |
| Supervisor integration mistakes | Fixture/new-module path and later shared-test extraction errors caused setup failures. | Corrected separately, retained logs; do not count them as behavioral RED or blame model alone. |

## Product improvements with motivating scenarios

1. **Provider call visibility/configured overhead:** a user budgets one node, while OpenCode launches title and compaction inference. Capture subcall evidence where available and expose configuration guidance; compare actual HTTP/CLI records with boundary counts before claiming savings.
2. **Measured packet readiness:** a planner calls a one-file controller small, but it spans five responsibilities and local Qwen invents transitions. Classify stateful orchestration as multiple packets with concrete helper signatures; measure accepted-without-edit rate, not JSON success rate. This run still needed supervisor implementation.
3. **Bounded reviewer feedback:** valid changes_required previously stopped the sequential workflow. The new controller now routes that exact feedback and requires new docs/checks/review; six-call fixture and live proof demonstrate the benefit.
4. **Stop-and-inspect durability:** a process can die after applying a file but before recording completion. Read-only status exposes durable phase and remaining lock without replay. A future recovery feature must prove crash-window idempotence before removing locks or scheduling calls.
5. **Completion identity protection:** rerunning the same task/context could replace historical acceptance. Preflight rejection and exclusive writes preserve the earlier receipt; collision scenarios now cover both early and late arrival.

## Trial ledger

Status is Nodulus envelope status, **not code acceptance**. Primary and explicit correction calls have separate rows; timed-out internal subcalls may not have complete token totals. Raw requests, artifacts, transport and receipts are preserved locally under .nodulus/phase-f and referenced temporary project run stores; they are intentionally not committed wholesale.

| Packet | Run ID | Seconds | Envelope |
| --- | --- | --- | --- |
| loop-controller-14b-corrected | 80fdac19-4c32-4580-835d-d07fe9d0fac9 | 16.5 | success |
| loop-controller-14b | 367eacd3-32da-460d-9e31-4c391fd7cb42 | 17.2 | success |
| loop-controller | d5fb6f44-3521-481e-bf0f-5fe27fa04161 | 25.8 | success |
| loop-provider-corrected | 41a9c2df-52f6-47b0-8ab8-9951db16acfc | 16.2 | success |
| loop-provider | 94671d85-2355-4f4e-a02e-0cb94dd12b30 | 15.1 | success |
| loop-state-corrected | 18791f10-51ec-44f4-b739-c4ace54335c0 | 73.4 | success |
| loop-state | d5f8cd94-d44f-44c6-8923-ca039dd4ee04 | 80.0 | success |
| qwen-loop-review-corrected | 3e5b3e43-f399-4caa-8fb4-860eafeeb3f0 | 6.0 | success |
| qwen-loop-review | 3e879a4f-e053-46ce-8e68-1d336b6b62c6 | 6.1 | error |
| rework-implementation-12k | 16d4e9e7-e886-4a50-8032-b8225f0278ea | 602.3 | error |
| rework-implementation-corrected | 29fff63c-9f83-460b-ad6d-309b334a1f27 | 304.2 | error |
| rework-implementation | 718f258c-6448-4607-a27d-b4b5ee593d67 | 602.3 | error |
| rework-tests-corrected | 31592db3-707e-416f-b88b-ae4afe32595b | 16.9 | error |
| rework-tests-low | 16eb13e2-d6f8-4c7c-bbb9-edd38f16fe3f | 302.3 | error |
| rework-tests-no-thinking | 1cffe7b7-134e-4136-b00c-162de6e9ccdb | 180.3 | success |
| rework-tests-no-title | a37d9280-547f-450b-8a50-d66ea233ae83 | 302.2 | error |
| rework-tests-title | e0717914-254f-418c-bf8e-2a75d4069ad2 | 302.8 | error |
| rework-tests | de268f31-c368-4909-ae0a-061c19b13827 | 303.3 | error |

Official configuration references: [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [thinking](https://docs.ollama.com/capabilities/thinking), [OpenCode configuration](https://opencode.ai/docs/config/). Title/compaction observations were checked against OpenCode commit 545f51d26cc39a907d2867492d498d9607ea5fa4, not assumed for all versions.

## Validation checkpoint

Full npm run check passed: lint, typecheck, 244 scenario tests and 9 installed-package tests on Windows. GPT-5.6 Sol final focused re-review: ACCEPT, no actionable P1/P2 findings within the documented scope. Hosted platform checks remain separate. No release/publish performed.

---
name: nodulus-task-packets
description: Decompose a Nodulus scenario into small, verifiable local-Qwen work packets, then monitor execution, artifact validity, usage and review evidence. Use before assigning a small model a multi-file runtime scenario.
---

# Plan small work packets

The coordinator plans and verifies; Qwen generates tests and production code. Use the [supervised artifact workflow](../../../examples/qwen-artifact-workflow/README.md) when the local model cannot reliably make tool edits. Record coordinator integration separately from model work. Keep the approved scenario intact. Decomposition may complete only a named subset; do not mark the parent scenario complete until all its requirements are evidenced.

1. Inspect the scenario, current production function and one working neighboring test. Resolve unclear paths, field names, protocol details and helper signatures yourself before dispatch. Unknown requirements are planning gaps, not choices to leave to the worker.
2. Split by observable behavior and dependency, not arbitrary lines of code. Start with one provider, one happy-path contract and one test file. Follow with its negative cases and then other providers. Separate test writing, implementation and review. Define exactly what remains outside the packet.
3. Write each packet using [the template](references/packet-template.md). Give concrete paths, fixture entry points and expected observations. Explain known traps from actual failures. Do not include a complete prewritten implementation or flood the request with the entire architecture and prior conversation.
4. Preview the assembled request. A useful initial target is at most 800 words per worker packet and two required source reads; split larger packets when possible. This is a context target, not a tokenizer or hard model limit. Keep the planning skill out of the worker prompt; send only the chosen packet and a short execution contract.
5. Snapshot the working diff and allowed-file hashes. Dispatch through installed Nodulus using the verified localhost OpenCode profile. No automatic GPT builder fallback. Default experiment budget: four primary Qwen calls plus at most one correction per rejected packet, and one focused Sol review at the final stable checkpoint. Record actual repairs separately. Timeouts limit time, not tokens.
6. Immediately after EVERY primary call, compare `git status --short --untracked-files=all`, tracked diffs and allowed-file hashes against the snapshot, including unexpected new files. Inspect task-owned ignored files separately. This manual scope check is mandatory before coordinator acceptance; the example does not enforce file scope automatically. Reject unexpected edits even if a runtime validator passes. Independently run the fixed scoped test command. RED requires an assertion about the missing behavior; missing imports, syntax errors, vacuous passes and invented reports are rejected. Check raw output, repairs, artifact, validation and checkpoint agree. A schema-valid report is a claim, not evidence. The implementation packet has no automatic quality validator; coordinator GREEN evidence is required before review. Do not treat its successful run status as accepted work.
7. Freeze the accepted test before implementation and compare its hash afterward. Pass actual RED evidence into the implementation packet. Reject the packet if Qwen changes requirements, weakens tests or modifies unassigned files. At the correction budget, reassess the model/configuration and packet instead of repeating the same prompt. Preserve rejected drafts outside the test suite. If the user authorizes coordinator roadblock fixes, make them explicit in the ledger and retain test-first evidence; never report those fixes as autonomous Qwen work. A packet stopping condition does not cancel a broader user-authorized completion task.
8. Review the stable result with Qwen and then the user-selected Sol model. Run the full quality gate once at final acceptance. Record remaining gaps before committing accepted changes.

## Report and improve

Keep a per-packet ledger: request size, model/provider and version, run/session IDs, elapsed time, calls/repairs, actual test results, scope/hash checks, artifact validity, reviewer findings and disposition. Obtain available usage from the captured provider transcript or explicit session export; scope and deduplicate by IDs. Label unknown metrics and provider-reported zero honestly. Local inference still consumes compute; coordinator/Sol usage is separate and may not be measurable here.

Finish with accepted behavior, incomplete behavior, failures, observed usage, and prioritized Nodulus improvements. Distinguish an instruction change from a required runtime fix. Update this skill only from demonstrated failures. Do not lower tests or accept an artifact simply to make the experiment successful.

If an explicit correction reads a file but ends with prose promising an edit, stop that packet at its correction limit. Do not keep expanding the specification. A separately budgeted disposable edit-capability probe can test the read-to-edit transition without touching product files: one sentinel replacement, one fixed assertion, one primary call, zero correction, short timeout, and independent hashes. Report it as a tool probe, never product RED/GREEN. If even that fails, stop writer assignments until the provider/model setup changes and is retested.

## Lessons from the OBS-001/002 completion

- Confirm locality for every configured role, including OpenCode's `small_model`; use an explicit localhost endpoint and enabled-provider allowlist. Record the actual model alias/base and CLI versions, not only the intended model name.
- For artifact-only calls, deny tools and provide actual source/helper signatures in the request. JSON-object mode reduced envelope formatting failures in the measured run. Include the complete `status/artifacts/name/contract/data` wrapper; prose descriptions alone produced wrong top-level keys.
- Check both envelope and payload: Qwen returned Markdown fences inside a schema-valid source string. Reject or explicitly record supervised normalization before applying; a valid artifact is not compile or test evidence.
- Do not silently rewrite an immutable raw artifact to make it look accepted. Keep integration receipts and rejected outputs. Reviewers need the integrated diff and actual checks, not the model's summary.
- A small successful correction is not proof that larger tasks work unattended. Retain the stable focused Sol review gate and report local inference separately from coordinator/reviewer account usage.

## Lessons from OBS-003–005

- Include one literal provider record and the exact typed return shape. Separate counter validation from protocol extraction and normalization. Drafts that combined these invented field owners, helper signatures and version names despite lengthy prose.
- Choose one payload representation per node when possible. A 9B draft returned both content and edits and consumed two envelope repairs before its still-incorrect code could be inspected. The documentation node now uses full content only.
- Run the fixed behavioral/compiler checks before accepting code. Record omitted assertions or coordinator corrections explicitly; schema acceptance and model self-reported checks are not evidence.
- Add a documentation checkpoint after accepted implementation. Supply exact current evidence, then verify provider/version qualifications and pending scope against source. Two schema-valid documentation drafts still misstated normalization. File existence gates need factual review too.
- Change model/configuration as an experiment with a recorded incident and outcome, not as proof that a larger model solves development. The 14B alias yielded usable microfunctions; both 9B and 14B still required corrections. Preserve failed runs and distinguish hypotheses from observed causes.

- Run the final package/check gate after documentation changes too. A new source-valid user-guide link failed installed-package CI because its target was absent from the archive allowlist. Source links and an earlier package pass are insufficient for a later changed artifact.

## Lessons from the reusable planning pilot

Use [the packaged planning workflow](../../../docs/task-workflow.md) to prepare explicit source/check context and classify ready/split/blocked work. Keep model tools denied and require a reviewed test hash. A test name/RED substring does not prove meaningful coverage: inspect the exact assertions, then freeze the file and recheck all captured hashes after RED. Bind dependency receipts to the exact task definition and repository.

Include lint/typecheck alongside the focused behavioral command before dispatch; the OBS007A draft passed its behavior check but failed unused-variable lint. Always include a literal complete outcome wrapper for each node. A docs envelope failure after accepted code requires a bounded remaining-phase correction, not replay of the code node. This helper currently needs supervised recovery; record that intervention. Documentation-only work uses task-document with concrete replacement checks; upgrade behavior still requires RED/GREEN.

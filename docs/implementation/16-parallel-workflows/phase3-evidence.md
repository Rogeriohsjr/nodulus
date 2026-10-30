# Phase 3 evidence

Prerequisite: P2 a76d8d58df8cc69b7211eea0cb7c4e62ff6cb7e0 passed Root's full 579 runtime/17 installed-package gate and all exact-head Windows/macOS/Ubuntu push/PR checks, with titles passing and publishing skipped. Root created codex/parallel-03-joins from that head. P3 passed its complete local exit gate; its hosted head remains to be validated.

## PAR-020 full join and executable validation

Luna wrote one new test using public runWorkflow and the real graph child provider/validator. Root read the entire file; Root/Sol required actual saved validator verdict, fail-closed PID checks, independent release-error handling followed by all drains, and correct shared deadlines. Sort/object-string diagnostics were corrected without changing semantic assertions or old bounds; setup/lint findings are not RED. Final test090B3542375638974830D06B22FDDB13357AF51F9E81BAE4543628BB6F4D40F7.

Root scoped lint passed, then independently observed 1/1 passing characterization in 1.31s, .nodulus/checkpoints/parallel-phase2/p3a-root-characterization.log. The actual witness used the slot freed by fast acceptance while slow's real validator remained active and join stayed unprobed. Join entered only after both parent checkpoints exposed accepted evidence; exact inputs, saved result/validation/response/artifact hashes and executable verdict were verified. Sol accepted the final frozen corrections. No behavioral RED or engine change was needed.

## PAR-021–024 nested/subset joins and named outputs

Separate Luna wrote one real-process case with a non-topological declaration order, seed/left/leaf nested fork, direct/transitive join mappings and a held right terminal omitted from every output alias. Root read the full test and required comparator/type cleanup plus a marker observer that tolerates actual process completion being noticed after the public result; no assertions or bounds were weakened. Final testA5464E1496C138302C4F451F3673560EEB88B502FE1865FD50E6392524F9CC68.

Root scoped lint passed, then independently observed 1/1 passing characterization in 1.91s, .nodulus/checkpoints/parallel-phase2/p3b-root-characterization.log. Join entry/acceptance and exact mapped artifact hashes occurred while the unrelated right path remained active. An explicit event-loop observation found the public run unsettled. Only after right finished were all declared nodes accepted, with API and outputs.json aliases in deliberate noncompletion order. Sol accepted the final frozen changes. This verifies existing behavior rather than inventing RED.

## PAR-025 explicit empty/unavailable artifacts

Separate Luna wrote four real-child/public-API cases. Root reviewed the entire test and fixture, removed serializer-format assertions, and required accepted result/validation contents alongside their hashes. The first combined run passed four of six P3 cases; two assertions incorrectly expected a structured error code inside the human error message. The stored code and actual validation cause were correct. This was a test assumption, not behavioral RED. Luna corrected the assertions without changing source, fixtures, time limits or validation requirements; Sol accepted the final correction.

Final test hash: 08AA604023A78AE809406A87D641097F7CCEEBA6F36187970F856E4CFA27EC3B. Fixture hash: 840BF3248FF52B5E4049267150D32EC3C44121C2BF0314D6F4B664944B2C1EB8. Root's global lint and later scoped lint passed. All six P3 cases passed together in 2.08s, .nodulus/checkpoints/parallel-phase2/p3-root-characterization-corrected.log. Explicit empty/unavailable artifacts were accepted and delivered unchanged downstream. Missing/invalid artifacts remained unaccepted, with persisted validation diagnostics and no downstream probe, provider call or fallback artifact.

These are passing characterizations of the P2 engine. Full P3 integration, its exact hosted head, P4 recovery and P5 delivery remain required. The stack stays draft and unmerged.

## Complete local exit

Root independently ran npm run check at the frozen P3 tests and unchanged P2 source: exit0, lint/typecheck/build passed, 121 runtime files / 585 tests passed in 147.52s and 17 installed-archive tests passed in 69.97s. Log: .nodulus/checkpoints/parallel-phase2/p3-root-full-check.log. Expected failure-fixture diagnostics do not change the passing result. Source graph-node-runner remains A5F1102ECE7ABECD639868E4FA203D47E8BDA019C20DC84CB85B5AA0635C55C2. Exact-head hosted validation remains separate and gates P4 dispatch; no live inference or merge was performed.

## First hosted head

Root saved ad78303 as draft [PR34](https://github.com/Rogeriohsjr/nodulus/pull/34), based on PR33. Both Linux jobs, macOS PR, title checks passed; publication skipped. macOS push exposed an existing acceptance-order test race, while Windows jobs failed separately in fixture lock acquisition and owned-root removal. All six new P3 cases passed in these jobs. [Focused harness diagnosis](packets/p3-hosted-harness.md) records exact jobs, unchanged bounds and authorized test-only corrections/diagnostics. P3 hosted acceptance and P4 dispatch remain open; earlier local success is not relabeled as hosted success.

Root/Sol accepted the deterministic acceptance barrier and failure-only diagnostics after bounded corrections. Root's4-case persistence and15-case Windows/P3 controls passed. The next full gate failed584/585 on a separate early fixture-child exit, with archive tests not run; the incident, physical retained evidence and source-backed diagnosis remain recorded in the linked packet. A narrowly corrected process diagnostic/abort observer subsequently passed Root's single4-case control with all original bounds. A new test-only checkpoint now requires its own complete local and hosted gates; all production files remain unchanged.

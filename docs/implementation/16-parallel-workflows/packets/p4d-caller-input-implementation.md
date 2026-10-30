# P4D caller-input implementation

Prerequisite: Root's first actual PAR037 execution at test76417AB9/fixtureB3FD80F2 produced three relevant RED in1.15s. Missing caller input returned CALLER_INPUT_MISSING and invalid data returned MAPPED_INPUT_INVALID after node/call admission. The earlier missing fixture-directory attempt was setup only. Root/Sol accepted the frozen tests and the bounded design below. No source edit is authorized until the H1 writer freezes.

## D1: pause before admission

The sole Luna writer owns `src/core/execute-graph-workflow.ts`, `src/core/graph-state.ts`, a new pure `src/core/caller-inputs.ts`, and only the shared-helper extraction/import in `src/core/execute-workflow.ts`. Do not import a concrete provider/storage/CLI implementation into core. Reuse the existing v1 validation and caller-contract semantics through the pure helper; do not broaden or change v1 behavior.

After captured context/reference verification and writer construction, validate every declared workflow input against its captured contract before the scheduler or any node admission. Missing and invalid declared inputs produce one runtime UUID caller request: nodeId:null, attempt:0, questions keyed by input names, and the answer contract built from captured definitions. Persist exact pending/<UUID>.json bytes/ref/hash. Keep inputs.json immutable and every node not_started/attempt0, with no call/attempt tree, node/provider event or provider method.

Use one queued writer commit with real request bytes, a content-free graph.admission.closed introduction (requestId, kind:caller_inputs, nodeId:null, attempt:0), followed by run.needs_input with requestIds. Publish the checkpoint last, with phase execution, needs_input and admissionClosed:true. Keep existing node-question behavior unchanged. The unique caller introduction supports later request chronology without inventing a provider call.

Root/Sol review the frozen diff and Root runs lint/source types/build plus unchanged PAR037. D1 may pass every initial-pause assertion while all three cases remain RED at the separate answer/preflight boundary; record that actual outcome. Do not invent a passing case or insert a temporary feature gate.

## D2: verify and resume the caller answer

After D1 freezes and is reviewed, the next sole-writer packet owns `src/core/graph-resume-evidence.ts`, `src/application/resume-workflow.ts`, and a narrow caller-answer writer method in `src/core/graph-state.ts`. The pure caller helper may be imported unchanged. Tests/fixtures and all existing node history/optional metric guards remain frozen.

Discriminate caller and node ledger entries. A caller request has null node identity, kind caller_inputs, attempt0, exact UUID/ref/hash, no fictional provider call/attempt evidence, captured-contract equality, and exactly one valid pre-admission introduction before its pause. Validate committed caller answer bytes/hash/schema and the content-free answered event. Later node waves must preserve this historical answered caller request without scheduling it as a node continuation.

Derive effective caller inputs from immutable captured inputs plus verified caller answers in answered-event order; compare that derivation with the checkpoint. Use those effective inputs when validating later node/accepted evidence and creating the continuation. Never rewrite inputs.json. Keep the existing run lock, captured-state guards, workspace-reference preflight and answer validation before mutation.

The caller answer commit writes bare answers/<UUID>.json, answer ref/hash, request.answered kind caller_inputs/nodeId:null and run.resumed events, and the updated callerInputs/running checkpoint last in the existing queue. Pass cloned effective CapturedInputs and captured profiles/instructions to the normal scheduler. Start root at attempt1 with no node-question parent call, and use normal admitted-node availability; no duplicate eager provider probe.

Root/Sol source review, unchanged PAR037 GREEN and legacy/graph controls are required. Add a separately reviewed mixed caller-then-node-question regression before final P4 acceptance: caller answer must remain available as mapped input while later node answers stay isolated and history verifies across fresh operations. The complete ordinary local/hosted P4 gate and P5 still follow.

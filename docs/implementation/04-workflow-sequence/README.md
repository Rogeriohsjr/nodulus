# 04-workflow-sequence: Connect validated nodes in sequence

**Status:** accepted locally on Windows. **Prerequisite:** 03-node-outcomes. **Method:** TDD.

A caller can run analyze -> implement -> review and trust the artifact handoffs.

Read [architecture](../../architecture.md) and [testing policy](../../testing.md). Record work in [evidence.md](evidence.md). Stop at this folder's scope unless the user assigns more.

## Acceptance scenarios

### FLOW-001: Map artifacts through a complete workflow

Given three ordered nodes with explicit mappings, when all succeed, then each provider request contains only its declared inputs and final output references the accepted deliverables.

- [x] FLOW-001 acceptance verified and evidence recorded.

### FLOW-002: Stop downstream execution

Given the middle node fails validation or returns error/needs_input, when run proceeds, then later nodes are never invoked and earlier accepted artifacts remain available.

- [x] FLOW-002 acceptance verified and evidence recorded.

### FLOW-003: Reject invalid wiring before inference

Given duplicate node IDs, forward references/cycles, missing output names or incompatible declared contract IDs, when preflight runs, then it fails without provider calls.

- [x] FLOW-003 acceptance verified and evidence recorded.

### FLOW-004: Resolve shared profiles predictably

Given two nodes referencing one profile, when that profile is changed before a new run, then both use the new settings; an already captured run keeps its prior resolved settings.

- [x] FLOW-004 acceptance verified and evidence recorded.

## Implementation guidance

Implement sequential scheduler, named artifact mappings and graph preflight. For v1 require matching declared contract IDs at mapping boundaries, then validate actual mapped data again; do not attempt general JSON Schema subtype inference. Save completion before starting the next node. Export core invocation separately from CLI formatting for future clients.

## Developer sequence

- [x] Build real fixture files/scripts for the first scenario and write its entry-point test.
- [x] Run it before implementation; record the relevant RED assertion.
- [x] Implement until GREEN; repeat scenario by scenario, including negative variants.
- [x] Refactor while preserving scenario coverage; do not replace internal modules with mocks.
- [x] Use a fake that fails if any unexpected node is invoked.
- [x] Assert actual downstream input payloads and retained files.
- [x] Exercise actual production entry point end to end with only provider replaced.
- [x] Run available accumulated checks and record limitations.
- [x] Review public contracts/docs; update evidence and only then mark this folder complete in the index.


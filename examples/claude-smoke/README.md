# Claude Code ping/pong smoke workflow

This additive example runs one short Haiku node followed by one Sonnet node. Each output must match an exact local JSON Schema and validator. The profiles use no custom tools, enable safe mode, disable session persistence, and request at most three turns with an estimated USD 0.05 budget per process. Provider budget limits are estimates and can overshoot.

Initialize a project first. From a Nodulus source checkout, copy only the smoke definitions into the matching `.nodulus` folders, checking each destination first so you do not replace existing files:

```sh
cp examples/claude-smoke/.nodulus/workflows/claude-smoke.json <project>/.nodulus/workflows/
cp examples/claude-smoke/.nodulus/nodes/ping.json examples/claude-smoke/.nodulus/nodes/pong.json <project>/.nodulus/nodes/
cp examples/claude-smoke/.nodulus/instructions/claude-ping.md examples/claude-smoke/.nodulus/instructions/claude-pong.md <project>/.nodulus/instructions/
cp examples/claude-smoke/.nodulus/contracts/ping.v1.schema.json examples/claude-smoke/.nodulus/contracts/pong.v1.schema.json <project>/.nodulus/contracts/
cp examples/claude-smoke/.nodulus/validators/expect-ping.mjs examples/claude-smoke/.nodulus/validators/expect-pong.mjs <project>/.nodulus/validators/
```

Merge these profiles into the existing `providerProfiles` object in `.nodulus/settings.json`, keeping all other entries and the current `defaultWorkflow`. Set `executable` to `claude` or its absolute path:

```json
{
  "claude-haiku": { "kind": "claude", "enabled": true, "executable": "claude", "model": "haiku", "timeoutMs": 60000, "capabilities": [], "maxTurns": 3, "maxBudgetUsd": 0.05, "tools": "", "safeMode": true },
  "claude-sonnet": { "kind": "claude", "enabled": true, "executable": "claude", "model": "sonnet", "timeoutMs": 60000, "capabilities": [], "maxTurns": 3, "maxBudgetUsd": 0.05, "tools": "", "safeMode": true }
}
```

After authenticating with Claude Code, run the smoke explicitly:

```sh
nodulus doctor --json --project <initialized-project>
nodulus run --project <initialized-project> --workflow claude-smoke --request "Return the smoke ping and pong." --json
```

The run uses at most two Claude CLI processes, one per node. It does not fall back to another model or retry a provider action. A successful Nodulus result means both artifacts passed the local schema and exact-value validator. Fixture tests do not establish live compatibility; run this only when the profiles are authenticated and a live provider check is authorized.

# Provider adapter compatibility

The default CLI adapter is selected by the captured profile's explicit `kind`. A profile used by the default adapter has this shape:

```json
{
  "kind": "codex",
  "enabled": true,
  "executable": "codex",
  "model": "optional-model-name",
  "timeoutMs": 600000,
  "capabilities": []
}
```

Use `kind: "cursor"` for Cursor's `agent` executable. `executable` can be an executable name or an explicit path. `model`, `timeoutMs`, and `capabilities` are optional. Provider credentials do not belong in settings; use the provider's own authentication. The intake snapshot preserves the provider kind and safe runtime options, never credential fields. Generic injected providers can continue to use profiles without a `kind`.

The Codex adapter probes `--version` and `login status`, then runs `exec --json --ephemeral --cd <project> --output-last-message <file> --output-schema <file> [--model <model>] -`, sending the complete prompt through stdin. Its conservative minimum version is 0.144.4, the locally inspected Codex CLI version whose `exec --help` exposed these flags; this is a local compatibility floor, not a vendor-wide claim. Nodulus validates the returned outcome itself even though it requests the output schema. The adapter does not enable full-auto or permission-bypass options.

The Cursor adapter probes `--version` and `status --format json`, then runs print mode with JSON output and the project workspace. It writes the full prompt as UTF-8 and passes a short prompt that points to that file, avoiding long shell arguments. It accepts only the documented success envelope fields `type: "result"`, `subtype: "success"`, `is_error: false`, and string `result`. Authentication is judged only by the status command's exit code; Nodulus does not infer credentials from undocumented JSON fields. No supported Cursor minimum version has been established: an unparseable version is reported as unrecognized, while any parseable version is allowed pending live compatibility verification.

Both adapters use argument arrays through `cross-spawn`, cap captured process output at 2 MiB, bound execution time, preserve stdout/stderr transport in `.nodulus/runs/<runId>/provider/<nodeId>/attempt-<nnn>/`, and never construct a shell command from prompt or project values. Attempt-specific files prevent a resumed invocation from overwriting earlier diagnostics or captured prompts. Provider usage remains unknown (`null`), and neither concrete adapter offers response-only repair. Codex/Cursor subprocess behavior is fixture-tested only. No live login, inference, or provider compatibility smoke test was run for this work.

Protocol research and source links are recorded in the parent-owned [provider research note](../../provider-research.md).

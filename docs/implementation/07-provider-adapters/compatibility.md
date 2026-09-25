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

Use `kind: "opencode"` for OpenCode with an Ollama model ID such as `ollama/qwen3.5:9b`. This slice supports Ollama discovery: Nodulus runs `opencode models ollama` and requires an exact full ID before inference. Other OpenCode model providers are not yet supported by this adapter. The verified Windows floor is OpenCode 1.18.32. Nodulus then runs `opencode run --format json --thinking --model <ollama/model> --agent build --dir <project>` with the persisted Nodulus prompt verbatim followed by an adapter-owned instruction on stdin. That instruction requires exactly one complete Nodulus system-outcome JSON object as the final assistant response, rejects artifact `data` alone and file output, and shows the `status`/`artifacts`/`name`/`contract`/`data` success shape; the node prompt supplies the actual expected names and contracts. It reads newline-delimited JSON, correlates nested parts to the final assistant message whose `step_finish` reason is `stop`, prefers its text parts, and falls back to its reasoning parts only when text is absent. If the unchanged core validator rejects that final response and the captured final message has a session ID, a profile with `responseRepair` can make up to two response-only corrections with `--agent nodulus-response --session <captured-session-id>`; each correction reuses the same parser and is saved under the original provider attempt's `repair-<nnn>/transport.json`. The project must define `nodulus-response` as a primary OpenCode agent with all tool permissions denied, as in the development-workflow example. Correction never replays the writing `build` action; a missing session or failed correction stops with an actionable error. OpenCode permissions come from the project configuration; Nodulus does not add `--auto` or accept arbitrary arguments. The adapter has live Windows evidence with local Ollama `qwen3.5:9b`; macOS/Linux live compatibility is still pending.

The Codex adapter probes `--version` and `login status`, then runs `exec --json --ephemeral --cd <project> --output-last-message <file> --output-schema <file> [--model <model>] -`, sending the complete prompt through stdin. Its conservative minimum version is 0.144.4, the locally inspected Codex CLI version whose `exec --help` exposed these flags; this is a local compatibility floor, not a vendor-wide claim. Nodulus validates the returned outcome itself even though it requests the output schema. The adapter does not enable full-auto or permission-bypass options.

The Cursor adapter probes `--version` and `status --format json`, then runs print mode with JSON output and the project workspace. It writes the full prompt as UTF-8 and passes a short prompt that points to that file, avoiding long shell arguments. It accepts only the documented success envelope fields `type: "result"`, `subtype: "success"`, `is_error: false`, and string `result`. Authentication is judged only by the status command's exit code; Nodulus does not infer credentials from undocumented JSON fields. No supported Cursor minimum version has been established: an unparseable version is reported as unrecognized, while any parseable version is allowed pending live compatibility verification.

All concrete adapters use argument arrays through `cross-spawn`, cap captured process output at 2 MiB, bound execution time, preserve stdout/stderr transport in `.nodulus/runs/<runId>/provider/<nodeId>/attempt-<nnn>/`, and never construct a shell command from prompt or project values. Attempt-specific files prevent a resumed invocation from overwriting earlier diagnostics or captured prompts. Provider usage remains unknown (`null`); OpenCode alone offers the documented safe same-session response-only correction.

Protocol research and source links are recorded in the parent-owned [provider research note](../../provider-research.md).

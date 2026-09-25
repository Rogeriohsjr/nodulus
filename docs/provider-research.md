# Provider research for folder 07

Read-only research captured 2026-09-24; this is not live-provider execution evidence.

## Codex

Installed local CLI: `codex-cli 0.144.4`. `codex exec --help` confirms stdin with prompt `-`, `--json` JSONL events, `--output-last-message <FILE>`, `--output-schema <FILE>`, `--cd`, `--model`, and `--ephemeral`. Help/version commands made no inference call. Use supported flags rather than shell interpolation. Runtime still validates all results regardless of schema request.

Source: [official developer commands](https://learn.chatgpt.com/docs/developer-commands), plus local help output. Schema-constrained output does not imply side-effect-free response repair; do not advertise that capability without proof.

## Cursor

No `agent` or `cursor-agent` executable was found on PATH during initial discovery. Current official docs describe print/headless mode and `--output-format json`. The JSON terminal success object carries the assistant response in `result`, with `type: result`, `subtype: success`, and `is_error: false`. Failed commands can exit nonzero with stderr and no valid JSON output. This transport envelope is distinct from Nodulus's system outcome inside the assistant text.

No stdin support was established by the pages inspected. Before implementation verify the transport; a captured prompt file referenced through a short argument is a possible file-capable-provider approach. Do not silently move long request content into a shell argument or claim local Cursor compatibility without installation evidence.

Sources: [headless mode](https://cursor.com/docs/cli/headless), [parameters](https://cursor.com/docs/cli/reference/parameters), [output format](https://cursor.com/docs/cli/reference/output-format).

## Verification scope

Folder 07 must read current sources, record protocol samples, test real adapters with executable fixtures, and distinguish these tests from live authenticated runs. The user requested local work first and deferred registry setup. No provider inference, package publication, or external release is authorized by this research note.

## Additional discovery notes (2026-09-24)

Current Cursor installation documentation includes native Windows PowerShell as well as macOS, Linux, and WSL. It names the executable `agent` and documents `agent --version`; native Windows support should not be labeled WSL-only based on older articles. This is documented vendor support, not a local installation or live smoke result.

Cursor authentication documentation describes `agent status`; the parameter reference documents `status --format json`, `--workspace`, `--model`, and print/JSON output. The retrieved pages do not establish a stable authentication JSON field schema or stdin prompt protocol. Do not fabricate either in fixtures; inspect executable output/help when available or report the probe limitation. Credentials should remain in the vendor's existing login/environment rather than Nodulus settings or process arguments.

Codex local `login --help` confirms the `status` subcommand. Official developer-command documentation specifies successful authenticated status exits zero. Only help was run here, with no login changes or inference.

Sources: [Cursor installation](https://cursor.com/docs/cli/installation), [Cursor authentication](https://cursor.com/docs/cli/reference/authentication), [Cursor parameters](https://cursor.com/docs/cli/reference/parameters), [Codex commands](https://learn.chatgpt.com/docs/developer-commands).

## Cursor long-context transport clarification

The current [headless documentation](https://cursor.com/docs/cli/headless#including-file-paths-in-prompts) explicitly supports relative/absolute file paths in prompts and reading those files through tools. A short argument pointing to a captured UTF-8 prompt file is therefore a documented transport option for large context; fixtures should read that exact file and verify its complete content. The actual tool/model reading it remains a live-compatibility check. The [output-format page](https://cursor.com/docs/cli/reference/output-format) also mentions piped stdin, but does not define how stdin combines with prompt arguments, so file transport is the clearer v1 contract. No need to add ACP solely for this scenario.

## Cursor Windows live correction (2026-09-25)

Cursor Agent `2026.09.23-86fc751` was installed with the official native Windows PowerShell installer and authenticated through its browser flow. The live `status --format json` command exits zero even when logged out, with `isAuthenticated: false`; the adapter must inspect that boolean rather than relying on exit status alone. Non-interactive execution also rejects an untrusted workspace unless `--trust` is present. `--trust` is sufficient and does not require `--force` or `--yolo`.

The earlier prompt-file proposal failed live: the final JSON envelope contained the assistant's initial statement that it would read the file rather than the requested outcome. A direct read-only probe confirmed that piping the complete prompt to `agent -p --output-format json --mode ask --trust --workspace <temp>` returns the expected terminal result. The production adapter therefore uses stdin with `-p --output-format json --trust --workspace <project>` and keeps the provider's normal execution mode. The opt-in production-adapter smoke test passed in a temporary Windows workspace; macOS/Linux remain unverified.

# Work packet template

- **ID / parent scenario / phase:** one test, implementation or review checkpoint.
- **Outcome:** one observable behavior; explicitly name the subset that remains pending.
- **Prerequisite evidence:** source revision, accepted upstream artifact and test hash where relevant.
- **Read:** one production function and one test/helper, with exact paths.
- **May edit:** exact files. Everything else is preserved.
- **Fixture recipe:** real production entry point, real temporary files/processes, external inference replacement, required provider-protocol responses.
- **Assertions:** exact expected fields/paths/ordering; distinguish existing behavior from the missing behavior.
- **Command / expected result:** fixed command, meaningful RED assertion or GREEN count, and what counts as setup failure.
- **Forbidden shortcuts:** packet-specific traps, such as optional assertions for required files or equating raw user text with an assembled prompt.
- **Stop / output:** no later packet work; exact artifact contract, actual command/exit and relevant evidence.
- **Budget:** primary call, allowed correction count, timeout; do not represent this as a token cap.

The planner owns ambiguities. The worker owns the actual tests/implementation. Do not hide an unresolved design choice behind "follow best practices."

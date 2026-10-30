# P4H test cleanup ownership

Root found marker-derived numeric termination in older P15/P16 cleanup. Sol independently confirmed the identity risk and reviewed this bounded remedy. No observation attributes the earlier Windows startup failures to these paths. This packet corrects test infrastructure; it claims no runtime RED or production fix.

## H1: actual child closure in the current worker

The sole Luna writer owns `tests/scenarios/par-015-profile-deadline.test.ts`, `tests/scenarios/par-015-native-first-cause.test.ts`, and new `tests/support/owned-native-processes.ts`. All runtime modules, fixtures and behavioral assertions stay frozen. Preserve existing timeout/cancellation/native-cause checks and every scenario/profile/cleanup deadline.

Install a passive `diagnostics_channel('child_process')` subscriber before each public run. These cases are sequential within their Vitest worker; capture every actual child object born in that scope, including provider/validator/termination-helper children. Do not match numeric PIDs or brittle command strings. Observe spawn, errorMonitor, exit and close immediately; keep bounded identity/stage diagnostics without argv, environment, output or prompt content. Do not replace functions, alter signal delivery or fabricate process records.

Cleanup first releases the existing fixture gates, then awaits the actual public and delegated operations and every captured child close under the original shared 10s budget. Handle children added during draining; unsubscribe only after cleanup, including error paths. Remove marker-PID termination and historical liveness polling as cleanup authority. A real unclosed child or unsettled operation requires retained evidence and truthful cleanup uncertainty. Do not manufacture a cleanup error after all required operations have actually closed. No new force-stop is necessary for this packet.

Root and Sol review frozen changes before Root runs the unchanged affected cases. Global lint/source types, explicit strict test/helper types and fixture syntax must pass. Harness acceptance and runtime feature acceptance remain separate.

## H2: child captures already established by the worker

After H1 freezes, the next sole-writer packet covers the five PAR016 scenarios: validator-policy, crash-acceptance, concurrent-write-failure, error-publication and inflight-acceptance. Do not edit their fixtures without a separate concrete need and review.

Sol verified that their worker fixtures await the real runCapturedProcess child close before recording provider_process_captured or returning raw data. Successful reports and intentional crash milestones follow those captures; the parent also awaits the retained worker ChildProcess close. Preserve those actual capture/transport/milestone assertions. On these proven paths, remove redundant marker-PID kill/poll loops.

If a worker aborts before successful report/milestone or capture proof, force-stop only its retained ChildProcess handle if necessary, report nested cleanup uncertainty and retain the project. A marker's finished flag, an old numeric PID or signal0 is insufficient authority. Keep all original timeout, cancellation, publication/crash assertions and deadlines. Root/Sol frozen review and Root's affected-case verification precede the next broad ordinary gate.

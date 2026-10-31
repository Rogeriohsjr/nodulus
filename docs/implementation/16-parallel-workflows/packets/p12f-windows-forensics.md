# P12F1: bounded Windows file-denial evidence

The P13B full gate now establishes `budget_exhausted`, 31 real rename attempts, 1016 ms elapsed, initial/last EPERM and targetKind file. This occurrence did not fail target inspection. No incidental actor is established and increasing the 1000 ms budget is not authorized. Installed handle.exe/handle64.exe were not found on PATH; no utility install or license acceptance is needed.

## Test-only ownership

Luna owns new `tests/support/windows-rename-forensics.ts`, new `tests/scenarios/par-012-windows-forensics.test.ts`, and (during GREEN only) new `tests/fixtures/par-windows-file-forensics.ps1`. Keep all production, earlier tests/helpers, old bounds and current source hashes frozen. Root/Sol review stable checkpoints. You are not alone: preserve other changes.

Freeze the helper as `createWindowsRenameForensicStorage(projectRoot, reportDirectory) -> Promise<{storage, reports, close}>`. Its storage is a thin decorator over one actual LocalIntakeStorage, delegating every real operation/result. Wrap only writeRunFiles to observe an actual run.json Windows rename failure, capture information before normal fixture cleanup, then rethrow the SAME error. Public composition is `runWorkflow(request, provider, {storage})`. No fabricated storage success/failure or internal filesystem mock.

## RED gate

Write one Windows-only public workflow control with the existing real graph process provider and a verified real PowerShell ReadWrite/no-Delete checkpoint lock held until workflow error. Use alpha -> beta. An importable minimal helper stub may truthfully report `status:"unavailable", reason:"probe not implemented"` while delegating all actual storage and preserving the actual exception. This establishes missing diagnostic capability without an import/setup RED.

Expect RUN_STORAGE_FAILED, one original action, unchanged checkpoint, no acceptance/dependent, and a report with status available, the target's actual hash/type/attributes, a native delete-access sharing denial code 32, and a Restart Manager process list containing the known locker PID. A separate same-bytes rename probe must remain EPERM after inspection, proving inspection did not release/delete/change the target. Release/drain locker/provider/helper and verify owned PIDs before cleanup. Non-Windows explicitly skips this OS control. Build/lint/typecheck and one focused run; freeze hashes and stop for test review before implementing the probe.

## GREEN probe contract

Prewarm a hidden normal-policy PowerShell child before model operations. Freeze new helper-only guards: startup 10000 ms, per-query 2000 ms, shutdown 4000 ms plus a 2000 ms owned-process termination confirmation. These do not raise any existing model/fixture/test timeout. Parent query timeout records unavailable diagnostics and rethrows the original filesystem error; helper failure must never become a substitute storage outcome. Capture bounded stderr and retain its owned directory if exit/liveness is uncertain.

Register only the exact owned target and existing sibling temporary paths. Restart Manager calls are limited to StartSession/RegisterResources/GetList/EndSession (EndSession in finally). Never call Shutdown/Restart, kill a reported process, restart Windows, change ACL/attributes/security settings or enumerate unrelated command lines. Record scoped PID/app name/process start identity; a reported process is evidence of use, not proof that it denied rename.

Capture path existence/type/size, file attributes, owner and optional ACL hash, and SHA256 without file contents. Hash with a FileStream sharing Read/Write/Delete so the probe itself does not create a deletion blocker. Native CreateFileW may request DELETE access with OPEN_EXISTING and all sharing flags, but never DELETE_ON_CLOSE/disposition/delete flags; close any successful handle immediately. Record its actual Win32 error (sharing violation 32 versus access denial 5) without interpreting an unobserved cause. The original temporary may already be absent after adapter cleanup; report that honestly.

Use literal argument/request data and validate every path remains inside the generated project run directory. Persist bounded report JSON only into the explicit owned report directory; no prompts, artifact values or broad process snapshots. The actual target/hash and lock must remain unchanged. Syntax/build/lint/typecheck plus the real OS control and prior W controls, then stop for independent review. No production retry policy change follows automatically.

## Primary API references checked by Root

- [RmGetList](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist) and [RM_PROCESS_INFO](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/ns-restartmanager-rm_process_info)
- [RmRegisterResources](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmregisterresources), [RmStartSession](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmstartsession), [RmEndSession](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmendsession)
- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)

P12F2 is a later separate packet: opt-in P13A test-only storage instrumentation, unchanged assertions/bounds, prewarmed probe and one controlled full run. It is not authorized before F1 verification and source review. A non-recurrence is not a cause/fix claim.

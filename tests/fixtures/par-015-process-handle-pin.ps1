param(
  [Parameter(Mandatory = $true)][string]$ControlDirectory,
  [Parameter(Mandatory = $true)][string]$Nonce,
  [Parameter(Mandatory = $true)][int]$WatchdogMilliseconds
)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class P15ProcessHandlePinNative {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(UInt32 access, bool inheritHandle, int processId);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern UInt32 GetProcessId(IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetExitCodeProcess(IntPtr process, out UInt32 exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool CloseHandle(IntPtr handle);
}
"@

function Write-AtomicJson([string]$Name, [hashtable]$Value) {
  $target = Join-Path $ControlDirectory $Name
  $temporary = "$target.$PID.tmp"
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Compress))
  [System.IO.File]::Move($temporary, $target)
}

function Assert-NonceMarker([string]$MarkerPath) {
  $markerItem = Get-Item -LiteralPath $MarkerPath
  if ($markerItem.Length -gt 1024) { throw "Handle pin control marker exceeded its safe read limit." }
  $marker = [System.IO.File]::ReadAllText($MarkerPath) | ConvertFrom-Json
  if ($marker.nonce -ne $Nonce) { throw "Handle pin control nonce mismatch." }
}

function Write-WatchdogDiagnostic {
  param([string]$Stage)
  if (-not $script:watchdogReported) {
    $script:watchdogReported = $true
    try { Write-AtomicJson "pin-watchdog-expired.json" @{ pid = $PID; rootPid = $script:targetPid; stage = $Stage; nonce = $Nonce } } catch { }
  }
}

function Wait-ForSafeRelease {
  $releasePath = $null
  try { $releasePath = Join-Path $ControlDirectory "release-pin" } catch { }
  while ($true) {
    try {
      if ([DateTime]::UtcNow -ge $deadline) { Write-WatchdogDiagnostic "waiting_for_safe_release" }
      if (-not $releasePath) { $releasePath = Join-Path $ControlDirectory "release-pin" }
      $releaseExists = $false
      try { $releaseExists = Test-Path -LiteralPath $releasePath } catch { }
      if ($releaseExists) {
        try { Assert-NonceMarker $releasePath; return }
        catch { try { [Console]::Error.WriteLine("Ignoring invalid release marker while retaining the native handle.") } catch { } }
      }
    } catch { }
    try { Start-Sleep -Milliseconds 10 } catch { }
  }
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($WatchdogMilliseconds)
$handle = [IntPtr]::Zero
$targetPid = 0
$rootExitCode = $null
$exitCode = 0
$handleClosed = $false
$watchdogReported = $false
try {
  Write-AtomicJson "helper-ready.json" @{ pid = $PID; nonce = $Nonce }
  $requestPath = Join-Path $ControlDirectory "pin-request.json"
  $stopPath = Join-Path $ControlDirectory "stop-helper"
  while (-not (Test-Path -LiteralPath $requestPath) -and -not (Test-Path -LiteralPath $stopPath)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw "Handle pin helper startup watchdog expired." }
    Start-Sleep -Milliseconds 10
  }
  if (Test-Path -LiteralPath $stopPath) {
    Assert-NonceMarker $stopPath
    Write-AtomicJson "helper-stopped.json" @{ pid = $PID; nonce = $Nonce }
  } else {
    $requestItem = Get-Item -LiteralPath $requestPath
    if ($requestItem.Length -gt 1024) { throw "Handle pin request exceeded its safe read limit." }
    $request = [System.IO.File]::ReadAllText($requestPath) | ConvertFrom-Json
    [long]$requestedPid = 0
    if ($request.nonce -ne $Nonce -or -not [long]::TryParse([string]$request.rootPid, [ref]$requestedPid) -or $requestedPid -le 0 -or $requestedPid -gt [int]::MaxValue) { throw "Handle pin request identity is invalid." }
    $targetPid = [int]$requestedPid
    $access = [uint32]0x00101000
    $handle = [P15ProcessHandlePinNative]::OpenProcess($access, $false, $targetPid)
    if ($handle -eq [IntPtr]::Zero) { throw "OpenProcess failed for owned root PID $targetPid with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())." }
    $actualPid = [P15ProcessHandlePinNative]::GetProcessId($handle)
    [uint32]$status = 0
    if (-not [P15ProcessHandlePinNative]::GetExitCodeProcess($handle, [ref]$status)) { throw "Initial GetExitCodeProcess failed for pinned root PID $targetPid." }
    if ($actualPid -ne $targetPid -or $status -ne 259) { throw "Pinned process identity or STILL_ACTIVE state did not match the live root." }
    Write-AtomicJson "pin-ready.json" @{ helperPid = $PID; rootPid = $targetPid; handlePid = $actualPid; exitCode = $status; nonce = $Nonce }
    while ($true) {
      if (-not [P15ProcessHandlePinNative]::GetExitCodeProcess($handle, [ref]$status)) { throw "GetExitCodeProcess failed while observing pinned root PID $targetPid." }
      if ($status -ne 259) {
        $rootExitCode = [uint32]$status
        Write-AtomicJson "root-exited.json" @{ helperPid = $PID; rootPid = $targetPid; handlePid = $actualPid; exitCode = $rootExitCode; nonce = $Nonce }
        break
      }
      if ([DateTime]::UtcNow -ge $deadline) { Write-WatchdogDiagnostic "waiting_for_root_exit" }
      Start-Sleep -Milliseconds 10
    }
    Wait-ForSafeRelease
  }
} catch {
  try { [Console]::Error.WriteLine(("P15 handle pin helper failed: " + $_.Exception.Message).Substring(0, [Math]::Min(800, ("P15 handle pin helper failed: " + $_.Exception.Message).Length))) } catch { }
  $exitCode = 74
  if ($handle -ne [IntPtr]::Zero) {
    try { Write-AtomicJson "helper-error.json" @{ pid = $PID; rootPid = $targetPid; message = $_.Exception.Message.Substring(0, [Math]::Min(500, $_.Exception.Message.Length)); nonce = $Nonce } } catch { }
    Wait-ForSafeRelease
  }
} finally {
  if ($handle -ne [IntPtr]::Zero) {
    $handleClosed = [P15ProcessHandlePinNative]::CloseHandle($handle)
    if ($handleClosed) {
      try { Write-AtomicJson "helper-closed.json" @{ pid = $PID; rootPid = $targetPid; rootExitCode = $rootExitCode; handleClosed = $true; nonce = $Nonce } }
      catch { [Console]::Error.WriteLine("P15 handle pin helper could not write close evidence."); if ($exitCode -eq 0) { $exitCode = 75 } }
    } else {
      [Console]::Error.WriteLine("P15 handle pin helper could not close its owned process handle.")
      if ($exitCode -eq 0) { $exitCode = 76 }
    }
  } else {
    try { Write-AtomicJson "helper-closed.json" @{ pid = $PID; rootPid = 0; rootExitCode = $null; handleClosed = $true; nonce = $Nonce; stoppedWithoutPin = $true } }
    catch { [Console]::Error.WriteLine("P15 handle pin helper could not write stopped evidence."); if ($exitCode -eq 0) { $exitCode = 75 } }
  }
}
exit $exitCode

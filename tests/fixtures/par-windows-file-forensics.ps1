param(
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  [Parameter(Mandatory = $true)][string]$StateDirectory,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$ShutdownPath,
  [Parameter(Mandatory = $true)][int]$ParentLifetimeMilliseconds,
  [Parameter(Mandatory = $true)][string]$StartupNonce
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$project = [System.IO.Path]::GetFullPath($ProjectRoot)
$state = [System.IO.Path]::GetFullPath($StateDirectory)
$ready = [System.IO.Path]::GetFullPath($ReadyPath)
$shutdown = [System.IO.Path]::GetFullPath($ShutdownPath)
$projectPrefix = $project.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $state.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Helper state escaped the owned project." }
if (-not $ready.StartsWith($state + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Readiness path escaped helper state." }
if (-not $shutdown.StartsWith($state + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Shutdown path escaped helper state." }
if ($StartupNonce -notmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw "Startup nonce was invalid." }
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class P12FNativeProbe {
  [StructLayout(LayoutKind.Sequential)]
  private struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmStartSession(out uint handle, uint flags, StringBuilder key);

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmRegisterResources(uint handle, uint fileCount,
    [In, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr, SizeParamIndex = 1)] string[] files,
    uint appCount, IntPtr apps, uint serviceCount, IntPtr services);

  [DllImport("rstrtmgr.dll")]
  private static extern int RmGetList(uint handle, out uint needed, ref uint count, IntPtr processes, out uint reasons);

  [DllImport("rstrtmgr.dll")]
  private static extern int RmEndSession(uint handle);

  public static int ProbeDeleteAccess(string path) {
    using (SafeFileHandle handle = CreateFileW(path, 0x00010000, 0x00000007, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (!handle.IsInvalid) return 0;
      return Marshal.GetLastWin32Error();
    }
  }

  public static object[] ListProcesses(string[] files) {
    uint session = 0;
    StringBuilder key = new StringBuilder(33);
    int rc = RmStartSession(out session, 0, key);
    if (rc != 0) throw new InvalidOperationException("RmStartSession returned " + rc.ToString());
    try {
      rc = RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, IntPtr.Zero);
      if (rc != 0) throw new InvalidOperationException("RmRegisterResources returned " + rc.ToString());
      uint needed;
      uint count = 0;
      uint reasons;
      rc = RmGetList(session, out needed, ref count, IntPtr.Zero, out reasons);
      if (rc != 0 && rc != 234) throw new InvalidOperationException("RmGetList returned " + rc.ToString());
      if (needed == 0) return new object[0];
      if (needed > 128) throw new InvalidOperationException("RmGetList exceeded the 128-process evidence bound.");
      count = needed;
      int size = Marshal.SizeOf(typeof(RM_PROCESS_INFO));
      IntPtr buffer = Marshal.AllocHGlobal(checked((int)count * size));
      try {
        rc = RmGetList(session, out needed, ref count, buffer, out reasons);
        if (rc != 0) throw new InvalidOperationException("RmGetList detail returned " + rc.ToString());
        var result = new List<object>();
        for (int i = 0; i < count; i++) {
          IntPtr item = IntPtr.Add(buffer, checked(i * size));
          RM_PROCESS_INFO info = (RM_PROCESS_INFO)Marshal.PtrToStructure(item, typeof(RM_PROCESS_INFO));
          long start = ((long)info.Process.ProcessStartTime.dwHighDateTime << 32) | (uint)info.Process.ProcessStartTime.dwLowDateTime;
          result.Add(new { pid = info.Process.dwProcessId, applicationName = info.strAppName, processStartFileTime = start.ToString() });
        }
        return result.ToArray();
      } finally { Marshal.FreeHGlobal(buffer); }
    } finally {
      int end = RmEndSession(session);
      if (end != 0) throw new InvalidOperationException("RmEndSession returned " + end.ToString());
    }
  }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp

function Write-AtomicUtf8([string]$Path, [string]$Text) {
  $temporary = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($temporary, $Text, $utf8)
  [System.IO.File]::Move($temporary, $Path)
}

function Get-FileEvidence([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return @{ path = $full; exists = $false } }
  $item = Get-Item -LiteralPath $full -Force
  $stream = [System.IO.File]::Open($full, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
  $owner = $null
  $aclHash = $null
  $aclDiagnostic = $null
  try {
    $acl = Get-Acl -LiteralPath $full
    $owner = $acl.Owner
    $sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
    $aclBytes = [System.Text.Encoding]::UTF8.GetBytes($sddl)
    $aclDigest = [System.Security.Cryptography.SHA256]::Create()
    try { $aclHash = [System.BitConverter]::ToString($aclDigest.ComputeHash($aclBytes)).Replace("-", "").ToLowerInvariant() }
    finally { $aclDigest.Dispose() }
  } catch {
    $aclException = $_.Exception
    $aclExceptionType = if ($aclException) { [string]$aclException.GetType().FullName } else { "unknown" }
    $aclExceptionMessage = if ($aclException) { [string]$aclException.Message } else { "unknown ACL failure" }
    if ($aclExceptionType.Length -gt 160) { $aclExceptionType = $aclExceptionType.Substring(0, 160) }
    if ($aclExceptionMessage.Length -gt 320) { $aclExceptionMessage = $aclExceptionMessage.Substring(0, 320) }
    $aclDiagnostic = "${aclExceptionType}: ${aclExceptionMessage}"
  }
  $evidence = @{
    path = $full
    exists = $true
    type = if ($item.PSIsContainer) { "directory" } else { "file" }
    size = [long]$item.Length
    attributes = [int]$item.Attributes
    owner = $owner
    aclSha256 = $aclHash
    sha256 = $digest
  }
  if ($null -ne $aclDiagnostic) { $evidence.aclDiagnostic = $aclDiagnostic }
  return $evidence
}

function Invoke-ForensicQuery($Request) {
  $runRoot = [System.IO.Path]::GetFullPath((Join-Path $project ".nodulus\runs\$($Request.runId)"))
  $runsRoot = [System.IO.Path]::GetFullPath((Join-Path $project ".nodulus\runs"))
  $runPrefix = $runRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $runRoot.StartsWith($runsRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Run directory escaped owned runs." }
  if ([System.IO.Path]::GetFullPath($Request.runDirectory) -ne $runRoot) { throw "Request run directory did not match its run ID." }
  $target = [System.IO.Path]::GetFullPath($Request.target)
  if ($target -ne [System.IO.Path]::GetFullPath((Join-Path $runRoot "run.json"))) { throw "Request target was not run.json." }
  $temporaryPaths = @()
  foreach ($temporary in $Request.temporaryPaths) {
    $full = [System.IO.Path]::GetFullPath($temporary)
    if (-not $full.StartsWith($runPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Temporary escaped owned run directory." }
    if ([System.IO.Path]::GetDirectoryName($full) -ne $runRoot -or [System.IO.Path]::GetFileName($full) -notmatch '^run\.json\.[0-9a-f-]{36}\.tmp$') { throw "Temporary was not an owned checkpoint sibling." }
    $temporaryPaths += $full
  }
  $targetEvidence = Get-FileEvidence $target
  if (-not $targetEvidence.exists -or $targetEvidence.type -ne "file") { throw "Locked checkpoint was not an existing regular file." }
  $deleteCode = [P12FNativeProbe]::ProbeDeleteAccess($target)
  $existingPaths = @($target)
  $temporaryEvidence = @()
  foreach ($temporary in $temporaryPaths) {
    $evidence = Get-FileEvidence $temporary
    $temporaryEvidence += $evidence
    if ($evidence.exists) { $existingPaths += $temporary }
  }
  $processes = [P12FNativeProbe]::ListProcesses([string[]]$existingPaths)
  return @{
    runId = [string]$Request.runId
    target = $target
    status = "available"
    targetEvidence = $targetEvidence
    deleteAccessProbe = @{ win32ErrorCode = [int]$deleteCode }
    restartManager = @{ processes = @($processes) }
    temporaryEvidence = @($temporaryEvidence)
  }
}

$warmupJsonPath = Join-Path $state "warmup-$StartupNonce.json"
$warmupTemporaryPath = Join-Path $state "warmup-$StartupNonce.tmp.json"
$warmupComplete = $false
try {
  $warmupJson = "{`"protocol`":`"p12f-native-readiness-warmup-v1`",`"nonce`":`"$StartupNonce`"}`n"
  $warmupBytes = $utf8.GetBytes($warmupJson)
  $warmupTemporaryBytes = $utf8.GetBytes("{`"protocol`":`"p12f-native-readiness-temp-v1`",`"nonce`":`"$StartupNonce`"}`n")
  [System.IO.File]::WriteAllBytes($warmupJsonPath, $warmupBytes)
  [System.IO.File]::WriteAllBytes($warmupTemporaryPath, $warmupTemporaryBytes)

  $warmupSha = [System.Security.Cryptography.SHA256]::Create()
  try { $expectedWarmupSha = [System.BitConverter]::ToString($warmupSha.ComputeHash($warmupBytes)).Replace("-", "").ToLowerInvariant() }
  finally { $warmupSha.Dispose() }
  $warmupEvidence = Get-FileEvidence $warmupJsonPath
  if (-not $warmupEvidence.exists) { throw "Readiness warm-up JSON file was not present." }
  if ($warmupEvidence.type -ne "file") { throw "Readiness warm-up JSON path was not a file." }
  if ($warmupEvidence.sha256 -ne $expectedWarmupSha) { throw "Readiness warm-up JSON hash did not match its known bytes." }
  $warmupOwnerInvalid = -not ($warmupEvidence.owner -is [string]) -or [string]::IsNullOrWhiteSpace($warmupEvidence.owner)
  $warmupAclHashInvalid = $warmupEvidence.aclSha256 -notmatch '^[0-9a-f]{64}$'
  if ($warmupOwnerInvalid -or $warmupAclHashInvalid) {
    $ownerType = if ($null -eq $warmupEvidence.owner) { "null" } else { [string]$warmupEvidence.owner.GetType().FullName }
    $aclFailure = if ($null -eq $warmupEvidence.aclDiagnostic) { "none" } else { [string]$warmupEvidence.aclDiagnostic }
    throw "Readiness warm-up JSON owner/ACL evidence failed (ownerType=$ownerType; aclDiagnostic=$aclFailure)."
  }

  $warmupTemporarySha = [System.Security.Cryptography.SHA256]::Create()
  try { $expectedWarmupTemporarySha = [System.BitConverter]::ToString($warmupTemporarySha.ComputeHash($warmupTemporaryBytes)).Replace("-", "").ToLowerInvariant() }
  finally { $warmupTemporarySha.Dispose() }
  $warmupTemporaryEvidence = Get-FileEvidence $warmupTemporaryPath
  if (-not $warmupTemporaryEvidence.exists) { throw "Readiness warm-up temporary file was not present." }
  if ($warmupTemporaryEvidence.type -ne "file") { throw "Readiness warm-up temporary path was not a file." }
  if ($warmupTemporaryEvidence.sha256 -ne $expectedWarmupTemporarySha) { throw "Readiness warm-up temporary hash did not match its known bytes." }
  $warmupTemporaryOwnerInvalid = -not ($warmupTemporaryEvidence.owner -is [string]) -or [string]::IsNullOrWhiteSpace($warmupTemporaryEvidence.owner)
  $warmupTemporaryAclHashInvalid = $warmupTemporaryEvidence.aclSha256 -notmatch '^[0-9a-f]{64}$'
  if ($warmupTemporaryOwnerInvalid -or $warmupTemporaryAclHashInvalid) {
    $ownerType = if ($null -eq $warmupTemporaryEvidence.owner) { "null" } else { [string]$warmupTemporaryEvidence.owner.GetType().FullName }
    $aclFailure = if ($null -eq $warmupTemporaryEvidence.aclDiagnostic) { "none" } else { [string]$warmupTemporaryEvidence.aclDiagnostic }
    throw "Readiness warm-up temporary owner/ACL evidence failed (ownerType=$ownerType; aclDiagnostic=$aclFailure)."
  }

  $warmupDeleteCode = [P12FNativeProbe]::ProbeDeleteAccess($warmupJsonPath)
  if ($warmupDeleteCode -ne 0) { throw "Readiness warm-up delete-access probe returned $warmupDeleteCode." }
  $warmupProcesses = @([P12FNativeProbe]::ListProcesses([string[]]@($warmupJsonPath, $warmupTemporaryPath)))
  if (-not ($warmupProcesses -is [array])) { throw "Readiness warm-up Restart Manager query did not return its process array." }
  $warmupComplete = $true
} finally {
  [System.IO.File]::Delete($warmupJsonPath)
  [System.IO.File]::Delete($warmupTemporaryPath)
  if ((Test-Path -LiteralPath $warmupJsonPath) -or (Test-Path -LiteralPath $warmupTemporaryPath)) {
    throw "Readiness warm-up scratch files could not be removed."
  }
}
if (-not $warmupComplete) { throw "Readiness warm-up did not complete." }
Write-AtomicUtf8 $ready (@{ pid = $PID; ready = $true; startupNonce = $StartupNonce; warmupProtocol = "p12f-native-readiness-warmup-v1"; warmupComplete = $true } | ConvertTo-Json -Compress)
$parentLifetimeDeadline = [DateTime]::UtcNow.AddMilliseconds($ParentLifetimeMilliseconds)
while ($true) {
  if (Test-Path -LiteralPath $shutdown) { exit 0 }
  if ([DateTime]::UtcNow -ge $parentLifetimeDeadline) { exit 73 }
  $requests = @(Get-ChildItem -LiteralPath $state -Filter "request-*.json" -File | Sort-Object Name)
  foreach ($file in $requests) {
    $responsePath = $null
    $id = [System.IO.Path]::GetFileNameWithoutExtension($file.Name).Substring("request-".Length)
    try {
      $request = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $responsePath = [System.IO.Path]::GetFullPath([string]$request.responsePath)
      if (-not $responsePath.StartsWith($state + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Response path escaped helper state." }
      if ([string]$request.id -ne $id) { throw "Request ID did not match its owned filename." }
      $report = Invoke-ForensicQuery $request
    } catch {
      $runId = if ($null -ne $request) { [string]$request.runId } else { "" }
      $target = if ($null -ne $request) { [string]$request.target } else { "" }
      $queryError = $_.Exception.Message.Substring(0, [Math]::Min(1200, $_.Exception.Message.Length))
      $report = @{ runId = $runId; target = $target; status = "unavailable"; reason = "forensic query failed: $queryError"; queryError = $queryError }
    }
    try {
      if ($responsePath) { Write-AtomicUtf8 $responsePath ($report | ConvertTo-Json -Depth 8 -Compress) }
    } catch {
      [Console]::Error.WriteLine("Could not write bounded forensic response: " + $_.Exception.Message)
    }
    try { [System.IO.File]::Delete($file.FullName) } catch { }
  }
  Start-Sleep -Milliseconds 10
}

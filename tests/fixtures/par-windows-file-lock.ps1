param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$Entry,
  [Parameter(Mandatory = $true)][string]$Started,
  [Parameter(Mandatory = $true)][string]$Release,
  [Parameter(Mandatory = $true)][int]$WatchdogMilliseconds
)

$ErrorActionPreference = "Stop"
$entryTemporary = "$Entry.$PID.tmp"
[System.IO.File]::WriteAllText($entryTemporary, (@{ pid = $PID; target = $Target } | ConvertTo-Json -Compress))
[System.IO.File]::Move($entryTemporary, $Entry)
$stream = [System.IO.File]::Open(
  $Target,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::ReadWrite
)
try {
  $startedTemporary = "$Started.$PID.tmp"
  [System.IO.File]::WriteAllText($startedTemporary, (@{ pid = $PID; target = $Target } | ConvertTo-Json -Compress))
  [System.IO.File]::Move($startedTemporary, $Started)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($WatchdogMilliseconds)
  while (-not (Test-Path -LiteralPath $Release)) {
    if ([DateTime]::UtcNow -ge $deadline) {
      [Console]::Error.WriteLine("P12W lock watchdog expired.")
      exit 72
    }
    Start-Sleep -Milliseconds 20
  }
}
finally {
  $stream.Dispose()
}

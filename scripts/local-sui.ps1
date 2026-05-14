$ErrorActionPreference = 'Stop'

function Wait-RpcReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RpcUrl,
    [int]$TimeoutMs = 30000,
    [int]$PollIntervalMs = 1000
  )

  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  $payload = '{"jsonrpc":"2.0","id":1,"method":"sui_getLatestCheckpointSequenceNumber","params":[]}'

  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod -Uri $RpcUrl -Method Post -ContentType 'application/json' -Body $payload | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds $PollIntervalMs
    }
  }

  throw "Timed out waiting for Sui RPC at $RpcUrl"
}

function Get-PublishIdentifiers {
  param(
    [Parameter(Mandatory = $true)]
    [pscustomobject]$PublishResult
  )

  $packageId = $null
  $registryId = $null

  foreach ($change in @($PublishResult.objectChanges)) {
    if (-not $packageId -and $change.type -eq 'published' -and $change.packageId) {
      $packageId = $change.packageId
    }

    if (-not $registryId -and $change.objectType -match '::registry::Registry$' -and $change.objectId) {
      $registryId = $change.objectId
    }
  }

  if (-not $packageId -or -not $registryId) {
    throw 'Unable to extract packageId and registryId from publish output.'
  }

  return [pscustomobject]@{
    packageId = $packageId
    registryId = $registryId
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$contractsPath = Join-Path $repoRoot 'contracts\agentic_mesh'
$tmpDir = Join-Path $repoRoot 'sui_tmp\localnet'
$stdoutLog = Join-Path $tmpDir 'sui.stdout.log'
$stderrLog = Join-Path $tmpDir 'sui.stderr.log'
$rpcUrl = 'http://127.0.0.1:9000'
$localBin = Join-Path $env:LOCALAPPDATA 'bin'

if (Test-Path $localBin -and $env:PATH -notlike "*$localBin*") {
  $env:PATH = "$localBin;$env:PATH"
}

if (-not (Test-Path (Join-Path $contractsPath 'Move.toml'))) {
  throw "Expected Move package at $contractsPath. Create contracts\agentic_mesh before running local Sui bootstrap."
}

New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$env:TMPDIR = $tmpDir
$env:TMP = $tmpDir
$env:TEMP = $tmpDir

$suiProcess = $null

try {
  $suiProcess = Start-Process -FilePath 'sui' -ArgumentList @('start', '--with-faucet', '--force-regenesis') -WorkingDirectory $repoRoot -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

  Write-Host "Started local Sui network (PID $($suiProcess.Id)). Waiting for RPC readiness..."
  Wait-RpcReady -RpcUrl $rpcUrl

  $publishRaw = & sui client publish $contractsPath --gas-budget 100000000 --json
  $publishText = $publishRaw | Out-String
  $publish = $publishText | ConvertFrom-Json
  $identifiers = Get-PublishIdentifiers -PublishResult $publish

  Write-Host "Local Sui network ready."
  Write-Host "Package ID: $($identifiers.packageId)"
  Write-Host "Registry ID: $($identifiers.registryId)"
  Write-Host 'Press Ctrl+C to stop the local network.'

  Wait-Process -Id $suiProcess.Id
} finally {
  if ($suiProcess -and -not $suiProcess.HasExited) {
    Stop-Process -Id $suiProcess.Id -Force
  }
}

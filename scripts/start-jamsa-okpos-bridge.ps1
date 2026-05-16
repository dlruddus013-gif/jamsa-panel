$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$node = "node"
$script = Join-Path $PSScriptRoot "jamsa-okpos-bridge.cjs"

if (-not (Test-Path -LiteralPath $script)) {
  throw "Bridge script not found: $script"
}

Write-Host "Starting Jamsa OKPOS bridge on http://127.0.0.1:5566"
Write-Host "Repo: $repo"
Write-Host "Script: $script"

Set-Location -LiteralPath $repo
& $node $script

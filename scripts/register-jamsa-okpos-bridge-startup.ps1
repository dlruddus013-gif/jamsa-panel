$ErrorActionPreference = "Stop"

$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "Jamsa OKPOS Bridge.lnk"
$target = Join-Path $PSScriptRoot "start-jamsa-okpos-bridge.ps1"

if (-not (Test-Path -LiteralPath $target)) {
  throw "Startup target not found: $target"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$target`""
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.IconLocation = "C:\_OKPOS\BIN\OKPos.ico,0"
$shortcut.Save()

Write-Host "Registered startup shortcut:"
Write-Host $shortcutPath

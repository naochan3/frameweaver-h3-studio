[CmdletBinding()]
param(
    [string]$Profile,
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config\comfy-profiles.json'),
    [string]$CustomNodesPath = 'C:\Users\ogosh\work\ComfyUI\custom_nodes',
    [string]$ComfyLogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$argsScript = Join-Path $PSScriptRoot 'Get-ComfyProfileArgs.ps1'
$cliArgs = @(& $argsScript -Profile $Profile -ConfigPath $ConfigPath)
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$selectedProfile = if ([string]::IsNullOrWhiteSpace($Profile)) { [string]$config.defaultProfile } else { $Profile }
$definition = $config.profiles.PSObject.Properties[$selectedProfile].Value
$expected = @($definition.customNodes | ForEach-Object { [string]$_ })

$installed = @()
if (Test-Path -LiteralPath $CustomNodesPath -PathType Container) {
    $installed = @(Get-ChildItem -LiteralPath $CustomNodesPath -Directory | ForEach-Object { $_.Name })
}
$installedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($node in $installed) { [void]$installedSet.Add($node) }
$missing = @($expected | Where-Object { -not $installedSet.Contains($_) })
$present = @($expected | Where-Object { $installedSet.Contains($_) })

# Importing a custom node may execute arbitrary package initialization.  This diagnostic
# remains read-only and reports only failures already recorded in an optional ComfyUI log.
$importFailures = @()
if ($ComfyLogPath) {
    if (-not (Test-Path -LiteralPath $ComfyLogPath -PathType Leaf)) {
        throw "ComfyUI log not found: $ComfyLogPath"
    }
    $logLines = Get-Content -LiteralPath $ComfyLogPath
    foreach ($node in $expected) {
        if ($logLines | Where-Object { $_ -match '(?i)(import failed|failed to import)' -and $_ -match [regex]::Escape($node) }) {
            $importFailures += $node
        }
    }
}

[pscustomobject]@{
    Profile = $selectedProfile
    Mode = [string]$definition.mode
    CustomNodesPath = $CustomNodesPath
    CommandArgs = $cliArgs
    Expected = $expected
    Present = $present
    Missing = $missing
    ImportFailures = $importFailures
    OpenFolderEndpointAllowed = ($selectedProfile -eq 'full' -and $expected -contains 'frameweaver_openfolder')
}

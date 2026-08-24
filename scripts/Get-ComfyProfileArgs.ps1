[CmdletBinding()]
param(
    [string]$Profile,
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config\comfy-profiles.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Comfy profile configuration not found: $ConfigPath"
}

try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
} catch {
    throw "Comfy profile configuration is invalid JSON: $ConfigPath"
}

if (-not $config.defaultProfile -or -not $config.profiles) {
    throw 'Comfy profile configuration requires defaultProfile and profiles.'
}

$selectedProfile = if ([string]::IsNullOrWhiteSpace($Profile)) { [string]$config.defaultProfile } else { $Profile }
$profileProperty = $config.profiles.PSObject.Properties[$selectedProfile]
if (-not $profileProperty) {
    throw "Unknown Comfy profile: $selectedProfile"
}

$definition = $profileProperty.Value
$mode = [string]$definition.mode
if ($mode -notin @('minimal', 'allowlist', 'all')) {
    throw "Comfy profile '$selectedProfile' has an invalid mode: $mode"
}

$nodes = @($definition.customNodes | ForEach-Object { [string]$_ })
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($node in $nodes) {
    if ([string]::IsNullOrWhiteSpace($node)) {
        throw "Comfy profile '$selectedProfile' has an empty custom node."
    }
    if (-not $seen.Add($node)) {
        throw "Comfy profile '$selectedProfile' has duplicate custom node '$node'."
    }
}

switch ($mode) {
    'minimal' {
        if ($nodes.Count -ne 0) { throw "Comfy profile '$selectedProfile' minimal mode cannot whitelist custom nodes." }
        $cliArgs = @('--disable-all-custom-nodes')
    }
    'allowlist' {
        if ($nodes.Count -eq 0) { throw "Comfy profile '$selectedProfile' allowlist mode requires at least one custom node." }
        $cliArgs = @('--disable-all-custom-nodes', '--whitelist-custom-nodes') + $nodes
    }
    'all' {
        # Full is intentionally argument-free so the current ComfyUI startup remains compatible.
        $cliArgs = @()
    }
}

Write-Output $cliArgs

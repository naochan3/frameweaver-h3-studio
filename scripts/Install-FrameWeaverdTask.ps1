[CmdletBinding()]
param(
    [string]$TaskName = 'FrameWeaverd',
    [string]$ProjectRoot,
    [string]$RollbackPath,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if ($TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$') { throw 'TaskName must contain only letters, numbers, spaces, dot, underscore, or dash.' }
$ProjectRoot = if ($ProjectRoot) { $ProjectRoot } else { Split-Path -Parent $PSScriptRoot }
$project = (Resolve-Path -LiteralPath $ProjectRoot).Path
$starter = Join-Path $project 'scripts\Start-FrameWeaver.ps1'
if (-not (Test-Path -LiteralPath $starter)) { throw "Missing launcher: $starter" }

$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$starter`" -ProjectRoot `"$project`""
$rollback = "Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
$plan = [pscustomobject]@{
    Apply = [bool]$Apply
    TaskName = $TaskName
    Action = [pscustomobject]@{
        Execute = (Get-Command powershell.exe -ErrorAction Stop).Source
        Arguments = $arguments
        WorkingDirectory = $project
    }
    Restart = [pscustomobject]@{ Count = 3; Interval = 'PT1M' }
    Trigger = 'AtLogOn'
    Rollback = [pscustomobject]@{ Command = $rollback; ExportPath = $RollbackPath }
}

function Export-Rollback([string]$Path, [string]$ExistingXml) {
    if (-not $Path) { return }
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    if ($ExistingXml) {
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ExistingXml))
        $content = "`$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encoded'))`r`nRegister-ScheduledTask -TaskName '$TaskName' -Xml `$xml -Force | Out-Null"
    } else { $content = $rollback }
    Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

if (-not $Apply) {
    Export-Rollback $RollbackPath $null
    return $plan
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$existingXml = if ($existing) { Export-ScheduledTask -TaskName $TaskName } else { $null }
Export-Rollback $RollbackPath $existingXml

$action = New-ScheduledTaskAction -Execute $plan.Action.Execute -Argument $plan.Action.Arguments -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
if ($existing -and -not $RollbackPath) { throw 'Replacing an existing task requires -RollbackPath.' }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'FrameWeaver local control plane' -Force | Out-Null
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw 'Scheduled Task registration could not be read back.' }

return $plan

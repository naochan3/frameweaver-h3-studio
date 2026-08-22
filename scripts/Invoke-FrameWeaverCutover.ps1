[CmdletBinding()]
param(
    [string]$TaskName = 'FrameWeaver-H3-Studio',
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$BackupDirectory,
    [int]$Port = 5180,
    [int]$RetryTimeoutSeconds = 30,
    [int]$RetryIntervalMilliseconds = 200,
    [switch]$Apply,
    [switch]$Rollback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ListeningProcess {
    param([int]$LocalPort)
    $listeners = @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Where-Object { $null -ne $_ })
    if ($listeners.Count -ne 1) { return $null }
    $processId = [int]$listeners[0].OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    [pscustomobject]@{ Pid = $processId; Name = [string]$process.Name; ExecutablePath = [string]$process.ExecutablePath; CommandLine = [string]$process.CommandLine }
}

function Test-OldViteLauncher {
    param([pscustomobject]$Process, [string]$Root)
    if (-not $Process) { return $false }
    $text = "$($Process.Name) $($Process.ExecutablePath) $($Process.CommandLine)"
    return $text -match '(?i)(^|\s|\\)(node(?:\.exe)?|vite)(\s|$|\.)' -and $text.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-NewDaemon {
    param([pscustomobject]$Process, [string]$Root)
    if (-not $Process) { return $false }
    $text = "$($Process.Name) $($Process.ExecutablePath) $($Process.CommandLine)"
    return $text -match '(?i)frameweaverd(?:\.exe)?' -and $text.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Wait-PortFree {
    param([int]$LocalPort, [int]$TimeoutSeconds = 10)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (-not (Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Get-ReadyHealth {
    param([int]$LocalPort, [int]$TimeoutSeconds, [int]$IntervalMilliseconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastFailure = 'health/build readback did not identify a ready FrameWeaver service'
    do {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/api/health" -TimeoutSec 3
            if ($health.service -eq 'ready' -and $health.database -eq 'ready' -and $health.build -and $health.build.sha) { return $health }
            $lastFailure = 'health/build readback did not identify a ready FrameWeaver service'
        } catch { $lastFailure = $_.Exception.Message }
        if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $IntervalMilliseconds }
    } while ((Get-Date) -lt $deadline)
    throw "FrameWeaver health did not become ready within $TimeoutSeconds seconds: $lastFailure"
}

function Get-OldServiceProbe {
    param([int]$LocalPort, [int]$TimeoutSeconds, [int]$IntervalMilliseconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastFailure = 'old service probe did not complete'
    do {
        try {
            $root = Invoke-WebRequest -Uri "http://127.0.0.1:$LocalPort/" -UseBasicParsing -TimeoutSec 3
            if ($root.StatusCode -ne 200) { throw 'old service root probe did not return HTTP 200' }
            $fleet = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/api/fleet" -TimeoutSec 3
            if ($null -eq $fleet -or $null -eq $fleet.samples) { throw 'old service fleet probe did not return JSON samples' }
            return [pscustomobject]@{ RootStatus = [int]$root.StatusCode; FleetJson = $true }
        } catch { $lastFailure = $_.Exception.Message }
        if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $IntervalMilliseconds }
    } while ((Get-Date) -lt $deadline)
    throw "legacy service did not satisfy its captured probe within $TimeoutSeconds seconds: $lastFailure"
}

function Get-CutoverPlan {
    param([string]$Root, [int]$LocalPort, [string]$Name)
    $old = Get-ListeningProcess -LocalPort $LocalPort
    [pscustomobject]@{
        Apply = $false
        TaskName = $Name
        Port = $LocalPort
        ExistingPid = if ($old) { $old.Pid } else { $null }
        ExistingCommandLine = if ($old) { $old.CommandLine } else { $null }
        OldViteLauncher = (Test-OldViteLauncher -Process $old -Root $Root)
        RequiresXmlBackup = $true
        Rollback = 'stop verified frameweaverd, free port, restore saved XML, start and read back health'
    }
}

function Save-TaskBackup {
    param([string]$Name, [string]$Directory)
    if (-not $Directory) { throw 'Apply requires -BackupDirectory for the same-name task XML backup.' }
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    if (-not $task) { throw 'same-name scheduled task was not found' }
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $path = Join-Path $Directory "$Name.xml"
    Export-ScheduledTask -TaskName $Name | Set-Content -LiteralPath $path -Encoding UTF8
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'task XML backup was not written' }
    return $path
}

function Save-CutoverManifest {
    param([string]$Directory, [string]$Name, [int]$LocalPort, [string]$TaskBackup, [pscustomobject]$OldProcess, [pscustomobject]$OldProbe)
    $path = Join-Path $Directory "$Name-manifest.json"
    [ordered]@{
        task_name = $Name
        port = $LocalPort
        task_backup = $TaskBackup
        old_listener_observed = [bool]$OldProcess
        old_probe = $OldProbe
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'cutover manifest was not written' }
    return $path
}

function Stop-VerifiedDaemonOrFailClosed {
    param([string]$Root, [int]$LocalPort)
    $new = Get-ListeningProcess -LocalPort $LocalPort
    if ($new) {
        if (-not (Test-NewDaemon -Process $new -Root $Root)) {
            throw "manual recovery required: port $LocalPort is owned by an unverified process; the XML backup was retained and no process was stopped."
        }
        Stop-Process -Id $new.Pid -Force -ErrorAction Stop
    }
    if (-not (Wait-PortFree -LocalPort $LocalPort)) { throw 'port did not become free before restoring the saved task XML' }
    return $new
}

function Restore-OldTask {
    param([string]$Name, [string]$Backup, [pscustomobject]$Manifest, [int]$LocalPort, [int]$TimeoutSeconds, [int]$IntervalMilliseconds)
    Register-ScheduledTask -TaskName $Name -Xml (Get-Content -Raw -LiteralPath $Backup) -Force | Out-Null
    Start-ScheduledTask -TaskName $Name
    $oldProbe = Get-OldServiceProbe -LocalPort $LocalPort -TimeoutSeconds $TimeoutSeconds -IntervalMilliseconds $IntervalMilliseconds
    if ($Manifest.old_probe -and ([int]$Manifest.old_probe.RootStatus -ne $oldProbe.RootStatus -or -not [bool]$Manifest.old_probe.FleetJson)) {
        throw 'restored old service does not satisfy the captured Vite probe contract'
    }
    return $oldProbe
}

function Invoke-ApplyCutover {
    param([string]$Root, [int]$LocalPort, [string]$Name, [string]$Directory, [int]$TimeoutSeconds, [int]$IntervalMilliseconds)
    $old = Get-ListeningProcess -LocalPort $LocalPort
    if ($old -and -not (Test-OldViteLauncher -Process $old -Root $Root)) { throw 'port owner is not the expected repo-local Vite launcher; refusing to stop it.' }
    $oldProbe = if ($old) { Get-OldServiceProbe -LocalPort $LocalPort -TimeoutSeconds $TimeoutSeconds -IntervalMilliseconds $IntervalMilliseconds } else { $null }
    $backup = Save-TaskBackup -Name $Name -Directory $Directory
    $manifest = Save-CutoverManifest -Directory $Directory -Name $Name -LocalPort $LocalPort -TaskBackup $backup -OldProcess $old -OldProbe $oldProbe
    if ($old) { Stop-Process -Id $old.Pid -Force -ErrorAction Stop }
    if (-not (Wait-PortFree -LocalPort $LocalPort)) { throw 'port did not become free after stopping the verified Vite launcher' }
    $installer = Join-Path $Root 'scripts\Install-FrameWeaverdTask.ps1'
    & $installer -TaskName $Name -ProjectRoot $Root -RollbackPath (Join-Path $Directory "$Name-rollback.ps1") -Apply | Out-Null
    Start-ScheduledTask -TaskName $Name
    try { $health = Get-ReadyHealth -LocalPort $LocalPort -TimeoutSeconds $TimeoutSeconds -IntervalMilliseconds $IntervalMilliseconds } catch {
        $healthFailure = $_.Exception.Message
        try {
            $stopped = Stop-VerifiedDaemonOrFailClosed -Root $Root -LocalPort $LocalPort
            $restored = Restore-OldTask -Name $Name -Backup $backup -Manifest (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json) -LocalPort $LocalPort -TimeoutSeconds $TimeoutSeconds -IntervalMilliseconds $IntervalMilliseconds
        } catch { throw "new daemon health failed: $healthFailure; automatic rollback did not complete: $($_.Exception.Message)" }
        throw "new daemon health failed: $healthFailure; automatic rollback restored the saved task XML and legacy probe contract."
    }
    [pscustomobject]@{ Applied = $true; TaskName = $Name; BackupPath = $backup; ManifestPath = $manifest; Health = $health; OldPid = if ($old) { $old.Pid } else { $null } }
}

function Invoke-RollbackCutover {
    param([string]$Root, [int]$LocalPort, [string]$Name, [string]$Directory, [int]$TimeoutSeconds, [int]$IntervalMilliseconds)
    if (-not $Directory) { throw 'Rollback requires -BackupDirectory containing the saved task XML.' }
    $backup = Join-Path $Directory "$Name.xml"
    if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw 'saved task XML is missing' }
    $manifestPath = Join-Path $Directory "$Name-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'cutover manifest is missing' }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.task_name -ne $Name -or [int]$manifest.port -ne $LocalPort) { throw 'cutover manifest does not match task or port' }
    $new = Stop-VerifiedDaemonOrFailClosed -Root $Root -LocalPort $LocalPort
    $oldProbe = Restore-OldTask -Name $Name -Backup $backup -Manifest $manifest -LocalPort $LocalPort -TimeoutSeconds $TimeoutSeconds -IntervalMilliseconds $IntervalMilliseconds
    [pscustomobject]@{ RolledBack = $true; TaskName = $Name; BackupPath = $backup; ManifestPath = $manifestPath; OldProbe = $oldProbe; NewPid = if ($new) { $new.Pid } else { $null } }
}

$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not $Apply) { return (Get-CutoverPlan -Root $root -LocalPort $Port -Name $TaskName) }
if ($Rollback) { return (Invoke-RollbackCutover -Root $root -LocalPort $Port -Name $TaskName -Directory $BackupDirectory -TimeoutSeconds $RetryTimeoutSeconds -IntervalMilliseconds $RetryIntervalMilliseconds) }
return (Invoke-ApplyCutover -Root $root -LocalPort $Port -Name $TaskName -Directory $BackupDirectory -TimeoutSeconds $RetryTimeoutSeconds -IntervalMilliseconds $RetryIntervalMilliseconds)

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cutover = Join-Path $repoRoot 'scripts\Invoke-FrameWeaverCutover.ps1'

Describe 'FrameWeaver gated cutover' {
    BeforeEach {
        $global:cutoverNetCalls = 0
        $global:cutoverStopCalls = 0
        $global:cutoverRegisterCalls = 0
        $global:cutoverStartCalls = 0
    }

    AfterEach {
        'Get-NetTCPConnection','Get-CimInstance','Get-ScheduledTask','Export-ScheduledTask','Stop-Process','Register-ScheduledTask','Start-ScheduledTask','Invoke-RestMethod','Invoke-WebRequest' |
            ForEach-Object { Remove-Item "Function:global:$_" -ErrorAction SilentlyContinue }
        Remove-Variable cutoverNetCalls,cutoverStopCalls,cutoverRegisterCalls,cutoverStartCalls -Scope Global -ErrorAction SilentlyContinue
    }

    It 'is dry-run by default and identifies only a repo-local Vite port owner' {
        function global:Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 4242 } }
        function global:Get-CimInstance { [pscustomobject]@{ Name = 'node.exe'; ExecutablePath = 'C:\Program Files\nodejs\node.exe'; CommandLine = "node $repoRoot\node_modules\vite\bin\vite.js" } }

        $plan = & $cutover -ProjectRoot $repoRoot

        $plan.Apply | Should Be $false
        $plan.ExistingPid | Should Be 4242
        $plan.OldViteLauncher | Should Be $true
        $plan.RequiresXmlBackup | Should Be $true
        $global:cutoverStopCalls | Should Be 0
    }

    It 'fails closed on a port-owner command mismatch before any stop or task change' {
        function global:Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 5252 } }
        function global:Get-CimInstance { [pscustomobject]@{ Name = 'node.exe'; ExecutablePath = 'C:\Program Files\nodejs\node.exe'; CommandLine = 'node C:\other\server.js' } }
        function global:Stop-Process { $global:cutoverStopCalls++ }
        function global:Register-ScheduledTask { $global:cutoverRegisterCalls++ }

        $failure = $null
        try { & $cutover -ProjectRoot $repoRoot -Apply -BackupDirectory $TestDrive | Out-Null } catch { $failure = $_.Exception.Message }

        $failure | Should Match 'refusing to stop'
        $global:cutoverStopCalls | Should Be 0
        $global:cutoverRegisterCalls | Should Be 0
    }

    It 'retries delayed new health after task start' {
        $root = Join-Path $TestDrive 'repo'
        $scripts = Join-Path $root 'scripts'
        New-Item -ItemType Directory -Force -Path $scripts | Out-Null
        Set-Content -LiteralPath (Join-Path $scripts 'Install-FrameWeaverdTask.ps1') -Value 'param($TaskName,$ProjectRoot,$RollbackPath,[switch]$Apply)'
        function global:Get-NetTCPConnection { $null }
        function global:Get-ScheduledTask { [pscustomobject]@{ TaskName = 'FrameWeaver-H3-Studio' } }
        function global:Export-ScheduledTask { '<Task version="1.4" />' }
        function global:Start-ScheduledTask { $global:cutoverStartCalls++ }
        $global:cutoverHealthCalls = 0
        function global:Invoke-RestMethod {
            param($Uri)
            if ($Uri -match '/api/fleet') { return [pscustomobject]@{ samples = @() } }
            $global:cutoverHealthCalls++
            if ($global:cutoverHealthCalls -eq 1) { return [pscustomobject]@{ service = 'starting'; database = 'starting'; build = $null } }
            [pscustomobject]@{ service = 'ready'; database = 'ready'; build = [pscustomobject]@{ sha = 'test' } }
        }

        $result = & $cutover -ProjectRoot $root -Apply -BackupDirectory $TestDrive -RetryTimeoutSeconds 1 -RetryIntervalMilliseconds 1

        $result.Applied | Should Be $true
        $result.OldPid | Should Be $null
        (Test-Path -LiteralPath (Join-Path $TestDrive 'FrameWeaver-H3-Studio.xml')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $TestDrive 'FrameWeaver-H3-Studio-manifest.json')) | Should Be $true
        $global:cutoverStopCalls | Should Be 0
        $global:cutoverStartCalls | Should Be 1
        $global:cutoverHealthCalls | Should Be 2
    }

    It 'automatically restores the XML backup when the new task never becomes healthy and no listener remains' {
        $root = Join-Path $TestDrive 'repo'
        $scripts = Join-Path $root 'scripts'
        New-Item -ItemType Directory -Force -Path $scripts | Out-Null
        Set-Content -LiteralPath (Join-Path $scripts 'Install-FrameWeaverdTask.ps1') -Value 'param($TaskName,$ProjectRoot,$RollbackPath,[switch]$Apply)'
        function global:Get-NetTCPConnection { $null }
        function global:Get-ScheduledTask { [pscustomobject]@{ TaskName = 'FrameWeaver-H3-Studio' } }
        function global:Export-ScheduledTask { '<Task version="1.4" />' }
        function global:Start-ScheduledTask { $global:cutoverStartCalls++ }
        function global:Register-ScheduledTask { $global:cutoverRegisterCalls++; [pscustomobject]@{} }
        function global:Invoke-RestMethod { param($Uri); if ($Uri -match '/api/fleet') { return [pscustomobject]@{ samples = @() } }; throw 'daemon unavailable' }
        function global:Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }

        $failure = $null
        try { & $cutover -ProjectRoot $root -Apply -BackupDirectory $TestDrive -RetryTimeoutSeconds 1 -RetryIntervalMilliseconds 1 | Out-Null } catch { $failure = $_.Exception.Message }

        $failure | Should Match 'automatic rollback restored'
        (Test-Path -LiteralPath (Join-Path $TestDrive 'FrameWeaver-H3-Studio.xml')) | Should Be $true
        $global:cutoverStopCalls | Should Be 0
        $global:cutoverRegisterCalls | Should Be 1
        $global:cutoverStartCalls | Should Be 2
    }

    It 'rolls back only a verified ready daemon after restoring the mandatory XML backup' {
        $backup = Join-Path $TestDrive 'FrameWeaver-H3-Studio.xml'
        Set-Content -LiteralPath $backup -Value '<Task version="1.4" />'
        @{ task_name = 'FrameWeaver-H3-Studio'; port = 5180; task_backup = $backup; old_listener_observed = $true; old_probe = @{ RootStatus = 200; FleetJson = $true } } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $TestDrive 'FrameWeaver-H3-Studio-manifest.json')
        function global:Get-NetTCPConnection {
            $global:cutoverNetCalls++
            if ($global:cutoverNetCalls -eq 1) { return [pscustomobject]@{ OwningProcess = 6262 } }
            return $null
        }
        function global:Get-CimInstance { [pscustomobject]@{ Name = 'frameweaverd.exe'; ExecutablePath = "$repoRoot\frameweaverd\target\release\frameweaverd.exe"; CommandLine = "$repoRoot\frameweaverd\target\release\frameweaverd.exe" } }
        function global:Invoke-RestMethod { param($Uri); if ($Uri -match '/api/fleet') { return [pscustomobject]@{ samples = @() } }; [pscustomobject]@{ service = 'ready'; database = 'ready'; build = [pscustomobject]@{ sha = 'test' } } }
        function global:Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }
        function global:Stop-Process { $global:cutoverStopCalls++ }
        function global:Register-ScheduledTask { $global:cutoverRegisterCalls++; [pscustomobject]@{} }
        function global:Start-ScheduledTask { $global:cutoverStartCalls++ }

        $result = & $cutover -ProjectRoot $repoRoot -Apply -Rollback -BackupDirectory $TestDrive -RetryTimeoutSeconds 1 -RetryIntervalMilliseconds 1

        $result.RolledBack | Should Be $true
        $global:cutoverStopCalls | Should Be 1
        $global:cutoverRegisterCalls | Should Be 1
        $global:cutoverStartCalls | Should Be 1
    }

    It 'manually restores the old XML when no listener remains and retries its delayed legacy probe' {
        $backup = Join-Path $TestDrive 'FrameWeaver-H3-Studio.xml'
        Set-Content -LiteralPath $backup -Value '<Task version="1.4" />'
        @{ task_name = 'FrameWeaver-H3-Studio'; port = 5180; task_backup = $backup; old_listener_observed = $true; old_probe = @{ RootStatus = 200; FleetJson = $true } } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $TestDrive 'FrameWeaver-H3-Studio-manifest.json')
        $global:cutoverWebCalls = 0
        function global:Get-NetTCPConnection { $null }
        function global:Invoke-WebRequest {
            $global:cutoverWebCalls++
            if ($global:cutoverWebCalls -eq 1) { throw 'legacy still starting' }
            [pscustomobject]@{ StatusCode = 200 }
        }
        function global:Invoke-RestMethod { param($Uri); if ($Uri -match '/api/fleet') { return [pscustomobject]@{ samples = @() } }; throw 'health should not be needed with no listener' }
        function global:Register-ScheduledTask { $global:cutoverRegisterCalls++; [pscustomobject]@{} }
        function global:Start-ScheduledTask { $global:cutoverStartCalls++ }

        $result = & $cutover -ProjectRoot $repoRoot -Apply -Rollback -BackupDirectory $TestDrive -RetryTimeoutSeconds 1 -RetryIntervalMilliseconds 1

        $result.RolledBack | Should Be $true
        $result.NewPid | Should Be $null
        $global:cutoverStopCalls | Should Be 0
        $global:cutoverRegisterCalls | Should Be 1
        $global:cutoverStartCalls | Should Be 1
        $global:cutoverWebCalls | Should Be 2
    }
}

$scriptPath = Join-Path $PSScriptRoot '..\Measure-ComfyIdleResources.ps1'

Describe 'Measure-ComfyIdleResources' {
    BeforeEach {
        Mock nvidia-smi.exe {
            $global:LASTEXITCODE = 0
            '0, Test GPU, 1024, 8192, 0, 12.5, 40, P8'
        }
        Mock Get-CimInstance {
            param($ClassName, $Filter)
            if ($ClassName -eq 'Win32_OperatingSystem') {
                return [pscustomobject]@{ TotalVisibleMemorySize = 16MB; FreePhysicalMemory = 8MB }
            }
            return @()
        }
        Mock Get-Process { @() }
        Mock Start-Sleep {}
    }

    It 'emits a bounded schema without command lines, prompts, or environment values' {
        $result = (& $scriptPath -State stopped -DurationSeconds 1 -IntervalSeconds 1) | ConvertFrom-Json
        $result.schema | Should Be 'frameweaver.comfy_idle.v1'
        $result.state | Should Be 'stopped'
        $result.count | Should Be 1
        $result.vram_used_mib.median | Should Be 1024
        $result.private_bytes.max | Should Be 0
        (($result | ConvertTo-Json -Depth 8) -match 'CommandLine|prompt|environment') | Should Be $false
    }

    It 'declares bounded duration and interval validation' {
        $command = Get-Command -Name $scriptPath
        $duration = $command.Parameters.DurationSeconds.Attributes | Where-Object { $_ -is [Management.Automation.ValidateRangeAttribute] }
        $interval = $command.Parameters.IntervalSeconds.Attributes | Where-Object { $_ -is [Management.Automation.ValidateRangeAttribute] }
        $duration.MinRange | Should Be 1
        $duration.MaxRange | Should Be 3600
        $interval.MinRange | Should Be 1
        $interval.MaxRange | Should Be 60
    }
}

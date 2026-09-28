[CmdletBinding()]
param(
    [ValidateSet('stopped', 'idle_started', 'post_generation_idle')]
    [string]$State = 'idle_started',
    [ValidateRange(1, 3600)]
    [int]$DurationSeconds = 60,
    [ValidateRange(1, 60)]
    [int]$IntervalSeconds = 1
)

$ErrorActionPreference = 'Stop'
$sampleCount = [Math]::Max(1, [Math]::Floor($DurationSeconds / $IntervalSeconds))
$samples = [Collections.Generic.List[object]]::new()

for ($sampleIndex = 0; $sampleIndex -lt $sampleCount; $sampleIndex++) {
    $gpuRows = @(& nvidia-smi.exe --query-gpu=index,name,memory.used,memory.total,utilization.gpu,power.draw,temperature.gpu,pstate --format=csv,noheader,nounits 2>$null)
    $gpuExit = $LASTEXITCODE
    if ($gpuExit -ne 0 -or $gpuRows.Count -eq 0) { throw 'nvidia-smi failed' }
    $gpu = @($gpuRows[0] -split ',' | ForEach-Object { $_.Trim() })
    $osInfo = Get-CimInstance -ClassName Win32_OperatingSystem
    $comfyProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='python.exe' OR Name='python3.exe' OR Name='pythonw.exe'" |
        Where-Object { $_.CommandLine -match '(?i)(ComfyUI|main\.py.*--port\s+818)' } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        Where-Object { $_ })
    $largest = $comfyProcesses | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 1
    $samples.Add([pscustomobject]@{
        timestamp = (Get-Date).ToUniversalTime().ToString('o')
        host = $env:COMPUTERNAME
        state = $State
        comfy_pid = if ($largest) { [int]$largest.Id } else { $null }
        private_bytes = if ($largest) { [int64]$largest.PrivateMemorySize64 } else { 0 }
        working_set = if ($largest) { [int64]$largest.WorkingSet64 } else { 0 }
        system_ram_used = ([int64]$osInfo.TotalVisibleMemorySize - [int64]$osInfo.FreePhysicalMemory) * 1024
        vram_used = [double]$gpu[2]
        vram_total = [double]$gpu[3]
        gpu_util = [double]$gpu[4]
        power_draw = [double]$gpu[5]
        temperature = [double]$gpu[6]
        pstate = $gpu[7]
    })
    if ($sampleIndex + 1 -lt $sampleCount) { Start-Sleep -Seconds $IntervalSeconds }
}

function Get-Summary([object[]]$Values) {
    $sorted = @($Values | Sort-Object)
    [pscustomobject]@{
        median = $sorted[[Math]::Floor(($sorted.Count - 1) * 0.50)]
        p95 = $sorted[[Math]::Floor(($sorted.Count - 1) * 0.95)]
        max = $sorted[-1]
    }
}

[pscustomobject]@{
    schema = 'frameweaver.comfy_idle.v1'
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    host = $env:COMPUTERNAME
    state = $State
    count = $samples.Count
    comfy_pids = @($samples.comfy_pid | Where-Object { $_ } | Sort-Object -Unique)
    private_bytes = Get-Summary @($samples.private_bytes)
    working_set = Get-Summary @($samples.working_set)
    system_ram_used = Get-Summary @($samples.system_ram_used)
    vram_used_mib = Get-Summary @($samples.vram_used)
    gpu_util_pct = Get-Summary @($samples.gpu_util)
    power_w = Get-Summary @($samples.power_draw)
    temperature_c = Get-Summary @($samples.temperature)
    pstates = @($samples.pstate | Sort-Object -Unique)
} | ConvertTo-Json -Compress -Depth 5

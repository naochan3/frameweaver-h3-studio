[CmdletBinding()]
param(
    [string]$ComfyUrl = 'http://127.0.0.1:8188',
    [string]$FixturePath = (Join-Path $PSScriptRoot 'fixtures\fixed-seed-sdxl-high.json'),
    [ValidateRange(60, 3600)][int]$TimeoutSeconds = 900,
    [string]$ArtifactDirectory = (Join-Path $env:LOCALAPPDATA 'FrameWeaver\benchmarks')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$workflow = Get-Content -Raw -LiteralPath $FixturePath | ConvertFrom-Json
if ([int64]$workflow.sampler.inputs.seed -ne 424242) { throw 'benchmark seed must remain 424242' }
$runId = [guid]::NewGuid().ToString()
$workflow.positive.inputs.text += (' ' * (1 + ([Convert]::ToInt32($runId.Substring(0, 2), 16) % 31)))
$sampler = $workflow.sampler
$samplerNodeId = "sampler_$($runId.Replace('-', ''))"
$workflow.PSObject.Properties.Remove('sampler')
$workflow | Add-Member -NotePropertyName $samplerNodeId -NotePropertyValue $sampler
$workflow.decode.inputs.samples[0] = $samplerNodeId
$workflow.save.inputs.filename_prefix = "FrameWeaver/benchmark/fixed-sdxl-high-$($runId.Replace('-', ''))"
$body = @{ prompt_id = $runId; client_id = [guid]::NewGuid().ToString(); prompt = $workflow } | ConvertTo-Json -Depth 30

$samples = [Collections.Generic.List[object]]::new()
$started = Get-Date
Invoke-RestMethod -Method Post -Uri "$ComfyUrl/prompt" -ContentType 'application/json' -Body $body -TimeoutSec 30 | Out-Null
do {
    $gpu = @(& nvidia-smi.exe --query-gpu=memory.used,utilization.gpu,power.draw,temperature.gpu --format=csv,noheader,nounits 2>$null)[0] -split ',' | ForEach-Object { $_.Trim() }
    $samples.Add([pscustomobject]@{ at=(Get-Date).ToUniversalTime().ToString('o'); vram_mib=[double]$gpu[0]; util=[double]$gpu[1]; power_w=[double]$gpu[2]; temp_c=[double]$gpu[3] })
    $history = Invoke-RestMethod -Uri "$ComfyUrl/history/$runId" -TimeoutSec 10
    if ($history.PSObject.Properties.Name -contains $runId) { break }
    if (((Get-Date) - $started).TotalSeconds -ge $TimeoutSeconds) { throw "benchmark timed out after $TimeoutSeconds seconds" }
    Start-Sleep -Seconds 1
} while ($true)

$entry = $history.$runId
if ($entry.status.status_str -ne 'success') { throw 'benchmark generation failed' }
$output = @($entry.outputs.PSObject.Properties.Value | ForEach-Object { $_.images } | Where-Object { $_ })[0][0]
$query = [uri]::EscapeDataString($output.filename)
$subfolder = [uri]::EscapeDataString($output.subfolder)
$bytes = (Invoke-WebRequest -UseBasicParsing -Uri "$ComfyUrl/view?filename=$query&subfolder=$subfolder&type=output" -TimeoutSec 30).Content
if ($bytes -is [string]) { $bytes = [Text.Encoding]::UTF8.GetBytes($bytes) }
$sha256 = [Security.Cryptography.SHA256]::Create()
try { $hash = ([BitConverter]::ToString($sha256.ComputeHash([byte[]]$bytes))).Replace('-', '') } finally { $sha256.Dispose() }
New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
$result = [pscustomobject]@{
    schema='frameweaver.fixed_benchmark.v1'; run_id=$runId; seed=424242; width=[int]$workflow.latent.inputs.width; height=[int]$workflow.latent.inputs.height
    steps=[int]$sampler.inputs.steps; sampler=$sampler.inputs.sampler_name; scheduler=$sampler.inputs.scheduler
    elapsed_seconds=[math]::Round(((Get-Date)-$started).TotalSeconds,2); peak_vram_mib=($samples.vram_mib|Measure-Object -Maximum).Maximum
    peak_gpu_util=($samples.util|Measure-Object -Maximum).Maximum; peak_power_w=($samples.power_w|Measure-Object -Maximum).Maximum
    peak_temperature_c=($samples.temp_c|Measure-Object -Maximum).Maximum; output_file=$output.filename; output_bytes=([byte[]]$bytes).Length; sha256=$hash
}
$path = Join-Path $ArtifactDirectory "$runId.json"
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding utf8
$result | ConvertTo-Json -Compress

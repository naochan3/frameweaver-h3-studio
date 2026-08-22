[CmdletBinding()]
param(
    [int]$Port = 15181,
    [string]$ProjectRoot,
    [string]$ArtifactDirectory = $env:TEMP
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = if ($ProjectRoot) { $ProjectRoot } else { Split-Path -Parent $PSScriptRoot }
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (Test-NetConnection 127.0.0.1 -Port $Port -InformationLevel Quiet) {
    throw "Refusing to reuse occupied shadow port $Port. Choose an unused test port."
}
New-Item -ItemType Directory -Force -Path $ArtifactDirectory | Out-Null
$artifactPath = Join-Path $ArtifactDirectory ("frameweaver-live-cancel-{0}.json" -f ([guid]::NewGuid().ToString('N')))
$runRoot = Join-Path $env:TEMP ("fw-live-cancel-{0}" -f ([guid]::NewGuid()))
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null

function Stop-Child([Diagnostics.Process]$Process) {
    if ($Process -and -not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit() }
}
function Wait-Job([string]$JobId, [hashtable]$Headers, [int]$TimeoutSeconds = 180) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Seconds 1
        $current = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$JobId" -Headers $Headers -TimeoutSec 5
    } while ($current.status -in 'queued','running','cancel_requested' -and (Get-Date) -lt $deadline)
    return $current
}

& cargo build --manifest-path "$root\frameweaverd\Cargo.toml" --bin frameweaverd
if ($LASTEXITCODE -ne 0) { throw 'frameweaverd build failed' }
$old = @{ Listen = $env:FRAMEWEAVER_LISTEN_ADDR; Comfy = $env:FRAMEWEAVER_COMFY_URL; AppData = $env:LOCALAPPDATA; Discord = $env:DISCORD_AUTH_ENABLED }
$process = $null
try {
    $env:FRAMEWEAVER_LISTEN_ADDR = "127.0.0.1:$Port"
    $env:FRAMEWEAVER_COMFY_URL = 'http://127.0.0.1:8188/'
    $env:LOCALAPPDATA = $runRoot
    $env:DISCORD_AUTH_ENABLED = '0'
    $process = Start-Process "$root\frameweaverd\target\debug\frameweaverd.exe" -WorkingDirectory $root -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(20)
    do {
        try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 1 } catch {}
        Start-Sleep -Milliseconds 200
    } while ((-not $health -or $health.service -ne 'ready') -and (Get-Date) -lt $deadline)
    if ($health.service -ne 'ready' -or $health.database -ne 'ready') { throw 'shadow daemon did not become ready' }

    $ownerA = '11111111-1111-4111-8111-111111111111'
    $ownerB = '22222222-2222-4222-8222-222222222222'
    $headersA = @{ 'X-FrameWeaver-Owner' = $ownerA }
    $headersB = @{ 'X-FrameWeaver-Owner' = $ownerB }
    $fixture = Get-Content -Raw "$root\scripts\fixtures\task9-minimal-image.json" | ConvertFrom-Json
    $runId = [guid]::NewGuid().ToString('N')

    # Establish an independent durable history row first. Its completed state must not change
    # when the following immediate cancellation runs.
    $fixture.save.inputs.filename_prefix = "zimage/FrameWeaver/cancel-control-$runId"
    $controlPayload = @{ client_id = '33333333-3333-4333-8333-333333333333'; kind = 'image'; mode = 'live-cancel-control'; prompt = 'safe control image'; settings = @{}; workflow = $fixture } | ConvertTo-Json -Depth 30
    $control = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs" -Method Post -Headers $headersA -ContentType 'application/json' -Body $controlPayload
    $controlBefore = Wait-Job $control.id $headersA
    if ($controlBefore.status -ne 'succeeded' -or -not $controlBefore.output_json) { throw "control job did not succeed: $($controlBefore.status)" }

    $fixture.save.inputs.filename_prefix = "zimage/FrameWeaver/cancel-target-$runId"
    # 256px and the same model remain a bounded smoke workload. A few sampler steps
    # keep the job non-terminal long enough to exercise DELETE instead of asserting
    # a misleading cancellation success after a one-step completion race.
    $fixture.sampler.inputs.steps = 20
    $targetPayload = @{ client_id = '44444444-4444-4444-8444-444444444444'; kind = 'image'; mode = 'live-cancel-target'; prompt = 'safe immediate cancellation image'; settings = @{}; workflow = $fixture } | ConvertTo-Json -Depth 30
    $target = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs" -Method Post -Headers $headersA -ContentType 'application/json' -Body $targetPayload

    $ownerBDeleteStatus = $null
    try {
        Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($target.id)" -Method Delete -Headers $headersB -ErrorAction Stop | Out-Null
        $ownerBDeleteStatus = 200
    } catch {
        $ownerBDeleteStatus = $_.Exception.Response.StatusCode.value__
    }
    if ($ownerBDeleteStatus -ne 404) { throw "owner B DELETE returned $ownerBDeleteStatus instead of 404" }

    $cancelApi = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($target.id)" -Method Delete -Headers $headersA -TimeoutSec 15
    $targetReadback = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($target.id)" -Headers $headersA -TimeoutSec 5
    $controlAfter = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($control.id)" -Headers $headersA -TimeoutSec 5
    $cancelVerified = $cancelApi.status -eq 'cancelled' -and $targetReadback.status -eq 'cancelled'
    $controlUnchanged = $controlAfter.status -eq $controlBefore.status -and $controlAfter.output_json -eq $controlBefore.output_json
    $result = [ordered]@{
        timestamp_utc = (Get-Date).ToUniversalTime().ToString('o')
        daemon_port = $Port
        control_job_id = $control.id
        control_status_before = $controlBefore.status
        control_status_after = $controlAfter.status
        control_output_unchanged = $controlUnchanged
        target_job_id = $target.id
        owner_b_delete_status = $ownerBDeleteStatus
        cancel_api_status = $cancelApi.status
        cancel_readback_status = $targetReadback.status
        cancellation_verified = $cancelVerified
        result = if ($cancelVerified -and $controlUnchanged) { 'pass' } else { 'fail' }
    }
    $result | ConvertTo-Json | Set-Content -LiteralPath $artifactPath -Encoding UTF8
    if ($result.result -ne 'pass') {
        throw "immediate cancellation was not verified; artifact=$artifactPath; api=$($cancelApi.status); readback=$($targetReadback.status)"
    }
    [pscustomobject]@{ Passed = $true; ArtifactPath = $artifactPath; TargetJob = $target.id; ControlJob = $control.id }
} finally {
    Stop-Child $process
    $env:FRAMEWEAVER_LISTEN_ADDR = $old.Listen
    $env:FRAMEWEAVER_COMFY_URL = $old.Comfy
    $env:LOCALAPPDATA = $old.AppData
    $env:DISCORD_AUTH_ENABLED = $old.Discord
}

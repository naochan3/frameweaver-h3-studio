[CmdletBinding()]
param(
    [int]$Port = 15180,
    [string]$ProjectRoot,
    [switch]$LiveImageSmoke
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = if ($ProjectRoot) { $ProjectRoot } else { Split-Path -Parent $PSScriptRoot }
$projectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$binary = Join-Path $projectRoot 'frameweaverd\target\debug\frameweaverd.exe'
$mockBinary = Join-Path $projectRoot 'frameweaverd\target\debug\frameweaver-shadow-comfy.exe'
& cargo build --manifest-path (Join-Path $projectRoot 'frameweaverd\Cargo.toml') --bin frameweaverd --bin frameweaver-shadow-comfy
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
if (-not (Test-Path -LiteralPath $binary)) { throw "Missing shadow binary: $binary" }
if (-not (Test-Path -LiteralPath $mockBinary)) { throw "Missing shadow upstream binary: $mockBinary" }
if (Test-NetConnection 127.0.0.1 -Port $Port -InformationLevel Quiet) { throw "Shadow port $Port is already in use" }

$upstreamPort = $Port + 100
if (Test-NetConnection 127.0.0.1 -Port $upstreamPort -InformationLevel Quiet) { throw "Shadow upstream port $upstreamPort is already in use" }
$runRoot = Join-Path ([System.IO.Path]::GetTempPath()) "frameweaver-shadow-$([guid]::NewGuid())"
$localAppData = Join-Path $runRoot 'localappdata'
New-Item -ItemType Directory -Force -Path $localAppData | Out-Null
$reportPath = Join-Path $runRoot 'shadow-e2e.jsonl'
$mockLogPath = Join-Path $runRoot 'mock-upstream.log'

function Write-Report([string]$Step, [string]$Result, [string]$Detail = '') {
    @{ timestamp = (Get-Date).ToUniversalTime().ToString('o'); step = $Step; result = $Result; detail = $Detail } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath $reportPath -Encoding UTF8
}
function Assert-Shadow([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

$process = $null
$mock = $null
try {
    $priorListen = $env:FRAMEWEAVER_LISTEN_ADDR
    $priorComfy = $env:FRAMEWEAVER_COMFY_URL
    $priorLocalAppData = $env:LOCALAPPDATA
    $priorMockAddress = $env:FRAMEWEAVER_SHADOW_COMFY_ADDR
    $priorDiscordAuth = $env:DISCORD_AUTH_ENABLED
    $env:FRAMEWEAVER_SHADOW_COMFY_ADDR = "127.0.0.1:$upstreamPort"
    $mock = Start-Process -FilePath $mockBinary -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $mockLogPath -RedirectStandardError "$mockLogPath.stderr"
    $env:FRAMEWEAVER_SHADOW_COMFY_ADDR = $priorMockAddress
    $env:FRAMEWEAVER_LISTEN_ADDR = "127.0.0.1:$Port"
    $env:FRAMEWEAVER_COMFY_URL = "http://127.0.0.1:$upstreamPort/"
    $env:LOCALAPPDATA = $localAppData
    $env:DISCORD_AUTH_ENABLED = '0'
    $process = Start-Process -FilePath $binary -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden
    $env:FRAMEWEAVER_LISTEN_ADDR = $priorListen
    $env:FRAMEWEAVER_COMFY_URL = $priorComfy
    $env:LOCALAPPDATA = $priorLocalAppData
    $env:DISCORD_AUTH_ENABLED = $priorDiscordAuth

    $deadline = (Get-Date).AddSeconds(20)
    do { try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 1 } catch {}; Start-Sleep -Milliseconds 200 } while ((-not $health -or $health.service -ne 'ready') -and (Get-Date) -lt $deadline)
    Assert-Shadow ($health.service -eq 'ready' -and $health.database -eq 'ready') 'shadow health did not become ready'
    Write-Report 'health' 'pass'

    Write-Report 'static_load' 'started'
    $static = Invoke-WebRequest "http://127.0.0.1:$Port/" -Headers @{ Accept = 'text/html' } -UseBasicParsing -TimeoutSec 5
    Assert-Shadow ($static.StatusCode -eq 200 -and $static.Content -match '<div id="root">') 'static UI did not load'
    Write-Report 'static_load' 'pass'
    Write-Report 'fleet' 'started'
    $fleet = Invoke-RestMethod "http://127.0.0.1:$Port/api/fleet" -TimeoutSec 5
    Assert-Shadow ($null -ne $fleet.samples) 'fleet payload is missing samples'
    Write-Report 'fleet' 'pass'

    $ownerA = '11111111-1111-4111-8111-111111111111'
    $ownerB = '22222222-2222-4222-8222-222222222222'
    $headersA = @{ 'X-FrameWeaver-Owner' = $ownerA }
    $headersB = @{ 'X-FrameWeaver-Owner' = $ownerB }
    $payload = @{ client_id = '33333333-3333-4333-8333-333333333333'; kind = 'image'; mode = 'shadow'; prompt = 'shadow e2e'; settings = @{}; workflow = @{} } | ConvertTo-Json -Depth 10
    $job = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs" -Method Post -Headers $headersA -ContentType 'application/json' -Body $payload
    Assert-Shadow ($job.owner_id -eq $ownerA -and $job.id) 'owner A job creation failed'

    try { Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($job.id)" -Method Delete -Headers $headersB -ErrorAction Stop; throw 'owner B cancellation unexpectedly succeeded' } catch {
        $status = $_.Exception.Response.StatusCode.value__
        Assert-Shadow ($status -eq 404) "owner B cancellation returned $status instead of 404"
    }
    Write-Report 'owner_b_cancel_denied' 'pass'
    $cancelled = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($job.id)" -Method Delete -Headers $headersA
    Assert-Shadow ($cancelled.status -eq 'cancelled') 'owner A targeted cancellation did not persist'
    $read = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($job.id)" -Headers $headersA
    Assert-Shadow ($read.id -eq $job.id -and $read.status -eq 'cancelled') 'owner A could not read its cancelled job'
    Write-Report 'owner_create_read' 'pass' $job.id
    Write-Report 'owner_a_targeted_cancel' 'pass'

    $process.Kill(); $process.WaitForExit()
    $env:FRAMEWEAVER_LISTEN_ADDR = "127.0.0.1:$Port"; $env:FRAMEWEAVER_COMFY_URL = "http://127.0.0.1:$upstreamPort/"; $env:LOCALAPPDATA = $localAppData; $env:DISCORD_AUTH_ENABLED = '0'
    $process = Start-Process -FilePath $binary -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden
    $env:FRAMEWEAVER_LISTEN_ADDR = $priorListen; $env:FRAMEWEAVER_COMFY_URL = $priorComfy; $env:LOCALAPPDATA = $priorLocalAppData; $env:DISCORD_AUTH_ENABLED = $priorDiscordAuth
    Start-Sleep -Milliseconds 700
    $persisted = Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($job.id)" -Headers $headersA
    Assert-Shadow ($persisted.status -eq 'cancelled') 'cancelled job was not durable across restart'
    Write-Report 'restart_persistence' 'pass'

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $null = $socket.ConnectAsync([uri]"ws://127.0.0.1:$Port/comfy/ws", [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    Assert-Shadow ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) 'WebSocket proxy did not connect'
    $payloadBytes = [Text.Encoding]::UTF8.GetBytes('shadow-echo')
    $null = $socket.SendAsync([ArraySegment[byte]]::new($payloadBytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $buffer = [byte[]]::new(64)
    $echo = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    Assert-Shadow (([Text.Encoding]::UTF8.GetString($buffer, 0, $echo.Count)) -eq 'shadow-echo') 'WebSocket proxy did not echo payload'
    $socket.Dispose()
    Write-Report 'websocket' 'pass'
    if (-not $LiveImageSmoke) {
        Write-Report 'minimal_image' 'skipped' 'requires explicit -LiveImageSmoke; not part of shadow gate'
        [pscustomobject]@{ Passed = $true; Port = $Port; ReportPath = $reportPath; ImageGeneration = 'skipped_opt_in' }
    } else {
        try { $system = Invoke-RestMethod 'http://127.0.0.1:8188/system_stats' -TimeoutSec 3 } catch { throw "LiveImageSmoke requires healthy ComfyUI: $($_.Exception.Message)" }
        Assert-Shadow ($null -ne $system) 'LiveImageSmoke system_stats was empty'
        $fixture = Get-Content -Raw (Join-Path $projectRoot 'scripts\fixtures\task9-minimal-image.json') | ConvertFrom-Json
        $runId = [guid]::NewGuid().ToString('N')
        $prefix = "zimage/FrameWeaver/task9-e2e-$runId"
        $fixture.save.inputs.filename_prefix = $prefix
        Assert-Shadow ($prefix -match [regex]::Escape($runId)) 'LiveImageSmoke run prefix is not unique'
        $submittedAt = Get-Date
        $submission = Invoke-RestMethod 'http://127.0.0.1:8188/prompt' -Method Post -ContentType 'application/json' -Body (@{ prompt = $fixture; client_id = 'frameweaver-task9-e2e' } | ConvertTo-Json -Depth 20)
        $deadline = (Get-Date).AddSeconds(120); $history = $null
        do { Start-Sleep -Seconds 2; $history = Invoke-RestMethod "http://127.0.0.1:8188/history/$($submission.prompt_id)" -TimeoutSec 5 } while (-not $history.$($submission.prompt_id) -and (Get-Date) -lt $deadline)
        $entry = $history.$($submission.prompt_id)
        Assert-Shadow ($entry.status.completed -eq $true -and $entry.status.status_str -eq 'success') 'LiveImageSmoke did not complete successfully'
        $image = @($entry.outputs.save.images)[0]
        Assert-Shadow ($image.filename -like "task9-e2e-$runId*") 'LiveImageSmoke history filename does not match this run'
        $download = Join-Path $runRoot $image.filename
        $view = Invoke-WebRequest ("http://127.0.0.1:8188/view?filename=$([uri]::EscapeDataString($image.filename))&subfolder=$([uri]::EscapeDataString($image.subfolder))&type=$([uri]::EscapeDataString($image.type))") -UseBasicParsing -OutFile $download -PassThru -TimeoutSec 20
        Assert-Shadow ($view.Headers['Content-Type'] -like 'image/*') 'LiveImageSmoke view is not an image response'
        $bytes = [IO.File]::ReadAllBytes($download)
        Assert-Shadow ($bytes.Length -gt 8 -and ([BitConverter]::ToString($bytes[0..7]) -eq '89-50-4E-47-0D-0A-1A-0A')) 'LiveImageSmoke output is not a PNG'
        $hash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
        $downloadItem = Get-Item -LiteralPath $download
        Assert-Shadow ($downloadItem.LastWriteTime -ge $submittedAt) 'LiveImageSmoke readback predates submission'
        Write-Report 'minimal_image' 'pass' ("prompt_id={0}; filename={1}; mtime={2}; sha256={3}; bytes={4}" -f $submission.prompt_id, $image.filename, $downloadItem.LastWriteTimeUtc.ToString('o'), $hash, $bytes.Length)
        [pscustomobject]@{ Passed = $true; Port = $Port; ReportPath = $reportPath; ImageGeneration = 'passed'; PromptId = $submission.prompt_id }
    }
} finally {
    if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    if ($mock -and -not $mock.HasExited) { $mock.Kill(); $mock.WaitForExit() }
    $env:FRAMEWEAVER_LISTEN_ADDR = $priorListen
    $env:FRAMEWEAVER_COMFY_URL = $priorComfy
    $env:LOCALAPPDATA = $priorLocalAppData
    $env:DISCORD_AUTH_ENABLED = $priorDiscordAuth
    $env:FRAMEWEAVER_SHADOW_COMFY_ADDR = $priorMockAddress
}

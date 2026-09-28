[CmdletBinding()]
param([int]$Port = 15181, [string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$ProjectRoot = if ($ProjectRoot) { $ProjectRoot } else { Split-Path -Parent $PSScriptRoot }
$root = (Resolve-Path $ProjectRoot).Path
$run = Join-Path $env:TEMP "fw-live-$([guid]::NewGuid())"; New-Item -ItemType Directory $run | Out-Null
& cargo build --manifest-path "$root\frameweaverd\Cargo.toml" --bin frameweaverd; if ($LASTEXITCODE) { throw 'build failed' }
$old = @{ L=$env:FRAMEWEAVER_LISTEN_ADDR; C=$env:FRAMEWEAVER_COMFY_URL; A=$env:LOCALAPPDATA; D=$env:DISCORD_AUTH_ENABLED }; $p=$null
try {
  $env:FRAMEWEAVER_LISTEN_ADDR="127.0.0.1:$Port"; $env:FRAMEWEAVER_COMFY_URL='http://127.0.0.1:8188/'; $env:LOCALAPPDATA=$run; $env:DISCORD_AUTH_ENABLED='0'
  $p=Start-Process "$root\frameweaverd\target\debug\frameweaverd.exe" -WorkingDirectory $root -PassThru -WindowStyle Hidden
  $deadline=(Get-Date).AddSeconds(20); do { try {$h=Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 1}catch{}; Start-Sleep -Milliseconds 200 } while (!$h -and (Get-Date) -lt $deadline); if(!$h){throw 'shadow health unavailable'}
  $f=Get-Content -Raw "$root\scripts\fixtures\task9-minimal-image.json"|ConvertFrom-Json; $f.save.inputs.filename_prefix="zimage/FrameWeaver/final-$([guid]::NewGuid().ToString('N'))"
  $owner='11111111-1111-4111-8111-111111111111'; $body=@{client_id='33333333-3333-4333-8333-333333333333';kind='image';mode='live-e2e';prompt='final live e2e';settings=@{};workflow=$f}|ConvertTo-Json -Depth 30
  $job=Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs" -Method Post -Headers @{'X-FrameWeaver-Owner'=$owner} -ContentType 'application/json' -Body $body
  $deadline=(Get-Date).AddSeconds(180); do {Start-Sleep -Seconds 2;$got=Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($job.id)" -Headers @{'X-FrameWeaver-Owner'=$owner}} while($got.status -in 'queued','running' -and (Get-Date)-lt $deadline)
  $denied=$null; try {Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($job.id)" -Method Delete -Headers @{'X-FrameWeaver-Owner'='22222222-2222-4222-8222-222222222222'} -ErrorAction Stop} catch {$denied=$_.Exception.Response.StatusCode.value__}
  if($got.status -ne 'succeeded' -or !$got.output_json -or $denied -ne 404){throw "live e2e failed: $($got.status), denied=$denied"}
  $p.Kill();$p.WaitForExit();$p=Start-Process "$root\frameweaverd\target\debug\frameweaverd.exe" -WorkingDirectory $root -PassThru -WindowStyle Hidden;Start-Sleep -Seconds 1;$again=Invoke-RestMethod "http://127.0.0.1:$Port/api/jobs/$($job.id)" -Headers @{'X-FrameWeaver-Owner'=$owner};if($again.output_json -ne $got.output_json){throw 'restart history mismatch'}
  [pscustomobject]@{Job=$job.id;Status=$got.status;Output=$got.output_json;OwnerB=$denied;Persisted=$again.status}
} finally {if($p -and -not $p.HasExited){$p.Kill();$p.WaitForExit()};$env:FRAMEWEAVER_LISTEN_ADDR=$old.L;$env:FRAMEWEAVER_COMFY_URL=$old.C;$env:LOCALAPPDATA=$old.A;$env:DISCORD_AUTH_ENABLED=$old.D}

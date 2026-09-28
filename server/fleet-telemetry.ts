import { hostname } from 'node:os'

export type WorkerStatus = 'unknown' | 'online' | 'offline'
export type ComfyStatus = 'unknown' | 'online' | 'offline'

export type CollectedTelemetry = {
  host: string
  vramTotal: number
  vramUsed: number
  utilization: number
  powerDraw: number
  powerLimit: number
  temperature: number
  pstate: string
  powerPlan: string
  comfyStatus: Exclude<ComfyStatus, 'unknown'>
  at: string
}

export type FleetSample = Omit<Partial<CollectedTelemetry>, 'comfyStatus'> & {
  worker: string
  hostStatus: WorkerStatus
  comfyStatus: ComfyStatus
  ageMs: number | null
  stale: boolean
  sampleIntervalMs: number
  peakVramUsed?: number
  lastSeenAt?: string
  lastAttemptAt?: string
  error?: 'telemetry_unavailable'
}

export type FleetSnapshot = { samples: FleetSample[]; at: string; collecting: boolean }

type Options = {
  workers: string[]
  collect: (worker: string) => Promise<CollectedTelemetry>
  now?: () => number
  staleAfterMs?: number
  peakWindowMs?: number
  sampleIntervalMs?: number
}

type ExecResult = { stdout: string }
type Exec = (file: string, args: string[], options: { timeout: number; encoding: 'utf8'; windowsHide: boolean }) => Promise<ExecResult>

const telemetryScript = `
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$nv = (Get-Command nvidia-smi.exe,nvidia-smi -ErrorAction Stop | Select-Object -First 1).Source
$v = (& $nv --query-gpu=memory.total,memory.used,utilization.gpu,power.draw,power.limit,temperature.gpu,pstate --format=csv,noheader,nounits) -split ',\\s*'
$plan = ((powercfg /getactivescheme 2>$null | Out-String) -replace '^.*\\((.*)\\).*$', '$1').Trim()
$comfyStatus = 'offline'
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8188/system_stats' -TimeoutSec 2 -ErrorAction Stop
  if ($response.StatusCode -eq 200) { $comfyStatus = 'online' }
} catch {}
[pscustomobject]@{host=[Environment]::MachineName;vramTotal=[int]$v[0];vramUsed=[int]$v[1];utilization=[int]$v[2];powerDraw=[double]$v[3];powerLimit=[double]$v[4];temperature=[int]$v[5];pstate=$v[6];powerPlan=$plan;comfyStatus=$comfyStatus;at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress
`

type HealthFetch = (input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean }>
const powerPlanNames: Record<string, string> = {
  '381b4222-f694-41f0-9685-ff5bb260df2e': 'バランス',
  '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c': '高パフォーマンス',
  'a1841308-3541-4fab-bc81-f71556f20b4a': '省電力',
  'e9a42b02-d5df-448d-aa00-03f14749eb61': '究極のパフォーマンス',
}

export function createFleetTelemetryCollector({
  exec,
  localWorker,
  hostName = hostname(),
  fetch: healthFetch = globalThis.fetch,
  now = Date.now,
}: {
  exec: Exec
  localWorker: string
  hostName?: string
  fetch?: HealthFetch
  now?: () => number
}) {
  const encoded = Buffer.from(telemetryScript, 'utf16le').toString('base64')
  const remoteCommand = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
  return async (worker: string): Promise<CollectedTelemetry> => {
    const local = worker === localWorker
    if (!local) {
      const { stdout } = await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', worker, remoteCommand], { timeout: 8_000, encoding: 'utf8', windowsHide: true })
      return parseTelemetryOutput(stdout, worker)
    }

    const quickOptions = { timeout: 3_000, encoding: 'utf8' as const, windowsHide: true }
    const [nvidia, power, comfyStatus] = await Promise.all([
      exec('nvidia-smi.exe', ['--query-gpu=memory.total,memory.used,utilization.gpu,power.draw,power.limit,temperature.gpu,pstate', '--format=csv,noheader,nounits'], quickOptions),
      exec('powercfg.exe', ['/getactivescheme'], quickOptions),
      healthFetch('http://127.0.0.1:8188/system_stats', { signal: AbortSignal.timeout(2_000) })
        .then((response) => response.ok ? 'online' as const : 'offline' as const)
        .catch(() => 'offline' as const),
    ])
    const values = nvidia.stdout.trim().split(/,\s*/)
    const numbers = values.slice(0, 6).map(Number)
    if (values.length !== 7 || numbers.some((value) => !Number.isFinite(value))) throw new Error('local telemetry invalid')
    const powerPlanGuid = power.stdout.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0]?.toLowerCase()
    const powerPlan = powerPlanGuid ? (powerPlanNames[powerPlanGuid] ?? `カスタム (${powerPlanGuid.slice(0, 8)})`) : '不明'
    return {
      host: hostName,
      vramTotal: numbers[0],
      vramUsed: numbers[1],
      utilization: numbers[2],
      powerDraw: numbers[3],
      powerLimit: numbers[4],
      temperature: numbers[5],
      pstate: values[6],
      powerPlan,
      comfyStatus,
      at: new Date(now()).toISOString(),
    }
  }
}

const numericFields = ['vramTotal', 'vramUsed', 'utilization', 'powerDraw', 'powerLimit', 'temperature'] as const

export function parseTelemetryOutput(stdout: string, fallbackHost?: string): CollectedTelemetry {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim().startsWith('{"host"'))
  if (!line) throw new Error('telemetry JSON missing')
  let value: unknown
  try {
    value = JSON.parse(line.trim())
  } catch {
    throw new Error('telemetry JSON invalid')
  }
  if (!value || typeof value !== 'object') throw new Error('telemetry JSON invalid')
  const record = value as Record<string, unknown>
  if (typeof record.host !== 'string' && fallbackHost) record.host = fallbackHost
  const stringsValid = ['host', 'pstate', 'powerPlan', 'at'].every((field) => typeof record[field] === 'string')
  const numbersValid = numericFields.every((field) => typeof record[field] === 'number' && Number.isFinite(record[field]) && (record[field] as number) >= 0)
  const comfyValid = record.comfyStatus === 'online' || record.comfyStatus === 'offline'
  if (!stringsValid || !numbersValid || !comfyValid || (record.vramUsed as number) > (record.vramTotal as number)) {
    throw new Error('telemetry JSON invalid')
  }
  return record as CollectedTelemetry
}

type StoredSample = {
  data?: CollectedTelemetry
  hostStatus: WorkerStatus
  comfyStatus: ComfyStatus
  lastSuccessMs?: number
  lastAttemptMs?: number
  error?: 'telemetry_unavailable'
  history: Array<{ at: number; used: number }>
}

export function createFleetTelemetryStore(options: Options) {
  const now = options.now ?? Date.now
  const staleAfterMs = options.staleAfterMs ?? 30_000
  const peakWindowMs = options.peakWindowMs ?? 60_000
  const sampleIntervalMs = options.sampleIntervalMs ?? 15_000
  const state = new Map<string, StoredSample>(options.workers.map((worker) => [worker, {
    hostStatus: 'unknown',
    comfyStatus: 'unknown',
    history: [],
  }]))
  let refreshPromise: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const refreshAll = async () => {
    await Promise.all(options.workers.map(async (worker) => {
      const current = state.get(worker)!
      const attemptedAt = now()
      try {
        const data = await options.collect(worker)
        const collectedAt = now()
        current.data = data
        current.hostStatus = 'online'
        current.comfyStatus = data.comfyStatus
        current.lastSuccessMs = collectedAt
        current.lastAttemptMs = collectedAt
        current.error = undefined
        current.history.push({ at: collectedAt, used: data.vramUsed })
      } catch {
        current.hostStatus = 'offline'
        current.comfyStatus = 'unknown'
        current.lastAttemptMs = attemptedAt
        current.error = 'telemetry_unavailable'
      }
    }))
  }

  const refresh = () => {
    if (refreshPromise) return refreshPromise
    refreshPromise = refreshAll().finally(() => { refreshPromise = undefined })
    return refreshPromise
  }

  const snapshot = (): FleetSnapshot => {
    const snapshotAt = now()
    const samples = options.workers.map((worker): FleetSample => {
      const current = state.get(worker)!
      const cutoff = snapshotAt - peakWindowMs
      current.history = current.history.filter((point) => point.at >= cutoff)
      const peakVramUsed = current.history.length
        ? Math.max(...current.history.map((point) => point.used))
        : current.data?.vramUsed
      const ageMs = current.lastSuccessMs === undefined ? null : Math.max(0, snapshotAt - current.lastSuccessMs)
      return {
        worker,
        ...current.data,
        hostStatus: current.hostStatus,
        comfyStatus: current.comfyStatus,
        ageMs,
        stale: ageMs === null || ageMs > staleAfterMs || current.hostStatus !== 'online',
        sampleIntervalMs,
        peakVramUsed,
        lastSeenAt: current.lastSuccessMs === undefined ? undefined : new Date(current.lastSuccessMs).toISOString(),
        lastAttemptAt: current.lastAttemptMs === undefined ? undefined : new Date(current.lastAttemptMs).toISOString(),
        error: current.error,
      }
    })
    return { samples, at: new Date(snapshotAt).toISOString(), collecting: refreshPromise !== undefined }
  }

  const start = (intervalMs: number) => {
    if (timer) return
    void refresh()
    timer = setInterval(() => { void refresh() }, intervalMs)
    timer.unref?.()
  }

  const stop = () => {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  return { refresh, snapshot, start, stop }
}

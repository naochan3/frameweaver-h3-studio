import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFleetTelemetryCollector, createFleetTelemetryStore, parseTelemetryOutput, type CollectedTelemetry } from './fleet-telemetry.js'

const sample = (vramUsed: number, comfyStatus: 'online' | 'offline' = 'online'): CollectedTelemetry => ({
  host: 'GPU-HOST',
  vramTotal: 24_564,
  vramUsed,
  utilization: 42,
  powerDraw: 120,
  powerLimit: 450,
  temperature: 55,
  pstate: 'P2',
  powerPlan: 'バランス',
  comfyStatus,
  at: '2026-08-21T08:00:00.000Z',
})

describe('fleet telemetry store', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces concurrent refreshes into one collection per worker', async () => {
    let calls = 0
    let release: ((value: CollectedTelemetry) => void) | undefined
    const pending = new Promise<CollectedTelemetry>((resolve) => { release = resolve })
    const store = createFleetTelemetryStore({
      workers: ['rtx4090'],
      collect: async () => { calls += 1; return pending },
      now: () => Date.parse('2026-08-21T08:00:00.000Z'),
      sampleIntervalMs: 2_000,
    })

    const first = store.refresh()
    const second = store.refresh()
    release!(sample(2_000))
    await Promise.all([first, second])

    expect(calls).toBe(1)
    expect(store.snapshot().samples[0]).toMatchObject({ worker: 'rtx4090', hostStatus: 'online', comfyStatus: 'online', sampleIntervalMs: 2_000 })
  })

  it('serves cached snapshots without starting another collection', async () => {
    let calls = 0
    const store = createFleetTelemetryStore({
      workers: ['rtx4090'],
      collect: async () => { calls += 1; return sample(2_000) },
      now: () => Date.parse('2026-08-21T08:00:00.000Z'),
    })

    await store.refresh()
    store.snapshot()
    store.snapshot()

    expect(calls).toBe(1)
  })

  it('marks failed workers offline while retaining the last verified metrics', async () => {
    let fail = false
    let now = Date.parse('2026-08-21T08:00:00.000Z')
    const store = createFleetTelemetryStore({
      workers: ['rtx4090'],
      collect: async () => {
        if (fail) throw new Error('sensitive ssh detail')
        return sample(2_000)
      },
      now: () => now,
      staleAfterMs: 30_000,
    })

    await store.refresh()
    fail = true
    now += 31_000
    await store.refresh()

    expect(store.snapshot().samples[0]).toMatchObject({
      hostStatus: 'offline',
      comfyStatus: 'unknown',
      vramUsed: 2_000,
      stale: true,
      error: 'telemetry_unavailable',
    })
  })

  it('reports sample age and a rolling one-minute VRAM peak', async () => {
    let now = Date.parse('2026-08-21T08:00:00.000Z')
    let used = 2_000
    const store = createFleetTelemetryStore({
      workers: ['rtx4090'],
      collect: async () => sample(used),
      now: () => now,
      staleAfterMs: 30_000,
      peakWindowMs: 60_000,
    })

    await store.refresh()
    now += 10_000
    used = 9_000
    await store.refresh()
    now += 10_000
    used = 3_000
    await store.refresh()
    now += 5_000

    expect(store.snapshot().samples[0]).toMatchObject({ ageMs: 5_000, stale: false, peakVramUsed: 9_000 })

    now += 61_000
    expect(store.snapshot().samples[0].peakVramUsed).toBe(3_000)
  })

  it('runs one server-owned collection loop and stops it cleanly', async () => {
    vi.useFakeTimers()
    let calls = 0
    const store = createFleetTelemetryStore({
      workers: ['rtx4090'],
      collect: async () => { calls += 1; return sample(2_000) },
    })

    store.start(15_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toBe(2)

    store.stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toBe(2)
  })
})

describe('telemetry output parser', () => {
  it('extracts one validated telemetry record from noisy SSH output', () => {
    const stdout = `#< CLIXML\nprogress noise\n${JSON.stringify(sample(2_345))}\nmore noise`

    expect(parseTelemetryOutput(stdout)).toEqual(sample(2_345))
  })

  it('rejects malformed or non-finite telemetry instead of publishing it', () => {
    const invalid = JSON.stringify({ ...sample(2_345), vramUsed: 'not-a-number' })

    expect(() => parseTelemetryOutput(invalid)).toThrow('telemetry JSON invalid')
    expect(() => parseTelemetryOutput('no telemetry here')).toThrow('telemetry JSON missing')
  })

  it('uses the verified worker alias when Windows omits COMPUTERNAME', () => {
    const withoutHost = JSON.stringify({ ...sample(2_345), host: null })

    expect(parseTelemetryOutput(withoutHost, 'rtx4090').host).toBe('rtx4090')
  })

  it('collects the local GPU without SSH and remote GPUs through bounded SSH', async () => {
    const calls: Array<{ file: string; args: string[]; timeout?: number }> = []
    const exec = async (file: string, args: string[], options: { timeout?: number }) => {
      calls.push({ file, args, timeout: options.timeout })
      if (file === 'nvidia-smi.exe') return { stdout: '24564, 2345, 42, 120.0, 450.0, 55, P2' }
      if (file === 'powercfg.exe') return { stdout: 'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)' }
      return { stdout: JSON.stringify(sample(2_345)) }
    }
    const collect = createFleetTelemetryCollector({
      exec,
      localWorker: 'rtx4090',
      hostName: 'RTX4090',
      fetch: async () => ({ ok: true }),
      now: () => Date.parse('2026-08-21T08:00:00.000Z'),
    })

    expect(await collect('rtx4090')).toEqual({ ...sample(2_345), host: 'RTX4090' })
    await collect('rtx5060ti')

    expect(calls[0]).toMatchObject({ file: 'nvidia-smi.exe', timeout: 3_000 })
    expect(calls[1]).toMatchObject({ file: 'powercfg.exe', timeout: 3_000 })
    expect(calls[2]).toMatchObject({ file: 'ssh', timeout: 8_000 })
    expect(calls[2].args.slice(0, 6)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'rtx5060ti', expect.any(String)])
  })
})

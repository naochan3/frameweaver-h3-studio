import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdaptivePoller, pollDelay } from './adaptive-poller'

describe('pollDelay', () => {
  it('生成中は2秒、idleは10秒、backgroundは60秒にする', () => {
    expect(pollDelay('running', 'visible')).toBe(2_000)
    expect(pollDelay('queued', 'visible')).toBe(2_000)
    expect(pollDelay('idle', 'visible')).toBe(10_000)
    expect(pollDelay('idle', 'hidden')).toBe(60_000)
  })
})

describe('createAdaptivePoller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('start直後に1回実行し、完了後だけ次回を予約する', async () => {
    const calls: number[] = []
    const poller = createAdaptivePoller({
      poll: async () => { calls.push(Date.now()) },
      delay: () => 10_000,
    })

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(9_999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    poller.stop()
  })

  it('実行中のtriggerを重ねてもpollを二重起動しない', async () => {
    let resolvePoll!: () => void
    let calls = 0
    const poller = createAdaptivePoller({
      poll: () => {
        calls += 1
        return new Promise<void>((resolve) => { resolvePoll = resolve })
      },
      delay: () => 10_000,
    })

    const first = poller.trigger()
    const second = poller.trigger()
    expect(calls).toBe(1)
    resolvePoll()
    await Promise.all([first, second])
    expect(calls).toBe(1)
  })

  it('stop後は予約済みpollを実行しない', async () => {
    let calls = 0
    const poller = createAdaptivePoller({
      poll: async () => { calls += 1 },
      delay: () => 10_000,
    })

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    poller.stop()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls).toBe(1)
  })
})

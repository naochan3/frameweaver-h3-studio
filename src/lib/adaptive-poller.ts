export type PollingStatus = 'idle' | 'uploading' | 'queued' | 'running' | 'done' | 'error'

export function pollDelay(status: PollingStatus, visibility: DocumentVisibilityState): number {
  if (visibility !== 'visible') return 60_000
  return status === 'uploading' || status === 'queued' || status === 'running' ? 2_000 : 10_000
}

interface AdaptivePollerOptions {
  poll: () => Promise<void>
  delay: () => number
}

export interface AdaptivePoller {
  start(): void
  stop(): void
  trigger(): Promise<void>
}

export function createAdaptivePoller(options: AdaptivePollerOptions): AdaptivePoller {
  let active = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  const trigger = (): Promise<void> => {
    if (inFlight) return inFlight
    inFlight = options.poll().finally(() => { inFlight = null })
    return inFlight
  }

  const cycle = async (): Promise<void> => {
    try {
      await trigger()
    } catch {
      // The next scheduled poll is the retry boundary.
    }
    if (active) timer = setTimeout(() => { void cycle() }, options.delay())
  }

  return {
    start() {
      if (active) return
      active = true
      void cycle()
    },
    stop() {
      active = false
      if (timer) clearTimeout(timer)
      timer = null
    },
    trigger,
  }
}

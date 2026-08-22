// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FleetPanel } from './FleetPanel'

const snapshot = {
  at: '2026-08-22T00:00:00Z',
  collecting: true,
  samples: [
    {
      worker: 'rtx4090', hostStatus: 'online' as const, comfyStatus: 'online' as const,
      vramTotal: 24_576, vramUsed: 2_048, ageMs: 5_000, stale: false,
    },
    {
      worker: 'rtx5060ti', hostStatus: 'online' as const, comfyStatus: 'online' as const,
      vramTotal: 16_384, vramUsed: 5_120, ageMs: 65_000, stale: true,
    },
  ],
}

function setViewport(desktop: boolean) {
  let matches = desktop
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      get matches() { return matches && query === '(min-width: 640px)' },
      media: query,
      addEventListener: (_: 'change', listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_: 'change', listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    })),
  })
  return {
    resize(nextDesktop: boolean) {
      matches = nextDesktop
      listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent))
    },
  }
}

function mockSnapshot(value = snapshot) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => value }))
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FleetPanel responsive disclosure', () => {
  it('starts collapsed on mobile while exposing the aggregate fleet summary', async () => {
    setViewport(false)
    mockSnapshot()

    render(<FleetPanel />)

    const toggle = await screen.findByRole('button', { name: 'GPU ワーカー監視を表示' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await screen.findByText('オンライン 2 / 2')
    expect(screen.getByLabelText('使用 VRAM 7.0 GiB（古い値を含む）')).toBeInTheDocument()
    expect(screen.getByText('最古 1分前')).toBeInTheDocument()
    expect(screen.queryByText('RTX 4090')).not.toBeInTheDocument()
  })

  it('expands fleet details through an accessible disclosure button', async () => {
    setViewport(false)
    mockSnapshot()

    render(<FleetPanel />)

    const toggle = await screen.findByRole('button', { name: 'GPU ワーカー監視を表示' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('RTX 4090')).toBeInTheDocument()
  })

  it('keeps details visible without a toggle on desktop and after resizing wider', async () => {
    setViewport(true)
    mockSnapshot()

    render(<FleetPanel />)

    expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /GPU ワーカー監視を/ })).not.toBeInTheDocument()
  })

  it('forces fleet details open when the viewport crosses into desktop width', async () => {
    const viewport = setViewport(false)
    mockSnapshot()

    render(<FleetPanel />)

    await screen.findByRole('button', { name: 'GPU ワーカー監視を表示' })
    viewport.resize(true)
    expect(await screen.findByText('RTX 4090')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /GPU ワーカー監視を/ })).not.toBeInTheDocument()
  })

  it('labels stale values and telemetry failures for assistive technology', async () => {
    setViewport(true)
    mockSnapshot()

    const { unmount } = render(<FleetPanel />)
    expect(await screen.findByText('データ古い')).toBeInTheDocument()
    expect(screen.getByText(/最終正常値/)).toBeInTheDocument()
    unmount()

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(<FleetPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('監視APIに接続できません')
  })
})

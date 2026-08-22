// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerSelector } from './WorkerSelector'
import { useGenerationStore } from '../store/generation'

describe('WorkerSelector', () => {
  beforeEach(() => useGenerationStore.setState({ workerPreference: { mode: 'auto' } }))
  it('renders Auto and the stable fleet order with unavailable reasons', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ workers: [
      { id: 'rtx4090', label: 'RTX 4090', capabilities: ['image'], online: true, stale: false, free_vram_mb: 20000, queue_depth: 0 },
      { id: 'rtx5060ti', label: 'RTX 5060 Ti', capabilities: ['image'], online: false, stale: true, free_vram_mb: 0, queue_depth: 0 },
    ] })))
    render(<WorkerSelector />)
    await waitFor(() => expect(screen.getByRole('option', { name: /RTX 5060 Ti.*オフライン/ })).toBeDisabled())
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Auto（推奨）', 'RTX 5060 Ti — オフライン', 'RTX 4090 — 空き 19.5 GB',
    ])
    vi.unstubAllGlobals()
  })
})

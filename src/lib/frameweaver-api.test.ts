import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComfyClient } from './comfy-client'
import { FrameWeaverApi, getOwnerId, takeLegacyHistory, type FrameWeaverJob } from './frameweaver-api'

const ownerId = '11111111-1111-4111-8111-111111111111'
const storage = new Map<string, string>()

const job: FrameWeaverJob = {
  id: '22222222-2222-4222-8222-222222222222',
  owner_id: ownerId,
  kind: 'image',
  mode: 'zimage',
  status: 'queued',
  prompt: 'a lighthouse',
  settings_json: '{}',
  output_json: null,
  error: null,
  created_at: '2026-08-22T00:00:00Z',
  updated_at: '2026-08-22T00:00:00Z',
  started_at: null,
  finished_at: null,
}

describe('FrameWeaverApi', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    })
    vi.stubGlobal('crypto', { randomUUID: () => ownerId })
    vi.restoreAllMocks()
  })

  it('persists one owner UUID and sends it on create, list, and targeted cancellation', async () => {
    localStorage.setItem('frameweaver-owner-id', ownerId)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(job), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobs: [job] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...job, status: 'cancelled' })))
    vi.stubGlobal('fetch', fetchMock)
    const api = new FrameWeaverApi()

    await api.createJob({ client_id: '22222222-2222-4222-8222-222222222222', kind: 'image', mode: 'zimage', prompt: 'a lighthouse', settings: {}, workflow: {} })
    await api.listJobs()
    await api.cancelJob(job.id)

    expect(getOwnerId()).toBe(ownerId)
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/jobs', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'X-FrameWeaver-Owner': ownerId }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/jobs?limit=50', expect.objectContaining({
      headers: expect.objectContaining({ 'X-FrameWeaver-Owner': ownerId }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, `/api/jobs/${job.id}`, expect.objectContaining({
      method: 'DELETE', headers: expect.objectContaining({ 'X-FrameWeaver-Owner': ownerId }),
    }))
  })

  it('does not expose Comfy-wide interrupt or queue clearing controls', () => {
    expect(ComfyClient.prototype).not.toHaveProperty('interrupt')
    expect(ComfyClient.prototype).not.toHaveProperty('clearQueue')
    expect(ComfyClient.prototype).not.toHaveProperty('systemStats')
  })

  it('uses old local history only once as a migration fallback', () => {
    localStorage.setItem('frameweaver-history', JSON.stringify([{ promptId: 'legacy-job' }]))

    expect(takeLegacyHistory()).toEqual([{ promptId: 'legacy-job' }])
    expect(takeLegacyHistory()).toEqual([])
  })
})

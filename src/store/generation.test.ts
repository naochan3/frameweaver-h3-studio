import { describe, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => {
  const storage = new Map<string, string>([
    ['frameweaver-history', JSON.stringify([{ promptId: 'legacy-job' }])],
    ['frameweaver-owner-id', '11111111-1111-4111-8111-111111111111'],
  ])
  const fetch = vi.fn(async () => new Response(JSON.stringify({ jobs: [{
    id: '22222222-2222-4222-8222-222222222222', owner_id: '11111111-1111-4111-8111-111111111111',
    kind: 'image', mode: 'zimage', status: 'succeeded', prompt: 'a lighthouse',
    settings_json: '{"width":864,"height":1536,"steps":8,"seed":42}',
    output_json: '[{"filename":"result.png","subfolder":"images","type":"output"}]', error: null,
    created_at: '2026-08-22T00:00:00Z', updated_at: '2026-08-22T00:00:01Z',
    started_at: '2026-08-22T00:00:00Z', finished_at: '2026-08-22T00:00:01Z',
  }] })))
  class WebSocket {
    static OPEN = 1
    readyState = 1
    binaryType = ''
    onmessage: ((message: MessageEvent) => void) | null = null
    onclose: (() => void) | null = null
    onopen: (() => void) | null = null
  }
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('WebSocket', WebSocket)
  vi.stubGlobal('fetch', fetch)
  return { fetch }
})

import { historyFromJob, useGenerationStore } from './generation'

const completedJob = {
  id: '22222222-2222-4222-8222-222222222222',
  owner_id: '11111111-1111-4111-8111-111111111111',
  kind: 'image' as const,
  mode: 'zimage',
  status: 'succeeded' as const,
  prompt: 'a lighthouse',
  settings_json: '{"width":864,"height":1536,"steps":8,"seed":42}',
  output_json: '[{"filename":"result.png","subfolder":"images","type":"output"}]',
  error: null,
  created_at: '2026-08-22T00:00:00Z',
  updated_at: '2026-08-22T00:00:01Z',
  started_at: '2026-08-22T00:00:00Z',
  finished_at: '2026-08-22T00:00:01Z',
}

describe('generation store API history integration', () => {
  it('replaces the one-time legacy fallback with API jobs and restores Comfy output URLs', async () => {
    await vi.waitFor(() => {
      expect(useGenerationStore.getState().history).toEqual([expect.objectContaining({
        promptId: completedJob.id,
        filename: 'result.png',
        videoUrl: 'http://127.0.0.1:8188/comfy/view?filename=result.png&subfolder=images&type=output',
      })])
    })
    expect(historyFromJob(completedJob)).toEqual(expect.objectContaining({ filename: 'result.png' }))
  })

  it('keeps the active job and reports cancellation failures', async () => {
    useGenerationStore.setState({ currentPromptId: completedJob.id, status: 'running', error: null })
    environment.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'job cannot be cancelled' }), { status: 409 }))

    await expect(useGenerationStore.getState().stop()).resolves.toBeUndefined()
    expect(useGenerationStore.getState()).toMatchObject({ currentPromptId: completedJob.id, status: 'running', error: 'job cannot be cancelled' })
  })

  it('keeps the active job when cancellation is still pending', async () => {
    useGenerationStore.setState({ currentPromptId: completedJob.id, status: 'running', error: null })
    environment.fetch.mockResolvedValueOnce(Response.json({ ...completedJob, status: 'cancel_requested' }))

    await useGenerationStore.getState().stop()

    expect(useGenerationStore.getState()).toMatchObject({ currentPromptId: completedJob.id, status: 'running' })
  })
})

describe('非同期プロンプト強化の競合防止', () => {
  it('強化中に動画条件を編集した場合は古い応答で上書きしない', async () => {
    let resolveFetch!: (value: unknown) => void
    vi.stubGlobal('fetch', () => new Promise((resolve) => { resolveFetch = resolve }))
    useGenerationStore.setState((s) => ({ params: { ...s.params, prompt: 'original', mode: 'text', lengthSec: 5 }, rewriting: false }))

    const pending = useGenerationStore.getState().rewritePrompt()
    useGenerationStore.getState().setParams({ prompt: 'edited while waiting' })
    resolveFetch({ ok: true, json: async () => ({ response: 'integrated_multimodal_description: At 00:00.000 subject appears.\noverall_soundscape: quiet room tone.\nnon_diegetic_music: none.' }) })
    await pending

    expect(useGenerationStore.getState().params.prompt).toBe('edited while waiting')
    expect(useGenerationStore.getState().rewriteUndo).toBeNull()
    expect(useGenerationStore.getState().rewriting).toBe(false)
  })
})

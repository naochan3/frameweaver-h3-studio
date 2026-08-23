import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  imageRewriterInstalled,
  rewriteImageViaOllama,
  rewriteViaOllama,
  validateImageRewrite,
  validateVideoRewrite,
} from './rewriter'

afterEach(() => vi.unstubAllGlobals())

const video = `integrated_multimodal_description: [Shot 1] A quiet studio. [Shot 2] At 00:03.500, the camera moves closer.
overall_soundscape: Quiet room tone.
non_diegetic_music: N/A`

describe('rewriter output contracts', () => {
  it('accepts the three ordered H3 fields with timestamps inside the requested duration', () => {
    expect(validateVideoRewrite(video, 5)).toBe(video)
  })

  it('rejects missing H3 fields', () => {
    expect(() => validateVideoRewrite('integrated_multimodal_description: [Shot 1] only', 5)).toThrow(
      '出力形式',
    )
  })

  it('rejects H3 shot timestamps outside the requested duration', () => {
    expect(() => validateVideoRewrite(video.replace('00:03.500', '00:05.001'), 5)).toThrow('動画尺')
  })

  it('preserves requested Japanese visible text while requiring English prose', () => {
    const words = Array.from({ length: 60 }, (_, index) => `detail${index}`).join(' ')
    const output = `A storefront sign reads "営業中" clearly. ${words}`
    expect(validateImageRewrite(output, '看板に「営業中」と表示', 'krea2')).toBe(output)
  })

  it('rejects unquoted CJK leakage in image prose', () => {
    const output = `A portrait with 美しい lighting. ${Array.from({ length: 60 }, () => 'detail').join(' ')}`
    expect(() => validateImageRewrite(output, 'portrait', 'krea2')).toThrow('英語以外')
  })

  it('rejects image prompts below the model-specific minimum word count', () => {
    expect(() => validateImageRewrite('A short studio portrait.', 'portrait', 'zimage')).toThrow('語数')
  })

  it('checks image rewriter availability for the selected model only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ models: ['fw-rewriter-krea2'] })))
    await expect(imageRewriterInstalled('krea2')).resolves.toBe(true)
    await expect(imageRewriterInstalled('zimage')).resolves.toBe(false)
  })

  it('uses the bounded gateway and sends an abort signal', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => Response.json({ response: video }))
    vi.stubGlobal('fetch', fetchMock)
    await rewriteViaOllama('quiet studio', 'text', 5)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/rewriter/generate')
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not strip an exact Japanese sign requested by the user', async () => {
    const words = Array.from({ length: 60 }, (_, index) => `detail${index}`).join(' ')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ response: `A sign reads "営業中". ${words}` })))
    await expect(rewriteImageViaOllama('看板に「営業中」と表示', 'krea2')).resolves.toContain('営業中')
  })
})

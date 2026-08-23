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

  it('rejects empty H3 fields even when all labels exist', () => {
    expect(() => validateVideoRewrite('integrated_multimodal_description:\noverall_soundscape:\nnon_diegetic_music:', 5)).toThrow('出力形式')
  })

  it('rejects H3 shot timestamps outside the requested duration', () => {
    expect(() => validateVideoRewrite(video.replace('00:03.500', '00:05.001'), 5)).toThrow('動画尺')
  })

  it('rejects H3 shot timestamps that decrease', () => {
    const out = video.replace('At 00:03.500', 'At 00:04.000 [Shot 3] At 00:02.000')
    expect(() => validateVideoRewrite(out, 5)).toThrow('時刻順')
  })

  it.each([
    ['first', 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'],
    ['first_last', 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 5.00-second mark of the target video.'],
    ['last', 'How the reference pictures align with the target video — <Picture 1> (from [Shot 2]) aligns with the 5.00-second mark of the target video.'],
  ] as const)('accepts the required %s alignment line', (mode, alignment) => {
    expect(validateVideoRewrite(`${alignment}\n\n${video}`, 5, mode)).toContain(alignment)
  })

  it('rejects an alignment reference to a nonexistent final shot', () => {
    const alignment = 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 9) aligns with the 5.00-second mark of the target video.'
    expect(() => validateVideoRewrite(`${alignment}\n\n${video}`, 5, 'first_last')).toThrow('参照画像アラインメント')
  })

  it('preserves requested Japanese visible text while requiring English prose', () => {
    const words = Array.from({ length: 60 }, (_, index) => `detail${index}`).join(' ')
    const output = `A storefront sign reads "営業中" clearly. ${words}`
    expect(validateImageRewrite(output, '看板に「営業中」と表示', 'krea2')).toBe(output)
  })

  it('rejects an image rewrite that omits requested visible text', () => {
    const output = `A storefront sign reads "OPEN" clearly. ${Array.from({ length: 60 }, () => 'detail').join(' ')}`
    expect(() => validateImageRewrite(output, '看板に「営業中」と表示', 'krea2')).toThrow('表示文字')
  })

  it('accepts visible text requested with straight double quotes', () => {
    const output = `A storefront sign reads "営業中" clearly. ${Array.from({ length: 60 }, () => 'detail').join(' ')}`
    expect(validateImageRewrite(output, '看板に"営業中"と表示', 'krea2')).toBe(output)
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

  it('does not silently strip requested visible text in the final CJK fallback', async () => {
    const words = Array.from({ length: 60 }, (_, index) => `detail${index}`).join(' ')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ response: `A sign reads "営業中" with 美しい styling. ${words}` })))
    await expect(rewriteImageViaOllama('看板に「営業中」と表示', 'krea2')).rejects.toThrow('英語以外')
  })
})

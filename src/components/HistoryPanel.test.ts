import { describe, expect, it } from 'vitest'
import { canSendImageToSource } from './history-actions'

const image = {
  promptId: 'job-1', kind: 'image' as const, mode: 'zimage', prompt: 'image', nsfw: false,
  videoUrl: 'http://example.test/comfy/view?filename=image.png', filename: 'image.png', createdAt: '2026-08-22T00:00:00Z',
}

describe('HistoryPanel source action', () => {
  it('shows the video-source action only for an image with a restored output URL', () => {
    expect(canSendImageToSource(image)).toBe(true)
    expect(canSendImageToSource({ ...image, videoUrl: '' })).toBe(false)
    expect(canSendImageToSource({ ...image, kind: 'video' })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  normalizeModelPath,
  rankModels,
  type NodeCapabilitySnapshot,
} from './model-capability'

function imageSnapshot(overrides: Partial<NodeCapabilitySnapshot> = {}): NodeCapabilitySnapshot {
  return {
    capturedAt: '2026-08-24T00:00:00.000Z',
    status: 'ready',
    accelerator: 'cuda',
    devices: [{ name: 'Test GPU', kind: 'cuda', vramTotal: 24 * 1024 ** 3, vramFree: 20 * 1024 ** 3 }],
    queueRemaining: 0,
    inventory: {
      checkpoints: ['models\\WAIILLUSTRIOUSSDXL_V170.SAFETENSORS'],
      unets: ['z_image_turbo_nvfp4.safetensors'],
      clips: ['qwen_3_4b.safetensors'],
      vaes: ['ae_zimage.safetensors'],
      loras: [],
    },
    features: [],
    errors: [],
    ...overrides,
  }
}

describe('normalizeModelPath', () => {
  it('Windows区切りと大文字小文字の差を同一モデルとして扱う', () => {
    expect(normalizeModelPath('Models\\Z_IMAGE_TURBO_NVFP4.SAFETENSORS')).toBe(
      'models/z_image_turbo_nvfp4.safetensors',
    )
  })
})

describe('rankModels', () => {
  it('導入済みで推奨VRAMを満たす画像モデルを安定した順序で返す', () => {
    const fits = rankModels(imageSnapshot(), 'image')

    expect(fits.map((fit) => [fit.model.id, fit.status])).toEqual([
      ['zimage', 'recommended'],
      ['anime', 'recommended'],
      ['krea2', 'unavailable'],
    ])
    expect(fits[0].reasons).toEqual(['installed', 'recommended-memory'])
    expect(fits[2].reasons).toContain('missing-model-files')
  })

  it('総VRAMは足りても空きVRAMが最小値未満なら注意にする', () => {
    const snapshot = imageSnapshot({
      devices: [{ name: 'Busy GPU', kind: 'cuda', vramTotal: 16 * 1024 ** 3, vramFree: 4 * 1024 ** 3 }],
    })

    const zimage = rankModels(snapshot, 'image').find((fit) => fit.model.id === 'zimage')

    expect(zimage?.status).toBe('warning')
    expect(zimage?.reasons).toContain('low-free-vram')
  })

  it('最小VRAM未満はモデルが導入済みでも利用不可にする', () => {
    const snapshot = imageSnapshot({
      devices: [{ name: 'Small GPU', kind: 'cuda', vramTotal: 6 * 1024 ** 3, vramFree: 6 * 1024 ** 3 }],
    })

    const zimage = rankModels(snapshot, 'image').find((fit) => fit.model.id === 'zimage')

    expect(zimage?.status).toBe('unavailable')
    expect(zimage?.reasons).toContain('insufficient-vram')
  })

  it('古い能力値を推奨根拠にせず注意として返す', () => {
    const snapshot = imageSnapshot({ status: 'stale' })

    const zimage = rankModels(snapshot, 'image').find((fit) => fit.model.id === 'zimage')

    expect(zimage?.status).toBe('warning')
    expect(zimage?.reasons).toContain('stale-capability')
  })

  it('必須ファイルの一部だけでは導入済みと判定しない', () => {
    const snapshot = imageSnapshot({
      inventory: {
        checkpoints: [],
        unets: ['z_image_turbo_nvfp4.safetensors'],
        clips: [],
        vaes: ['ae_zimage.safetensors'],
        loras: [],
      },
    })

    const zimage = rankModels(snapshot, 'image').find((fit) => fit.model.id === 'zimage')

    expect(zimage?.status).toBe('unavailable')
    expect(zimage?.missingFiles).toEqual(['qwen_3_4b.safetensors'])
  })
})

import { describe, expect, it } from 'vitest'
import { modelFitLabel, modelFitSummary } from './model-fit-presentation'
import type { ModelFit } from '../lib/model-capability'

function fit(overrides: Partial<ModelFit>): ModelFit {
  return {
    model: {
      id: 'zimage',
      label: 'Z-Image Turbo',
      task: 'image',
      accelerators: ['cuda'],
      minVramBytes: 8,
      recommendedVramBytes: 12,
      requiredFiles: {},
    },
    status: 'recommended',
    reasons: ['installed', 'recommended-memory'],
    missingFiles: [],
    ...overrides,
  }
}

describe('ModelFitBadge presentation', () => {
  it('推奨モデルを短い日本語で説明する', () => {
    const value = fit({})

    expect(modelFitLabel(value)).toBe('推奨')
    expect(modelFitSummary(value)).toBe('導入済み・推奨VRAM')
  })

  it('空きVRAM不足をモデル未導入と混同しない', () => {
    const value = fit({ status: 'warning', reasons: ['installed', 'low-free-vram'] })

    expect(modelFitLabel(value)).toBe('注意')
    expect(modelFitSummary(value)).toBe('空きVRAM不足')
  })

  it('不足ファイル名を利用不可理由へ含める', () => {
    const value = fit({
      status: 'unavailable',
      reasons: ['missing-model-files'],
      missingFiles: ['qwen_3_4b.safetensors'],
    })

    expect(modelFitLabel(value)).toBe('未導入')
    expect(modelFitSummary(value)).toBe('不足: qwen_3_4b.safetensors')
  })
})

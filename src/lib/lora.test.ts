import { describe, expect, it } from 'vitest'
import { classifyLora, selectableLoras } from './lora'

describe('classifyLora', () => {
  it('導入済みLoRAをカタログで正しい対象モデルに分類する', () => {
    expect(classifyLora('hinano_v2_lora.safetensors').target).toBe('zimage')
    expect(classifyLora('Amateur_Photography_ZIT.safetensors').target).toBe('zimage')
    expect(classifyLora('K2R_KTMix_KR_v01.safetensors').target).toBe('krea2')
    expect(classifyLora('K2R_yayoi_S1_1k.safetensors').target).toBe('krea2')
  })

  it('fal Realism People は動画(H3)用として分類される', () => {
    const info = classifyLora('h3-realism-people-t2v-i2v-r2v.safetensors')
    expect(info.target).toBe('video')
    expect(info.note).toContain('r34l1sm')
  })

  it('H3のTurbo系はシステムLoRA(手動選択の対象外)', () => {
    expect(classifyLora('minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors').target).toBe('system')
    expect(classifyLora('minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors').target).toBe('system')
    expect(classifyLora('minimax_h3_turbo_v4_step600_ema.safetensors').target).toBe('system')
  })

  it('未対応モデル(Wan等)のLoRAは unsupported', () => {
    expect(classifyLora('wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors').target).toBe('unsupported')
    expect(classifyLora('LOW\\wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors').target).toBe('unsupported')
  })

  it('プレフィックス・命名規則からの推定(カタログ外)', () => {
    expect(classifyLora('K2R_newchar_v1.safetensors').target).toBe('krea2')
    expect(classifyLora('cool_style_ZIT.safetensors').target).toBe('zimage')
    expect(classifyLora('minimax_h3_mychar_lora.safetensors').target).toBe('video')
  })

  it('判別できないものは unknown', () => {
    expect(classifyLora('mystery_lora.safetensors').target).toBe('unknown')
  })

  it('note に用途説明が入る', () => {
    expect(classifyLora('hinano_v2_lora.safetensors').note).toContain('Z-Image')
    expect(classifyLora('K2R_KTMix_KR_v01.safetensors').note).toContain('Krea 2')
  })
})

describe('selectableLoras', () => {
  const list = [
    'hinano_v2_lora.safetensors',
    'K2R_KTMix_KR_v01.safetensors',
    'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
    'wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors',
    'mystery_lora.safetensors',
  ]

  it('zimage には Z-Image 用と unknown だけを返す', () => {
    const r = selectableLoras(list, 'zimage')
    expect(r.compatible).toEqual(['hinano_v2_lora.safetensors'])
    expect(r.unknown).toEqual(['mystery_lora.safetensors'])
  })

  it('krea2 には Krea 2 用と unknown だけを返す', () => {
    const r = selectableLoras(list, 'krea2')
    expect(r.compatible).toEqual(['K2R_KTMix_KR_v01.safetensors'])
    expect(r.unknown).toEqual(['mystery_lora.safetensors'])
  })

  it('video には H3 用と unknown だけを返す(システム・未対応は出さない)', () => {
    const r = selectableLoras([...list, 'minimax_h3_mychar_lora.safetensors'], 'video')
    expect(r.compatible).toEqual(['minimax_h3_mychar_lora.safetensors'])
    expect(r.unknown).toEqual(['mystery_lora.safetensors'])
  })
})

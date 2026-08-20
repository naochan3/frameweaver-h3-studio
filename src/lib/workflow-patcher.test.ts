import { describe, expect, it } from 'vitest'
import { frameCount, patchWorkflow } from './workflow-patcher'
import { MODEL_FILES, type GenerationParams } from './types'

const base: GenerationParams = {
  mode: 'text',
  prompt: 'テストプロンプト',
  nsfw: false,
  images: [],
  turbo: true,
  steps: 8,
  width: 864,
  height: 480,
  lengthSec: 5,
  seed: 42,
  extraLora: '',
  extraLoraStrength: 1.0,
}

describe('frameCount', () => {
  it('秒数を 17k+5 グリッドのフレーム数へ切り上げる', () => {
    expect(frameCount(5)).toBe(124) // 120 -> 124 (17*7+5)
    expect(frameCount(0.1)).toBe(5) // 最小5フレーム
    expect(frameCount(3)).toBe(73) // 72 -> 73 (17*4+5)
  })
})

describe('patchWorkflow: FL2VA系モード', () => {
  it('text モードは first/last 画像なしで FL2VA を使う', () => {
    const wf = patchWorkflow(base)
    const cond = wf['cond']
    expect(cond.class_type).toBe('MiniMaxH3ImageToVideo')
    expect(cond.inputs['first_frame']).toBeUndefined()
    expect(cond.inputs['last_frame']).toBeUndefined()
    expect(wf['unet'].inputs['unet_name']).toBe(MODEL_FILES.unetFl2va)
    expect(cond.inputs['prompt']).toBe('テストプロンプト')
    expect(cond.inputs['length']).toBe(124)
  })

  it('first モードは first_frame のみ接続する', () => {
    const wf = patchWorkflow({ ...base, mode: 'first', images: ['a.png'] })
    expect(wf['cond'].inputs['first_frame']).toEqual(['img_first', 0])
    expect(wf['cond'].inputs['last_frame']).toBeUndefined()
    expect(wf['img_first'].inputs['image']).toBe('a.png')
  })

  it('first_last モードは両方接続する', () => {
    const wf = patchWorkflow({ ...base, mode: 'first_last', images: ['a.png', 'b.png'] })
    expect(wf['cond'].inputs['first_frame']).toEqual(['img_first', 0])
    expect(wf['cond'].inputs['last_frame']).toEqual(['img_last', 0])
    expect(wf['img_last'].inputs['image']).toBe('b.png')
  })

  it('last モードは last_frame のみ接続する', () => {
    const wf = patchWorkflow({ ...base, mode: 'last', images: ['b.png'] })
    expect(wf['cond'].inputs['first_frame']).toBeUndefined()
    expect(wf['cond'].inputs['last_frame']).toEqual(['img_last', 0])
    expect(wf['img_last'].inputs['image']).toBe('b.png')
  })
})

describe('patchWorkflow: reference モード', () => {
  it('Ref2VA チェックポイントと ref_image_N 入力を使う', () => {
    const wf = patchWorkflow({ ...base, mode: 'reference', images: ['r1.png', 'r2.png'] })
    const cond = wf['cond']
    expect(cond.class_type).toBe('MiniMaxH3ReferenceToVideo')
    expect(wf['unet'].inputs['unet_name']).toBe(MODEL_FILES.unetRef2va)
    expect(cond.inputs['ref_images.ref_image_0']).toEqual(['img_ref_0', 0])
    expect(cond.inputs['ref_images.ref_image_1']).toEqual(['img_ref_1', 0])
    expect(wf['img_ref_0'].inputs['image']).toBe('r1.png')
    expect(wf['img_ref_1'].inputs['image']).toBe('r2.png')
  })

  it('reference の Turbo は ref2v 用 LoRA を使う', () => {
    const wf = patchWorkflow({ ...base, mode: 'reference', images: ['r1.png'], turbo: true })
    expect(wf['lora'].inputs['lora_name']).toBe(MODEL_FILES.loraTurboRef2v)
  })
})

describe('patchWorkflow: NSFW / Turbo / seed', () => {
  it('NSFW ON でエンコーダを Heretic に差し替える', () => {
    expect(patchWorkflow({ ...base, nsfw: true })['clip'].inputs['clip_name']).toBe(MODEL_FILES.clipNsfw)
    expect(patchWorkflow({ ...base, nsfw: false })['clip'].inputs['clip_name']).toBe(MODEL_FILES.clipNormal)
  })

  it('Turbo OFF は LoRA なし・res_multistep/simple・20 steps', () => {
    const wf = patchWorkflow({ ...base, turbo: false, steps: 20 })
    expect(wf['lora']).toBeUndefined()
    expect(wf['sigma_shift'].inputs['model']).toEqual(['unet', 0])
    expect(wf['sched'].inputs['model']).toEqual(['sigma_shift', 0])
    expect(wf['guider'].inputs['model']).toEqual(['sigma_shift', 0])
    expect(wf['sched'].inputs['steps']).toBe(20)
    expect(wf['sampler_sel'].inputs['sampler_name']).toBe('res_multistep')
    expect(wf['sched'].inputs['scheduler']).toBe('simple')
  })

  it('Turbo ON は LoRA 経由 + euler/beta に連動切替する', () => {
    const wf = patchWorkflow(base)
    expect(wf['lora'].inputs['model']).toEqual(['unet', 0])
    expect(wf['sigma_shift'].inputs['model']).toEqual(['lora', 0])
    expect(wf['sched'].inputs['model']).toEqual(['sigma_shift', 0])
    expect(wf['sched'].inputs['steps']).toBe(8)
    expect(wf['sampler_sel'].inputs['sampler_name']).toBe('euler')
    expect(wf['sched'].inputs['scheduler']).toBe('beta')
    expect(wf['sigma_shift'].inputs['shift_video']).toBe(12.0)
    expect(wf['sigma_shift'].inputs['shift_audio']).toBe(3.0)
  })

  it('追加LoRAはTurbo LoRAの後に直列で挟まる', () => {
    const wf = patchWorkflow({ ...base, extraLora: 'minimax-h3/mychar.safetensors', extraLoraStrength: 0.8 })
    expect(wf['lora_extra'].inputs['lora_name']).toBe('minimax-h3/mychar.safetensors')
    expect(wf['lora_extra'].inputs['strength_model']).toBe(0.8)
    expect(wf['lora_extra'].inputs['model']).toEqual(['lora', 0])
    expect(wf['sigma_shift'].inputs['model']).toEqual(['lora_extra', 0])
  })

  it('Turbo OFF + 追加LoRA は UNET 直後に挟まる', () => {
    const wf = patchWorkflow({ ...base, turbo: false, steps: 20, extraLora: 'minimax-h3/mychar.safetensors' })
    expect(wf['lora']).toBeUndefined()
    expect(wf['lora_extra'].inputs['model']).toEqual(['unet', 0])
    expect(wf['sigma_shift'].inputs['model']).toEqual(['lora_extra', 0])
  })

  it('追加LoRAが空文字ならノードを作らない', () => {
    expect(patchWorkflow(base)['lora_extra']).toBeUndefined()
  })

  it('seed=-1 はランダム値を採番し、それ以外は固定値を使う', () => {
    expect(patchWorkflow(base)['noise'].inputs['noise_seed']).toBe(42)
    const s = patchWorkflow({ ...base, seed: -1 })['noise'].inputs['noise_seed']
    expect(typeof s).toBe('number')
    expect(s).toBeGreaterThanOrEqual(0)
  })
})

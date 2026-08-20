import { describe, expect, it } from 'vitest'
import { buildImageWorkflow } from './image-workflow'
import { MODEL_FILES, type ImageParams } from './types'

const base: ImageParams = {
  model: 'zimage',
  prompt: 'テスト',
  width: 864,
  height: 1536,
  steps: 8,
  seed: 42,
  extraLora: '',
  extraLoraStrength: 1.0,
}

describe('buildImageWorkflow: Z-Image Turbo', () => {
  it('公式テンプレ準拠の構成(lumina2 / AuraFlow shift=3 / res_multistep / cfg=1)', () => {
    const wf = buildImageWorkflow(base)
    expect(wf['unet'].inputs['unet_name']).toBe(MODEL_FILES.zimageUnet)
    expect(wf['unet'].inputs['weight_dtype']).toBe('default')
    expect(wf['clip'].inputs['clip_name']).toBe(MODEL_FILES.zimageClip)
    expect(wf['clip'].inputs['type']).toBe('lumina2')
    expect(wf['vae'].inputs['vae_name']).toBe(MODEL_FILES.zimageVae)
    expect(wf['shift'].class_type).toBe('ModelSamplingAuraFlow')
    expect(wf['shift'].inputs['shift']).toBe(3.0)
    expect(wf['sampler'].class_type).toBe('KSampler')
    expect(wf['sampler'].inputs['sampler_name']).toBe('res_multistep')
    expect(wf['sampler'].inputs['scheduler']).toBe('simple')
    expect(wf['sampler'].inputs['cfg']).toBe(1.0)
    expect(wf['sampler'].inputs['steps']).toBe(8)
    expect(wf['sampler'].inputs['seed']).toBe(42)
    expect(wf['negative'].class_type).toBe('ConditioningZeroOut')
    expect(wf['latent'].class_type).toBe('EmptySD3LatentImage')
    expect(wf['latent'].inputs['width']).toBe(864)
    expect(wf['latent'].inputs['height']).toBe(1536)
    expect(wf['latent'].inputs['batch_size']).toBe(1)
    expect(wf['save'].class_type).toBe('SaveImage')
    expect(wf['save'].inputs['filename_prefix']).toBe('zimage/FrameWeaver')
  })

  it('プロンプトが positive に入り、negative は ZeroOut 経由', () => {
    const wf = buildImageWorkflow({ ...base, prompt: '猫' })
    expect(wf['positive'].inputs['text']).toBe('猫')
    expect(wf['negative'].inputs['conditioning']).toEqual(['positive', 0])
    expect(wf['sampler'].inputs['negative']).toEqual(['negative', 0])
  })

  it('seed=-1 はランダム採番', () => {
    const s = buildImageWorkflow({ ...base, seed: -1 })['sampler'].inputs['seed']
    expect(typeof s).toBe('number')
    expect(s).toBeGreaterThanOrEqual(0)
  })

  it('追加LoRAが空ならLoRAノードを作らない', () => {
    expect(buildImageWorkflow(base)['lora_extra']).toBeUndefined()
  })

  it('Z-Image + 追加LoRA: UNET→LoRA→AuraFlow→sampler の順で挟まる', () => {
    const wf = buildImageWorkflow({ ...base, extraLora: 'hinano_v1.safetensors', extraLoraStrength: 0.9 })
    expect(wf['lora_extra'].class_type).toBe('LoraLoaderModelOnly')
    expect(wf['lora_extra'].inputs['lora_name']).toBe('hinano_v1.safetensors')
    expect(wf['lora_extra'].inputs['strength_model']).toBe(0.9)
    expect(wf['lora_extra'].inputs['model']).toEqual(['unet', 0])
    expect(wf['shift'].inputs['model']).toEqual(['lora_extra', 0])
    expect(wf['sampler'].inputs['model']).toEqual(['shift', 0])
  })

  it('Krea 2 + 追加LoRA: AuraFlowなしで UNET→LoRA→sampler', () => {
    const wf = buildImageWorkflow({ ...base, model: 'krea2', extraLora: 'mystyle.safetensors' })
    expect(wf['shift']).toBeUndefined()
    expect(wf['lora_extra'].inputs['model']).toEqual(['unet', 0])
    expect(wf['sampler'].inputs['model']).toEqual(['lora_extra', 0])
  })
})

describe('buildImageWorkflow: Krea 2 Turbo', () => {
  it('Krea 2 は公式テンプレ準拠(type=krea2 / EmptyLatentImage / euler / AuraFlowなし)', () => {
    const wf = buildImageWorkflow({ ...base, model: 'krea2' })
    expect(wf['unet'].inputs['unet_name']).toBe(MODEL_FILES.krea2Unet)
    expect(wf['clip'].inputs['clip_name']).toBe(MODEL_FILES.krea2Clip)
    expect(wf['clip'].inputs['type']).toBe('krea2')
    expect(wf['vae'].inputs['vae_name']).toBe(MODEL_FILES.krea2Vae)
    expect(wf['latent'].class_type).toBe('EmptyLatentImage')
    expect(wf['shift']).toBeUndefined()
    expect(wf['sampler'].inputs['sampler_name']).toBe('euler')
    expect(wf['sampler'].inputs['cfg']).toBe(1.0)
    expect(wf['sampler'].inputs['model']).toEqual(['unet', 0])
    expect(wf['save'].inputs['filename_prefix']).toBe('krea2/FrameWeaver')
  })
})

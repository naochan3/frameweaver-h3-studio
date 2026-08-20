import { MODEL_FILES, type GenerationParams, type WorkflowJson } from './types'

/** 秒数を H3 の 17k+5 フレームグリッド(24fps)へ切り上げる(公式テンプレートの式と同一) */
export function frameCount(lengthSec: number): number {
  let n = Math.max(5, Math.round(lengthSec * 24))
  while (n % 17 !== 5) n += 1
  return n
}

function randomSeed(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
}

/**
 * GenerationParams から ComfyUI APIフォーマットのワークフローを組み立てる。
 * ノード構成は公式テンプレート video_minimax_h3_{t2v,i2v,r2v}.json の配線を再現。
 */
export function patchWorkflow(params: GenerationParams): WorkflowJson {
  const isRef = params.mode === 'reference'
  const seed = params.seed === -1 ? randomSeed() : params.seed
  const useExtraLora = params.extraLora.trim().length > 0
  const afterTurbo: [string, number] = params.turbo ? ['lora', 0] : ['unet', 0]
  const modelSource: [string, number] = useExtraLora ? ['lora_extra', 0] : afterTurbo

  const wf: WorkflowJson = {
    unet: {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: isRef ? MODEL_FILES.unetRef2va : MODEL_FILES.unetFl2va,
        weight_dtype: 'default',
      },
    },
    clip: {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: params.nsfw ? MODEL_FILES.clipNsfw : MODEL_FILES.clipNormal,
        type: 'minimax',
        device: 'default',
      },
    },
    vae_video: {
      class_type: 'VAELoader',
      inputs: { vae_name: MODEL_FILES.vaeVideo },
    },
    vae_audio: {
      class_type: 'VAELoader',
      inputs: { vae_name: MODEL_FILES.vaeAudio },
    },
    noise: {
      class_type: 'RandomNoise',
      inputs: { noise_seed: seed },
    },
    sigma_shift: {
      class_type: 'MiniMaxH3SigmaShift',
      inputs: { model: modelSource, shift_video: 12.0, shift_audio: 3.0 },
    },
    sampler_sel: {
      class_type: 'KSamplerSelect',
      // Turbo(lightx2v系)は euler、通常は公式テンプレの res_multistep(実測記事準拠)
      inputs: { sampler_name: params.turbo ? 'euler' : 'res_multistep' },
    },
    sched: {
      class_type: 'BasicScheduler',
      inputs: {
        model: ['sigma_shift', 0],
        scheduler: params.turbo ? 'beta' : 'simple',
        steps: params.steps,
        denoise: 1.0,
      },
    },
    guider: {
      class_type: 'BasicGuider',
      inputs: { model: ['sigma_shift', 0], conditioning: ['cond', 0] },
    },
    sample: {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['noise', 0],
        guider: ['guider', 0],
        sampler: ['sampler_sel', 0],
        sigmas: ['sched', 0],
        latent_image: ['cond', 1],
      },
    },
    dec_video: {
      class_type: 'VAEDecode',
      inputs: { samples: ['sample', 0], vae: ['vae_video', 0] },
    },
    dec_audio: {
      class_type: 'VAEDecodeAudio',
      inputs: { samples: ['sample', 0], vae: ['vae_audio', 0] },
    },
    video: {
      class_type: 'CreateVideo',
      inputs: { images: ['dec_video', 0], audio: ['dec_audio', 0], fps: 24 },
    },
    save: {
      class_type: 'SaveVideo',
      inputs: { video: ['video', 0], filename_prefix: 'video/FrameWeaver', format: 'auto', codec: 'auto' },
    },
  }

  if (params.turbo) {
    wf['lora'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: ['unet', 0],
        lora_name: isRef ? MODEL_FILES.loraTurboRef2v : MODEL_FILES.loraTurboFl2v,
        strength_model: 1.0,
      },
    }
  }

  if (useExtraLora) {
    wf['lora_extra'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        model: afterTurbo,
        lora_name: params.extraLora.trim(),
        strength_model: params.extraLoraStrength,
      },
    }
  }

  const common = {
    prompt: params.prompt,
    width: params.width,
    height: params.height,
    length: frameCount(params.lengthSec),
  }

  if (isRef) {
    const condInputs: Record<string, unknown> = {
      clip: ['clip', 0],
      vae: ['vae_video', 0],
      audio_vae: ['vae_audio', 0],
      ref_image_size: 'match',
      ...common,
    }
    params.images.slice(0, 9).forEach((name, i) => {
      wf[`img_ref_${i}`] = { class_type: 'LoadImage', inputs: { image: name } }
      condInputs[`ref_images.ref_image_${i}`] = [`img_ref_${i}`, 0]
    })
    wf['cond'] = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: condInputs }
  } else {
    const condInputs: Record<string, unknown> = {
      clip: ['clip', 0],
      vae: ['vae_video', 0],
      ...common,
    }
    const useFirst = params.mode === 'first' || params.mode === 'first_last'
    const useLast = params.mode === 'last' || params.mode === 'first_last'
    if (useFirst) {
      wf['img_first'] = { class_type: 'LoadImage', inputs: { image: params.images[0] } }
      condInputs['first_frame'] = ['img_first', 0]
    }
    if (useLast) {
      // first_last のときは images[1] が last、last 単独のときは images[0]
      const lastImage = params.mode === 'first_last' ? params.images[1] : params.images[0]
      wf['img_last'] = { class_type: 'LoadImage', inputs: { image: lastImage } }
      condInputs['last_frame'] = ['img_last', 0]
    }
    wf['cond'] = { class_type: 'MiniMaxH3ImageToVideo', inputs: condInputs }
  }

  return wf
}

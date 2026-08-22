import { MODEL_FILES, type ImageParams, type WorkflowJson } from './types'

function randomSeed(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
}

interface ImageModelConfig {
  unet: string
  clip: string
  clipType: string
  vae: string
  /** ModelSamplingAuraFlow の shift。null なら AuraFlow ノードを挟まない(Krea2はモデル内蔵shift=1.15) */
  auraFlowShift: number | null
  latentClass: string
  sampler: string
  scheduler: string
  cfg: number
  outputPrefix: string
}

/**
 * モデル別の確定値。
 * zimage: 公式テンプレ(image_z_image_turbo.json)+実生成PNGメタデータで確認済みの構成。
 * krea2: 公式テンプレ(image_krea2_turbo_t2i.json)準拠。shift=1.15はモデル定義内蔵のためノード不要。
 */
const IMAGE_MODEL_CONFIG: Record<'zimage' | 'krea2', ImageModelConfig> = {
  zimage: {
    unet: MODEL_FILES.zimageUnet,
    clip: MODEL_FILES.zimageClip,
    clipType: 'lumina2',
    vae: MODEL_FILES.zimageVae,
    auraFlowShift: 3.0,
    latentClass: 'EmptySD3LatentImage',
    sampler: 'res_multistep',
    scheduler: 'simple',
    cfg: 1.0,
    outputPrefix: 'zimage/FrameWeaver',
  },
  krea2: {
    unet: MODEL_FILES.krea2Unet,
    clip: MODEL_FILES.krea2Clip,
    clipType: 'krea2',
    vae: MODEL_FILES.krea2Vae,
    auraFlowShift: null,
    latentClass: 'EmptyLatentImage',
    sampler: 'euler',
    scheduler: 'simple',
    cfg: 1.0,
    outputPrefix: 'krea2/FrameWeaver',
  },
}

/** チェックポイント名から v-prediction モデルかを推定(NoobAI V-Pred 等) */
function isVpred(ckpt: string): boolean {
  return /v[-_ ]?pred/i.test(ckpt)
}

/**
 * アニメ(Illustrious系SDXL)チェックポイントの txt2img ワークフロー。
 * Turbo系と違い cfg>1 でネガティブが効く。CheckpointLoaderSimple 1ファイルに UNET/CLIP/VAE 同梱。
 * V-Pred版は ModelSamplingDiscrete(v_prediction+zsnr)を挟み、サンプラーを euler にする。
 */
function buildAnimeWorkflow(params: ImageParams): WorkflowJson {
  const seed = params.seed === -1 ? randomSeed() : params.seed
  const ckptName = params.animeCheckpoint || MODEL_FILES.animeCheckpointDefault
  const vpred = isVpred(ckptName)
  const useExtraLora = params.extraLora.trim().length > 0

  const clipSource: [string, number] = useExtraLora ? ['lora_extra', 1] : ['ckpt', 1]
  const modelAfterLora: [string, number] = useExtraLora ? ['lora_extra', 0] : ['ckpt', 0]
  const modelSource: [string, number] = vpred ? ['modelsampling', 0] : modelAfterLora

  const wf: WorkflowJson = {
    ckpt: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: ckptName },
    },
    positive: {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.prompt, clip: clipSource },
    },
    negative: {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.negativePrompt ?? '', clip: clipSource },
    },
    latent: {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: 1 },
    },
    sampler: {
      class_type: 'KSampler',
      inputs: {
        model: modelSource,
        positive: ['positive', 0],
        negative: ['negative', 0],
        latent_image: ['latent', 0],
        seed,
        steps: params.steps,
        cfg: params.cfg ?? 6,
        sampler_name: vpred ? 'euler' : 'euler_ancestral',
        scheduler: 'normal',
        denoise: 1.0,
      },
    },
    decode: {
      class_type: 'VAEDecode',
      inputs: { samples: ['sampler', 0], vae: ['ckpt', 2] },
    },
    save: {
      class_type: 'SaveImage',
      inputs: { images: ['decode', 0], filename_prefix: 'anime/FrameWeaver' },
    },
  }

  if (useExtraLora) {
    // LoRAはUNETとCLIP両方に効かせる(SDXLのキャラLoRAはCLIP側も重要)
    wf['lora_extra'] = {
      class_type: 'LoraLoader',
      inputs: {
        model: ['ckpt', 0],
        clip: ['ckpt', 1],
        lora_name: params.extraLora.trim(),
        strength_model: params.extraLoraStrength,
        strength_clip: params.extraLoraStrength,
      },
    }
  }

  if (vpred) {
    wf['modelsampling'] = {
      class_type: 'ModelSamplingDiscrete',
      inputs: { model: modelAfterLora, sampling: 'v_prediction', zsnr: true },
    }
  }

  return wf
}

/** ImageParams から ComfyUI APIフォーマットの txt2img ワークフローを組み立てる */
export function buildImageWorkflow(params: ImageParams): WorkflowJson {
  if (params.model === 'anime') return buildAnimeWorkflow(params)
  const cfg = IMAGE_MODEL_CONFIG[params.model]
  const seed = params.seed === -1 ? randomSeed() : params.seed
  const useExtraLora = params.extraLora.trim().length > 0
  // モデルチェーン: UNET →(追加LoRA)→(AuraFlow)→ sampler
  const afterLora: [string, number] = useExtraLora ? ['lora_extra', 0] : ['unet', 0]
  const modelSource: [string, number] = cfg.auraFlowShift === null ? afterLora : ['shift', 0]

  const wf: WorkflowJson = {
    unet: {
      class_type: 'UNETLoader',
      inputs: { unet_name: cfg.unet, weight_dtype: 'default' },
    },
    clip: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: cfg.clip, type: cfg.clipType, device: 'default' },
    },
    vae: {
      class_type: 'VAELoader',
      inputs: { vae_name: cfg.vae },
    },
    positive: {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.prompt, clip: ['clip', 0] },
    },
    negative: {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['positive', 0] },
    },
    latent: {
      class_type: cfg.latentClass,
      inputs: { width: params.width, height: params.height, batch_size: 1 },
    },
    sampler: {
      class_type: 'KSampler',
      inputs: {
        model: modelSource,
        positive: ['positive', 0],
        negative: ['negative', 0],
        latent_image: ['latent', 0],
        seed,
        steps: params.steps,
        cfg: cfg.cfg,
        sampler_name: cfg.sampler,
        scheduler: cfg.scheduler,
        denoise: 1.0,
      },
    },
    decode: {
      class_type: 'VAEDecode',
      inputs: { samples: ['sampler', 0], vae: ['vae', 0] },
    },
    save: {
      class_type: 'SaveImage',
      inputs: { images: ['decode', 0], filename_prefix: cfg.outputPrefix },
    },
  }

  if (useExtraLora) {
    wf['lora_extra'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['unet', 0], lora_name: params.extraLora.trim(), strength_model: params.extraLoraStrength },
    }
  }

  if (cfg.auraFlowShift !== null) {
    wf['shift'] = {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: afterLora, shift: cfg.auraFlowShift },
    }
  }

  return wf
}

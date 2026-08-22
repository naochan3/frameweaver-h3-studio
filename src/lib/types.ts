/** 生成モード。FL2VAチェックポイントが text/first/first_last/last を兼ね、reference のみ Ref2VA を使う */
export type GenerationMode = 'text' | 'first' | 'first_last' | 'last' | 'reference'

export interface GenerationParams {
  mode: GenerationMode
  prompt: string
  nsfw: boolean
  /** ComfyUI にアップロード済みの画像ファイル名。first系は [first?, last?]、reference は最大9枚 */
  images: string[]
  /** Turbo LoRA を使うか(ON時 4〜8 steps) */
  turbo: boolean
  steps: number
  width: number
  height: number
  /** 秒数(内部で 17k+5 フレームグリッドに切り上げ) */
  lengthSec: number
  /** -1 でランダム */
  seed: number
  /** 追加LoRA(自作キャラLoRA等)。loras フォルダからの相対パス。空文字で未使用 */
  extraLora: string
  extraLoraStrength: number
}

/** Civitai由来のLoRA説明(frameweaver_lora_meta.json)。キーは "baseSlug/filename.safetensors" */
export interface LoraMetaEntry {
  name: string
  base: string
  genre: string
  triggers: string[]
  nsfw: boolean
  url: string
  desc: string
}
export type LoraMetaMap = Record<string, LoraMetaEntry>

/** ComfyUI APIフォーマットのノード */
export interface ApiNode {
  class_type: string
  inputs: Record<string, unknown>
}

export type WorkflowJson = Record<string, ApiNode>

/** 画像生成モデル。zimage/krea2=Turbo実写系(cfg=1固定・ネガティブ無効) /
 * anime=Illustrious系SDXLチェックポイント(cfg・ネガティブ有効、キャラ名で生成) */
export type ImageModel = 'zimage' | 'krea2' | 'anime'

export interface ImageParams {
  model: ImageModel
  prompt: string
  width: number
  height: number
  steps: number
  /** -1 でランダム */
  seed: number
  /** 追加LoRA(キャラ/画風LoRA。loras フォルダからの相対パス)。空文字で未使用 */
  extraLora: string
  extraLoraStrength: number
  // ↓ anime(SDXL系)専用。zimage/krea2 では未使用(cfgは内部で1.0固定)
  /** ネガティブプロンプト(SDXL系のみ有効) */
  negativePrompt?: string
  /** CFGスケール(SDXL系のみ。zimage/krea2は常に1.0) */
  cfg?: number
  /** アニメ用チェックポイントのファイル名(checkpoints フォルダ) */
  animeCheckpoint?: string
}

export const MODEL_FILES = {
  unetFl2va: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  unetRef2va: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
  clipNormal: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  clipNsfw: 'qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors',
  vaeVideo: 'minimax_h3_video_vae_fp16.safetensors',
  vaeAudio: 'minimax_h3_audio_vae_fp32.safetensors',
  // lightx2v 4step 768p: 実測レポート(2026-08-14)でT2V/高解像度/Ref2VA全てで最良。8stepはノイズ化のため不採用
  loraTurboFl2v: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
  loraTurboRef2v: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
  // 画像生成: Z-Image Turbo(導入済みnvfp4構成を再利用)
  zimageUnet: 'z_image_turbo_nvfp4.safetensors',
  zimageClip: 'qwen_3_4b.safetensors',
  zimageVae: 'ae_zimage.safetensors',
  // 画像生成: Krea 2 Turbo(公式fp8。リポ確認後にDL)
  krea2Unet: 'krea2_turbo_fp8_scaled.safetensors',
  krea2Clip: 'qwen3vl_4b_fp8_scaled.safetensors',
  krea2Vae: 'qwen_image_vae.safetensors',
  // 画像生成: アニメ(Illustrious系SDXLチェックポイント)。既定はWAI(設定不要で即動く)
  animeCheckpointDefault: 'waiIllustriousSDXL_v170.safetensors',
} as const

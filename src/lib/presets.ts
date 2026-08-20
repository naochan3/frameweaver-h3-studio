import { computeResolution } from './resolution'
import type { GenerationParams, ImageModel, ImageParams } from './types'

/** 動画(MiniMax H3)の推奨初期設定。
 * 根拠: Turbo LoRA選定レポート(lightx2v 4step=最良、steps=forwards+1=5)+
 * 実測記事(0.5MPが12GBの標準、9:16はTikTok/縦動画向け)。 */
export const VIDEO_RECOMMENDED = {
  aspect: '9:16' as const,
  mp: 0.5,
  turbo: true,
  steps: 5,
  lengthSec: 5,
}

/** 画像モデルごとの推奨初期設定。
 * zimage: 公式テンプレ 8steps。高速なので9:16 1.3MPでも約12秒。
 * krea2: 公式README steps 8。実写向け、1.3MPで約21秒。 */
export const IMAGE_RECOMMENDED: Record<ImageModel, { aspect: '9:16'; mp: number; steps: number }> = {
  zimage: { aspect: '9:16', mp: 1.3, steps: 8 },
  krea2: { aspect: '9:16', mp: 1.3, steps: 8 },
}

/** 動画パラメータの推奨値を返す(モードは維持) */
export function videoRecommendedParams(): Pick<GenerationParams, 'turbo' | 'steps' | 'lengthSec' | 'width' | 'height'> {
  const { width, height } = computeResolution(VIDEO_RECOMMENDED.aspect, VIDEO_RECOMMENDED.mp)
  return {
    turbo: VIDEO_RECOMMENDED.turbo,
    steps: VIDEO_RECOMMENDED.steps,
    lengthSec: VIDEO_RECOMMENDED.lengthSec,
    width,
    height,
  }
}

/** 指定モデルの画像推奨値を返す */
export function imageRecommendedParams(model: ImageModel): Pick<ImageParams, 'model' | 'steps' | 'width' | 'height'> {
  const r = IMAGE_RECOMMENDED[model]
  const { width, height } = computeResolution(r.aspect, r.mp)
  return { model, steps: r.steps, width, height }
}

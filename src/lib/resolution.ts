/** アスペクト比(例 '9:16')と目標メガピクセル数から、32の倍数に丸めた解像度を計算する。
 * H3/Z-Image/Krea 2 いずれも縦横32px単位を要求するため共通で使う。 */
export function computeResolution(aspect: string, megapixels: number): { width: number; height: number } {
  const [rw, rh] = aspect.split(':').map(Number)
  const px = megapixels * 1_000_000
  const w = Math.max(32, Math.round(Math.sqrt((px * rw) / rh) / 32) * 32)
  const h = Math.max(32, Math.round(Math.sqrt((px * rh) / rw) / 32) * 32)
  return { width: w, height: h }
}

export const ASPECT_OPTIONS = ['9:16', '3:4', '1:1', '4:3', '16:9'] as const
export type AspectRatio = (typeof ASPECT_OPTIONS)[number]

export const VIDEO_MP_OPTIONS: { label: string; mp: number }[] = [
  { label: '0.4MP — 最速(約2分)', mp: 0.4 },
  { label: '0.5MP — 標準', mp: 0.5 },
  { label: '0.6MP', mp: 0.6 },
  { label: '1.0MP — 高品質/低速', mp: 1.0 },
  { label: '1.3MP — 12GB上限', mp: 1.3 },
]

export const IMAGE_MP_OPTIONS: { label: string; mp: number }[] = [
  { label: '0.6MP — 高速', mp: 0.6 },
  { label: '1.0MP — 標準', mp: 1.0 },
  { label: '1.3MP — 高品質', mp: 1.3 },
  { label: '2.0MP — 最高解像度', mp: 2.0 },
]

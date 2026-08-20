/** 進捗イベントのタイムスタンプ列から残り時間(秒)を推定する。
 * 直近最大5ステップの平均所要時間 × 残ステップ数。初回ステップはモデル読込を含み長いため、
 * サンプルが増えるほど直近の実測に寄る。推定不能(サンプル不足)なら null。 */
export function estimateRemainingSec(
  stepTimestamps: number[],
  value: number,
  max: number,
  now: number,
): number | null {
  if (stepTimestamps.length < 2 || value <= 0 || max <= 0 || value >= max) return null
  const recent = stepTimestamps.slice(-6)
  const deltas: number[] = []
  for (let i = 1; i < recent.length; i++) deltas.push(recent[i] - recent[i - 1])
  const avgMs = deltas.reduce((a, b) => a + b, 0) / deltas.length
  if (avgMs <= 0) return null
  const sinceLast = now - stepTimestamps[stepTimestamps.length - 1]
  const remainingMs = avgMs * (max - value) - sinceLast
  return Math.max(0, Math.round(remainingMs / 1000))
}

/** 秒を「3分12秒」「45秒」形式へ */
export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}分${s}秒` : `${s}秒`
}

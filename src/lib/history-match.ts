/** ファイル名と作成時刻を持つ履歴エントリ(HistoryItem のサブセット) */
export interface HistoryLike {
  filename: string
  createdAt: string
}

/** ファイル名一致だけだと連番の再利用(セッションまたぎ)で別ジョブのプロンプトが付くため、
 * createdAt と mtime の近さも条件にする。生成完了直後に両方記録されるので通常は数秒差。 */
const DEFAULT_TOLERANCE_MS = 10 * 60_000

/**
 * フォルダ内のファイルに対応する localStorage 履歴エントリを選ぶ。
 * 同名エントリのうち createdAt が mtime に最も近いものを返し、
 * 許容範囲を超えるもの(別ジョブの残骸)しか無ければ undefined(誤紐付けより未紐付けを優先)。
 */
export function pickHistoryMatch<T extends HistoryLike>(
  history: T[],
  filename: string,
  mtimeSec: number,
  toleranceMs: number = DEFAULT_TOLERANCE_MS,
): T | undefined {
  const mtimeMs = mtimeSec * 1000
  let best: T | undefined
  let bestDiff = Infinity
  for (const h of history) {
    if (h.filename !== filename) continue
    const created = Date.parse(h.createdAt)
    if (Number.isNaN(created)) continue
    const diff = Math.abs(created - mtimeMs)
    if (diff <= toleranceMs && diff < bestDiff) {
      best = h
      bestDiff = diff
    }
  }
  return best
}

import { describe, expect, it } from 'vitest'
import { pickHistoryMatch } from './history-match'

/** createdAt を epoch 秒で指定して履歴エントリを作る */
function entry(filename: string, createdAtSec: number, prompt: string) {
  return { filename, createdAt: new Date(createdAtSec * 1000).toISOString(), prompt }
}

const T = 1_755_000_000 // 基準時刻(epoch秒)

describe('pickHistoryMatch', () => {
  it('同名エントリが1件で時刻も近ければそれを返す', () => {
    const h = [entry('FrameWeaver_00012.mp4', T, 'a cat')]
    expect(pickHistoryMatch(h, 'FrameWeaver_00012.mp4', T + 3)?.prompt).toBe('a cat')
  })

  it('連番衝突(同名2件)では mtime に最も近い方を返す', () => {
    const h = [
      entry('FrameWeaver_00012.mp4', T + 90_000, 'new session'), // 履歴の先頭側(最新)
      entry('FrameWeaver_00012.mp4', T, 'old session'),
    ]
    // ファイルの mtime は旧セッション側に近い → 旧エントリのプロンプトを採用
    expect(pickHistoryMatch(h, 'FrameWeaver_00012.mp4', T + 5)?.prompt).toBe('old session')
  })

  it('同名でも時刻が許容範囲(既定10分)を超えていれば undefined', () => {
    const h = [entry('FrameWeaver_00012.mp4', T, 'stale')]
    expect(pickHistoryMatch(h, 'FrameWeaver_00012.mp4', T + 3600)).toBeUndefined()
  })

  it('ファイル名が一致しなければ undefined', () => {
    const h = [entry('FrameWeaver_00012.mp4', T, 'a cat')]
    expect(pickHistoryMatch(h, 'FrameWeaver_00099.mp4', T)).toBeUndefined()
  })

  it('createdAt が不正な文字列のエントリは無視する', () => {
    const h = [
      { filename: 'f.mp4', createdAt: 'not-a-date', prompt: 'broken' },
      entry('f.mp4', T, 'valid'),
    ]
    expect(pickHistoryMatch(h, 'f.mp4', T + 1)?.prompt).toBe('valid')
  })
})

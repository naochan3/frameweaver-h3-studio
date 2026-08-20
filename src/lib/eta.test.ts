import { describe, expect, it } from 'vitest'
import { estimateRemainingSec, formatDuration } from './eta'

describe('estimateRemainingSec', () => {
  it('直近ステップの平均から残り時間を推定する', () => {
    // 10秒/ステップで3ステップ経過、残り2ステップ → 約20秒
    const times = [0, 10_000, 20_000, 30_000]
    expect(estimateRemainingSec(times, 3, 5, 30_000)).toBe(20)
  })

  it('最後のステップからの経過時間を差し引く', () => {
    const times = [0, 10_000, 20_000, 30_000]
    // 最後のステップから4秒経過 → 20秒 - 4秒 = 16秒
    expect(estimateRemainingSec(times, 3, 5, 34_000)).toBe(16)
  })

  it('サンプル不足・完了時は null', () => {
    expect(estimateRemainingSec([0], 1, 5, 1000)).toBeNull()
    expect(estimateRemainingSec([0, 1000], 5, 5, 2000)).toBeNull()
    expect(estimateRemainingSec([], 0, 5, 0)).toBeNull()
  })

  it('負にならない', () => {
    const times = [0, 1_000]
    expect(estimateRemainingSec(times, 1, 2, 60_000)).toBe(0)
  })
})

describe('formatDuration', () => {
  it('分秒形式に変換する', () => {
    expect(formatDuration(45)).toBe('45秒')
    expect(formatDuration(192)).toBe('3分12秒')
    expect(formatDuration(60)).toBe('1分0秒')
  })
})

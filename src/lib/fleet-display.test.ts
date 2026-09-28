import { describe, expect, it } from 'vitest'
import { formatSampleAge, getWorkerDisplayState } from './fleet-display'

describe('fleet worker display state', () => {
  it('does not call an SSH-reachable host Comfy-ready when ComfyUI is down', () => {
    expect(getWorkerDisplayState({ hostStatus: 'online', comfyStatus: 'offline', stale: false })).toEqual({
      label: 'Comfy停止',
      tone: 'warning',
    })
  })

  it('prioritizes stale and unreachable states over old service data', () => {
    expect(getWorkerDisplayState({ hostStatus: 'offline', comfyStatus: 'unknown', stale: true })).toEqual({
      label: 'PC未接続',
      tone: 'danger',
    })
    expect(getWorkerDisplayState({ hostStatus: 'online', comfyStatus: 'online', stale: true })).toEqual({
      label: 'データ古い',
      tone: 'warning',
    })
  })

  it('shows a distinct initial state before the first collection', () => {
    expect(getWorkerDisplayState({ hostStatus: 'unknown', comfyStatus: 'unknown', stale: true })).toEqual({
      label: '確認中',
      tone: 'neutral',
    })
  })
})

describe('sample age formatting', () => {
  it.each([
    [null, '未取得'],
    [0, 'たった今'],
    [9_999, '9秒前'],
    [65_000, '1分前'],
  ] as const)('formats %s milliseconds as %s', (ageMs, expected) => {
    expect(formatSampleAge(ageMs)).toBe(expected)
  })
})

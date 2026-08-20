import { describe, expect, it } from 'vitest'
import { computeResolution } from './resolution'

describe('computeResolution', () => {
  it('16:9 1.0MP は実測記事の定番解像度(1344×736)に一致する', () => {
    expect(computeResolution('16:9', 1.0)).toEqual({ width: 1344, height: 736 })
  })

  it('9:16 0.5MP は32の倍数の縦長になる', () => {
    const r = computeResolution('9:16', 0.5)
    expect(r).toEqual({ width: 544, height: 928 })
    expect(r.width % 32).toBe(0)
    expect(r.height % 32).toBe(0)
  })

  it('1:1 は正方形になる', () => {
    const r = computeResolution('1:1', 1.0)
    expect(r.width).toBe(r.height)
  })

  it('縦横を入れ替えると解像度も入れ替わる', () => {
    const v = computeResolution('9:16', 0.4)
    const h = computeResolution('16:9', 0.4)
    expect(v.width).toBe(h.height)
    expect(v.height).toBe(h.width)
  })
})

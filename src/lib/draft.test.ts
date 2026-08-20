import { describe, expect, it } from 'vitest'
import { loadDraft, saveDraft } from './draft'

/** localStorage 互換の最小フェイク */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    has: (k: string) => map.has(k),
  }
}

describe('loadDraft', () => {
  it('保存済みの下書きを返す', () => {
    const s = fakeStorage({ 'draft-key': 'a cat dancing' })
    expect(loadDraft(s, 'draft-key')).toBe('a cat dancing')
  })

  it('未保存なら空文字を返す', () => {
    expect(loadDraft(fakeStorage(), 'draft-key')).toBe('')
  })

  it('storage が例外を投げても空文字を返す', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(loadDraft(broken, 'draft-key')).toBe('')
  })
})

describe('saveDraft', () => {
  it('下書きを保存し loadDraft で復元できる', () => {
    const s = fakeStorage()
    saveDraft(s, 'draft-key', 'hello')
    expect(loadDraft(s, 'draft-key')).toBe('hello')
  })

  it('空文字の保存はキーごと削除する', () => {
    const s = fakeStorage({ 'draft-key': 'old' })
    saveDraft(s, 'draft-key', '')
    expect(s.has('draft-key')).toBe(false)
  })

  it('storage が例外を投げても落ちない', () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    }
    expect(() => saveDraft(broken, 'draft-key', 'x')).not.toThrow()
  })
})

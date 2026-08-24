import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME,
  applyTheme,
  normalizeTheme,
  readTheme,
} from './theme'

describe('theme', () => {
  it('accepts supported themes and falls back for invalid saved values', () => {
    expect(normalizeTheme('ocean')).toBe('ocean')
    expect(normalizeTheme('unknown')).toBe(DEFAULT_THEME)
    expect(normalizeTheme(null)).toBe(DEFAULT_THEME)
  })

  it('reads, applies, and persists a theme', () => {
    const values = new Map<string, string>([['frameweaver-color-theme', 'violet']])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    const root = { dataset: {} as DOMStringMap }

    expect(readTheme(storage)).toBe('violet')
    applyTheme(root, storage, 'ocean')

    expect(root.dataset.colorTheme).toBe('ocean')
    expect(values.get('frameweaver-color-theme')).toBe('ocean')
  })

  it('continues when browser storage is unavailable', () => {
    const brokenStorage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    const root = { dataset: {} as DOMStringMap }

    expect(readTheme(brokenStorage)).toBe(DEFAULT_THEME)
    expect(() => applyTheme(root, brokenStorage, 'violet')).not.toThrow()
    expect(root.dataset.colorTheme).toBe('violet')
  })

})

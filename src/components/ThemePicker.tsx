import { useState } from 'react'
import {
  THEMES,
  applyTheme,
  browserStorage,
  normalizeTheme,
  readDisplayTheme,
  readTheme,
  setDisplayTheme,
  type DisplayTheme,
  type ThemeId,
} from '../lib/theme'

const DISPLAY_LABEL: Record<DisplayTheme, string> = { system: '自動', light: '淡色', dark: '暗色' }
const NEXT_DISPLAY: Record<DisplayTheme, DisplayTheme> = { system: 'light', light: 'dark', dark: 'system' }

export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>(() => readTheme(browserStorage()))
  const [displayTheme, setDisplayThemeState] = useState<DisplayTheme>(() => readDisplayTheme(browserStorage()))

  return (
    <label className="ml-auto flex items-center gap-1 text-xs text-ink-600 sm:ml-0">
      <span className="hidden lg:inline">テーマ</span>
      <select
        aria-label="テーマカラー"
        value={theme}
        onChange={(event) => {
          const next = normalizeTheme(event.target.value)
          setTheme(next)
          applyTheme(document.documentElement, browserStorage(), next)
        }}
        className="h-8 w-[4.75rem] rounded-lg border border-cream-200 bg-cream-50 px-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-accent-500 sm:w-auto"
      >
        {THEMES.map((item) => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => {
          const next = NEXT_DISPLAY[displayTheme]
          setDisplayTheme(document.documentElement, browserStorage(), next)
          setDisplayThemeState(next)
        }}
        className="rounded-lg border border-cream-200 bg-cream-50 px-1.5 py-1 text-xs font-semibold text-ink-600 hover:bg-cream-100"
        title="表示テーマを切替(自動→淡色→暗色)"
      >
        {DISPLAY_LABEL[displayTheme]}
      </button>
    </label>
  )
}

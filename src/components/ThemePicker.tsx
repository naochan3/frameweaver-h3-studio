import { useState } from 'react'
import { THEMES, applyTheme, normalizeTheme, readTheme, type ThemeId } from '../lib/theme'

export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>(() => readTheme(window.localStorage))

  return (
    <label className="ml-auto flex items-center gap-1 text-xs text-ink-600 sm:ml-0">
      <span className="hidden lg:inline">テーマ</span>
      <select
        aria-label="テーマカラー"
        value={theme}
        onChange={(event) => {
          const next = normalizeTheme(event.target.value)
          setTheme(next)
          applyTheme(document.documentElement, window.localStorage, next)
        }}
        className="h-8 w-[4.75rem] rounded-lg border border-cream-200 bg-cream-50 px-1.5 text-xs font-semibold text-ink-600 outline-none focus:border-accent-500 sm:w-auto"
      >
        {THEMES.map((item) => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>
    </label>
  )
}

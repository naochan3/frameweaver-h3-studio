/** テーマ設定。'system'=OS追従 / 'light' / 'dark'。data-theme属性で制御し、localStorageに保存。 */
export type Theme = 'system' | 'light' | 'dark'

const KEY = 'frameweaver-theme'

export function getTheme(): Theme {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

/** data-theme属性へ反映(system時は属性を外してOS設定に追従) */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme)
  applyTheme(theme)
}

/** 起動時に保存済みテーマを適用(フラッシュ低減のため早めに呼ぶ) */
export function initTheme(): void {
  applyTheme(getTheme())
}

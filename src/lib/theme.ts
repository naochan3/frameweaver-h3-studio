export const THEMES = [
  { id: 'ember', label: 'Ember' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'violet', label: 'Violet' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']
export type DisplayTheme = 'system' | 'light' | 'dark'
export const DEFAULT_THEME: ThemeId = 'ember'
export const DEFAULT_DISPLAY_THEME: DisplayTheme = 'system'

const COLOR_STORAGE_KEY = 'frameweaver-color-theme'
const DISPLAY_STORAGE_KEY = 'frameweaver-theme'

type ReadStorage = Pick<Storage, 'getItem'>
type WriteStorage = Pick<Storage, 'setItem'>
type ThemeRoot = Pick<HTMLElement, 'dataset'>

export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function readStoredValue(storage: ReadStorage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function persist(storage: WriteStorage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // Storage may be unavailable in private/restricted browser contexts.
  }
}

export function normalizeTheme(value: string | null): ThemeId {
  return THEMES.some((theme) => theme.id === value) ? value as ThemeId : DEFAULT_THEME
}

export function readTheme(storage?: ReadStorage): ThemeId {
  return normalizeTheme(readStoredValue(storage, COLOR_STORAGE_KEY) ?? readStoredValue(storage, DISPLAY_STORAGE_KEY))
}

export function applyTheme(root: ThemeRoot, storage: WriteStorage | undefined, theme: ThemeId): void {
  root.dataset.colorTheme = theme
  persist(storage, COLOR_STORAGE_KEY, theme)
}

export function readDisplayTheme(storage?: ReadStorage): DisplayTheme {
  const value = readStoredValue(storage, DISPLAY_STORAGE_KEY)
  return value === 'light' || value === 'dark' ? value : DEFAULT_DISPLAY_THEME
}

export function applyDisplayTheme(root: ThemeRoot, theme: DisplayTheme): void {
  if (theme === DEFAULT_DISPLAY_THEME) delete root.dataset.theme
  else root.dataset.theme = theme
}

export function setDisplayTheme(root: ThemeRoot, storage: WriteStorage | undefined, theme: DisplayTheme): void {
  applyDisplayTheme(root, theme)
  persist(storage, DISPLAY_STORAGE_KEY, theme)
}

export function initTheme(root: ThemeRoot, storage?: Storage): void {
  applyTheme(root, storage, readTheme(storage))
  applyDisplayTheme(root, readDisplayTheme(storage))
}

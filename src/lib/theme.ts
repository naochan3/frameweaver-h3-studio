export const THEMES = [
  { id: 'ember', label: 'Ember' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'violet', label: 'Violet' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']
export const DEFAULT_THEME: ThemeId = 'ember'

const STORAGE_KEY = 'frameweaver-theme'

export function normalizeTheme(value: string | null): ThemeId {
  return THEMES.some((theme) => theme.id === value) ? value as ThemeId : DEFAULT_THEME
}

export function readTheme(storage: Pick<Storage, 'getItem'>): ThemeId {
  try {
    return normalizeTheme(storage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_THEME
  }
}

export function applyTheme(
  root: Pick<HTMLElement, 'dataset'>,
  storage: Pick<Storage, 'setItem'>,
  theme: ThemeId,
): void {
  root.dataset.theme = theme
  try {
    storage.setItem(STORAGE_KEY, theme)
  } catch {
    // Storage may be unavailable in private/restricted browser contexts.
  }
}

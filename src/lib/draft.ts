/** localStorage 互換の最小インターフェース(テストでフェイク注入するため) */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const DRAFT_KEYS = {
  videoPrompt: 'frameweaver-draft-video-prompt',
  imagePrompt: 'frameweaver-draft-image-prompt',
} as const

/** 下書きを読み込む。未保存・storage不可(プライベートモード等)は空文字 */
export function loadDraft(storage: DraftStorage, key: string): string {
  try {
    return storage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

/** 下書きを保存する。空文字はキーごと削除。storage不可でも落とさない(下書きは失われてよい) */
export function saveDraft(storage: DraftStorage, key: string, value: string): void {
  try {
    if (value === '') {
      storage.removeItem(key)
    } else {
      storage.setItem(key, value)
    }
  } catch {
    // 保存失敗は無視(生成機能自体には影響しない)
  }
}

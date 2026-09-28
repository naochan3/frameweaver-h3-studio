import { beforeAll, describe, expect, it, vi } from 'vitest'

/** 下書き永続化の配線検証。store モジュールは import 時に WebSocket 接続・
 * localStorage 読込・ポーリング開始まで行うため、ブラウザグローバルをスタブしてから
 * 動的 import する(node 環境での統合テスト)。 */

const storageMap = new Map<string, string>()
const fakeLocalStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => void storageMap.set(k, v),
  removeItem: (k: string) => void storageMap.delete(k),
}

class FakeWebSocket {
  static readonly OPEN = 1
  readyState = 0
  binaryType = ''
  onmessage: unknown = null
  onclose: unknown = null
  onopen: unknown = null
}

let store: typeof import('./generation')

beforeAll(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', fakeLocalStorage)
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('location', { origin: 'http://localhost:5180' })
  // リロード前に保存されていた下書き
  storageMap.set('frameweaver-draft-video-prompt', 'saved video draft')
  storageMap.set('frameweaver-draft-image-prompt', 'saved image draft')
  store = await import('./generation')
})

describe('プロンプト下書きの永続化(store配線)', () => {
  it('起動時に localStorage の下書きを初期値へ復元する', () => {
    const s = store.useGenerationStore.getState()
    expect(s.params.prompt).toBe('saved video draft')
    expect(s.imageParams.prompt).toBe('saved image draft')
  })

  it('動画プロンプトの変更が localStorage に保存される', () => {
    store.useGenerationStore.getState().setParams({ prompt: 'edited video' })
    expect(storageMap.get('frameweaver-draft-video-prompt')).toBe('edited video')
  })

  it('画像プロンプトの変更が localStorage に保存される', () => {
    store.useGenerationStore.getState().setImageParams({ prompt: 'edited image' })
    expect(storageMap.get('frameweaver-draft-image-prompt')).toBe('edited image')
  })

  it('プロンプトを空にすると下書きキーごと削除される', () => {
    store.useGenerationStore.getState().setParams({ prompt: '' })
    expect(storageMap.has('frameweaver-draft-video-prompt')).toBe(false)
  })
})

describe('RECENT のプロンプト補完(reloadFolder)', () => {
  it('localStorage履歴に無いファイルは埋め込みメタデータのプロンプトで補完する', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        files: [{ filename: 'FrameWeaver_00001_.mp4', mtime: 1_755_000_000, prompt: 'embedded prompt' }],
      }),
    }))
    await store.useGenerationStore.getState().reloadFolder()
    const items = store.useGenerationStore.getState().folderItems
    expect(items).toHaveLength(1)
    expect(items[0].prompt).toBe('embedded prompt')
  })
})

describe('非同期プロンプト強化の競合防止', () => {
  it('画像モデル切替直後は可用性確認が完了するまで強化を無効化する', () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    store.useGenerationStore.setState((s) => ({
      imageParams: { ...s.imageParams, model: 'krea2' },
      imageRewriterAvailable: true,
    }))

    store.useGenerationStore.getState().setImageModel('zimage')

    expect(store.useGenerationStore.getState().imageRewriterAvailable).toBe(false)
  })

  it('強化中に動画条件を編集した場合は古い応答で上書きしない', async () => {
    let resolveFetch!: (value: unknown) => void
    vi.stubGlobal('fetch', () => new Promise((resolve) => { resolveFetch = resolve }))
    store.useGenerationStore.setState((s) => ({
      params: { ...s.params, prompt: 'original', mode: 'text', lengthSec: 5 },
      rewriting: false,
    }))

    const pending = store.useGenerationStore.getState().rewritePrompt()
    store.useGenerationStore.getState().setParams({ prompt: 'edited while waiting' })
    resolveFetch({
      ok: true,
      json: async () => ({ response: 'integrated_multimodal_description: At 00:00.000 subject appears.\noverall_soundscape: quiet room tone.\nnon_diegetic_music: none.' }),
    })
    await pending

    expect(store.useGenerationStore.getState().params.prompt).toBe('edited while waiting')
    expect(store.useGenerationStore.getState().rewriteUndo).toBeNull()
    expect(store.useGenerationStore.getState().rewriting).toBe(false)
  })

  it('強化中に画像モデルを変更した場合は古い応答で上書きしない', async () => {
    let resolveFetch!: (value: unknown) => void
    let call = 0
    vi.stubGlobal('fetch', () => {
      call += 1
      if (call === 1) return new Promise((resolve) => { resolveFetch = resolve })
      return Promise.resolve(Response.json({ models: ['fw-rewriter-zimage'] }))
    })
    store.useGenerationStore.setState((s) => ({
      imageParams: { ...s.imageParams, prompt: 'original image', model: 'krea2' },
      imageRewriting: false,
    }))

    const pending = store.useGenerationStore.getState().rewriteImagePrompt()
    store.useGenerationStore.getState().setImageModel('zimage')
    resolveFetch({
      ok: true,
      json: async () => ({ response: Array.from({ length: 90 }, (_, i) => `detail${i}`).join(' ') }),
    })
    await pending

    expect(store.useGenerationStore.getState().imageParams.model).toBe('zimage')
    expect(store.useGenerationStore.getState().imageParams.prompt).toBe('original image')
    expect(store.useGenerationStore.getState().imageRewriteUndo).toBeNull()
    expect(store.useGenerationStore.getState().imageRewriting).toBe(false)
  })
})

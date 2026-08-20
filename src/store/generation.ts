import { create } from 'zustand'
import { ComfyClient } from '../lib/comfy-client'
import { buildImageWorkflow } from '../lib/image-workflow'
import { imageRecommendedParams, videoRecommendedParams } from '../lib/presets'
import { randomSeed } from '../lib/seed'
import { patchWorkflow } from '../lib/workflow-patcher'
import type { GenerationMode, GenerationParams, ImageModel, ImageParams } from '../lib/types'

// 既定は同一オリジンの /comfy(Viteプロキシ経由)。これによりPCでもLAN内の別端末でも
// 「開いているページと同じホスト」にアクセスするだけでComfyUIに繋がる。
export const COMFY_URL =
  import.meta.env.VITE_COMFY_URL ??
  (typeof location !== 'undefined' ? `${location.origin}/comfy` : 'http://127.0.0.1:8189/comfy')

export const client = new ComfyClient(COMFY_URL)

export type OutputKind = 'video' | 'image'

export interface HistoryItem {
  promptId: string
  kind: OutputKind
  /** 動画はモード名、画像はモデル名 */
  mode: string
  prompt: string
  nsfw: boolean
  videoUrl: string
  filename: string
  createdAt: string
  /** 生成時の設定スナップショット(詳細画面・再利用用。古い履歴には無い) */
  settings?: {
    width: number
    height: number
    steps: number
    seed: number
    extraLora?: string
    extraLoraStrength?: number
    // 動画のみ
    lengthSec?: number
    turbo?: boolean
  }
}

export type GenerationStatus = 'idle' | 'uploading' | 'queued' | 'running' | 'done' | 'error'

interface GenerationState {
  connected: boolean
  queueRemaining: number
  vram: { total: number; free: number } | null
  /** ComfyUI 上で選択可能な LoRA 一覧(追加LoRAの候補表示用) */
  loraList: string[]
  params: GenerationParams
  /** アップロード済み画像 (ComfyUI上のファイル名と表示用URL) */
  sources: { name: string; previewUrl: string }[]
  status: GenerationStatus
  progress: { value: number; max: number } | null
  /** 生成開始時刻(経過時間表示用) */
  startedAt: number | null
  /** 各進捗イベントの受信時刻(残り時間推定用) */
  stepTimestamps: number[]
  previewUrl: string | null
  currentPromptId: string | null
  /** 現在実行中ジョブの種別 */
  currentKind: OutputKind
  videoUrl: string | null
  /** 完了した出力の種別 */
  resultKind: OutputKind
  error: string | null
  history: HistoryItem[]
  /** アプリ上部のタブ(動画/画像) */
  appTab: 'video' | 'image'
  imageParams: ImageParams
  /** 使い方ガイドの表示状態(初回訪問時は自動表示) */
  guideOpen: boolean
  /** シードを生成ごとにランダムにするか(動画/画像それぞれ) */
  videoSeedRandom: boolean
  imageSeedRandom: boolean

  toggleVideoSeedRandom: () => void
  toggleImageSeedRandom: () => void
  setGuideOpen: (open: boolean) => void
  setAppTab: (tab: 'video' | 'image') => void
  setImageParams: (patch: Partial<ImageParams>) => void
  /** 画像モデルを切り替え、そのモデルの推奨値(steps/解像度)も適用する */
  setImageModel: (model: ImageModel) => void
  /** 動画設定を推奨値に戻す(モード・プロンプト・画像は維持) */
  resetVideoRecommended: () => void
  /** 画像設定を現在モデルの推奨値に戻す */
  resetImageRecommended: () => void
  generateImage: () => Promise<void>
  setMode: (mode: GenerationMode) => void
  setParams: (patch: Partial<GenerationParams>) => void
  addSourceFiles: (files: File[]) => Promise<void>
  /** 生成済み画像(ComfyUI出力URL)を動画の参照素材として取り込み、動画タブに切り替える */
  sendImageToSource: (url: string, mode?: GenerationMode) => Promise<void>
  /** 詳細画面で表示中の履歴アイテム(null=非表示) */
  detailItem: HistoryItem | null
  openDetail: (item: HistoryItem) => void
  closeDetail: () => void
  /** 履歴アイテムのプロンプト・設定を編集画面に読み込む */
  applyHistorySettings: (item: HistoryItem) => void
  removeSource: (index: number) => void
  generate: () => Promise<void>
  stop: () => Promise<void>
  freeVram: () => Promise<void>
  /** 出力フォルダをエクスプローラーで開く('' / video / zimage / krea2) */
  openOutputFolder: (subdir: string) => Promise<void>
  clearHistory: () => void
}

const HISTORY_KEY = 'frameweaver-history'

function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as HistoryItem[]
  } catch {
    return []
  }
}

function saveHistory(items: HistoryItem[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 50)))
}

/** モードごとに必要な画像枚数 [最小, 最大] */
export function imageSlots(mode: GenerationMode): [number, number] {
  switch (mode) {
    case 'text': return [0, 0]
    case 'first': return [1, 1]
    case 'first_last': return [2, 2]
    case 'last': return [1, 1]
    case 'reference': return [1, 9]
  }
}

export const useGenerationStore = create<GenerationState>((set, get) => ({
  connected: false,
  queueRemaining: 0,
  vram: null,
  params: {
    mode: 'text',
    prompt: '',
    nsfw: false,
    images: [],
    turbo: true,
    steps: 5,
    width: 544,
    height: 928,
    lengthSec: 5,
    seed: randomSeed(),
    extraLora: '',
    extraLoraStrength: 1.0,
  },
  loraList: [],
  sources: [],
  status: 'idle',
  progress: null,
  startedAt: null,
  stepTimestamps: [],
  previewUrl: null,
  currentPromptId: null,
  currentKind: 'video',
  videoUrl: null,
  resultKind: 'video',
  error: null,
  history: loadHistory(),
  appTab: 'video',
  imageParams: {
    model: 'zimage',
    prompt: '',
    width: 864,
    height: 1536,
    steps: 8,
    seed: randomSeed(),
    extraLora: '',
    extraLoraStrength: 1.0,
  },

  guideOpen: localStorage.getItem('frameweaver-guide-seen') !== '1',
  videoSeedRandom: true,
  imageSeedRandom: true,

  toggleVideoSeedRandom: () => set((s) => ({ videoSeedRandom: !s.videoSeedRandom })),
  toggleImageSeedRandom: () => set((s) => ({ imageSeedRandom: !s.imageSeedRandom })),

  setGuideOpen: (open) => {
    if (!open) localStorage.setItem('frameweaver-guide-seen', '1')
    set({ guideOpen: open })
  },

  setAppTab: (tab) => set({ appTab: tab }),

  setImageParams: (patch) => set((s) => ({ imageParams: { ...s.imageParams, ...patch } })),

  setImageModel: (model) =>
    set((s) => ({ imageParams: { ...s.imageParams, ...imageRecommendedParams(model) } })),

  resetVideoRecommended: () =>
    set((s) => ({ params: { ...s.params, ...videoRecommendedParams() } })),

  resetImageRecommended: () =>
    set((s) => ({ imageParams: { ...s.imageParams, ...imageRecommendedParams(s.imageParams.model) } })),

  generateImage: async () => {
    let { imageParams } = get()
    if (!imageParams.prompt.trim()) {
      set({ status: 'error', error: 'プロンプトを入力してください' })
      return
    }
    // ランダムON、または未確定(-1)のときは実シードを採番して履歴に残す
    if (get().imageSeedRandom || imageParams.seed === -1) {
      imageParams = { ...imageParams, seed: randomSeed() }
      set({ imageParams })
    }
    set({
      status: 'queued',
      error: null,
      videoUrl: null,
      previewUrl: null,
      progress: null,
      startedAt: Date.now(),
      stepTimestamps: [],
      currentKind: 'image',
    })
    try {
      const wf = buildImageWorkflow(imageParams)
      const promptId = await client.submit(wf)
      set({ currentPromptId: promptId })
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  setMode: (mode) => {
    const max = imageSlots(mode)[1]
    set((s) => ({
      params: { ...s.params, mode },
      sources: s.sources.slice(0, max),
      error: null,
    }))
  },

  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),

  addSourceFiles: async (files) => {
    const { params, sources } = get()
    const max = imageSlots(params.mode)[1]
    if (max === 0) return
    set({ status: 'uploading', error: null })
    try {
      const added: { name: string; previewUrl: string }[] = []
      for (const file of files.slice(0, max - sources.length)) {
        const name = await client.uploadImage(file)
        added.push({ name, previewUrl: URL.createObjectURL(file) })
      }
      set((s) => ({ sources: [...s.sources, ...added], status: 'idle' }))
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  sendImageToSource: async (url, mode) => {
    set({ status: 'uploading', error: null })
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error('画像の取得に失敗しました')
      const blob = await res.blob()
      const file = new File([blob], `source_${Date.now()}.png`, { type: blob.type || 'image/png' })
      const name = await client.uploadImage(file)
      const previewUrl = URL.createObjectURL(blob)
      set((s) => {
        // Textモードは画像を持てないので、指定が無ければ First に切り替える
        const nextMode: GenerationMode = mode ?? (imageSlots(s.params.mode)[1] === 0 ? 'first' : s.params.mode)
        const max = imageSlots(nextMode)[1]
        const sources = [...s.sources, { name, previewUrl }].slice(0, max)
        return { appTab: 'video', params: { ...s.params, mode: nextMode }, sources, status: 'idle' }
      })
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  detailItem: null,
  openDetail: (item) => set({ detailItem: item }),
  closeDetail: () => set({ detailItem: null }),

  applyHistorySettings: (item) => {
    const s = item.settings
    if (item.kind === 'video') {
      set((state) => ({
        appTab: 'video',
        detailItem: null,
        // 読み込んだシードを再現するためランダムは自動OFF(設定があるときのみ)
        videoSeedRandom: s ? false : state.videoSeedRandom,
        params: {
          ...state.params,
          prompt: item.prompt,
          nsfw: item.nsfw,
          ...(s && {
            width: s.width,
            height: s.height,
            steps: s.steps,
            seed: s.seed,
            lengthSec: s.lengthSec ?? state.params.lengthSec,
            turbo: s.turbo ?? state.params.turbo,
            extraLora: s.extraLora ?? '',
            extraLoraStrength: s.extraLoraStrength ?? 1.0,
          }),
        },
      }))
    } else {
      set((state) => ({
        appTab: 'image',
        detailItem: null,
        imageSeedRandom: s ? false : state.imageSeedRandom,
        imageParams: {
          ...state.imageParams,
          model: item.mode === 'krea2' ? 'krea2' : 'zimage',
          prompt: item.prompt,
          ...(s && {
            width: s.width,
            height: s.height,
            steps: s.steps,
            seed: s.seed,
            extraLora: s.extraLora ?? '',
            extraLoraStrength: s.extraLoraStrength ?? 1.0,
          }),
        },
      }))
    }
  },

  removeSource: (index) => set((s) => ({ sources: s.sources.filter((_, i) => i !== index) })),

  generate: async () => {
    let { params } = get()
    const { sources } = get()
    const [min] = imageSlots(params.mode)
    if (sources.length < min) {
      set({ status: 'error', error: `このモードには画像が${min}枚必要です` })
      return
    }
    if (!params.prompt.trim()) {
      set({ status: 'error', error: 'プロンプトを入力してください' })
      return
    }
    if (get().videoSeedRandom || params.seed === -1) {
      params = { ...params, seed: randomSeed() }
      set({ params })
    }
    set({
      status: 'queued',
      error: null,
      videoUrl: null,
      previewUrl: null,
      progress: null,
      startedAt: Date.now(),
      stepTimestamps: [],
      currentKind: 'video',
    })
    try {
      const wf = patchWorkflow({ ...params, images: sources.map((s) => s.name) })
      const promptId = await client.submit(wf)
      set({ currentPromptId: promptId })
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  stop: async () => {
    await client.interrupt()
    await client.clearQueue()
    set({ status: 'idle', progress: null })
  },

  freeVram: async () => {
    await client.freeMemory()
  },

  openOutputFolder: async (subdir) => {
    const ok = await client.openOutputFolder(subdir)
    if (!ok) {
      set({ error: 'フォルダを開けませんでした(ComfyUIの再起動が必要な場合があります)' })
    }
  },

  clearHistory: () => {
    saveHistory([])
    set({ history: [] })
  },
}))

async function handleDone(promptId: string) {
  const outputs = await client.fetchOutputs(promptId)
  const { params, imageParams, history, currentKind } = useGenerationStore.getState()
  const output =
    currentKind === 'video'
      ? (outputs.find((o) => /\.(mp4|webm|mov)$/i.test(o.filename)) ?? outputs[0])
      : (outputs.find((o) => /\.(png|jpe?g|webp)$/i.test(o.filename)) ?? outputs[0])
  if (!output) {
    useGenerationStore.setState({ status: 'error', error: '出力ファイルが見つかりませんでした' })
    return
  }
  const url = client.viewUrl(output)
  const item: HistoryItem = {
    promptId,
    kind: currentKind,
    mode: currentKind === 'video' ? params.mode : imageParams.model,
    prompt: currentKind === 'video' ? params.prompt : imageParams.prompt,
    nsfw: currentKind === 'video' ? params.nsfw : false,
    videoUrl: url,
    filename: output.filename,
    createdAt: new Date().toISOString(),
    settings:
      currentKind === 'video'
        ? {
            width: params.width,
            height: params.height,
            steps: params.steps,
            seed: params.seed,
            extraLora: params.extraLora,
            extraLoraStrength: params.extraLoraStrength,
            lengthSec: params.lengthSec,
            turbo: params.turbo,
          }
        : {
            width: imageParams.width,
            height: imageParams.height,
            steps: imageParams.steps,
            seed: imageParams.seed,
            extraLora: imageParams.extraLora,
            extraLoraStrength: imageParams.extraLoraStrength,
          },
  }
  const newHistory = [item, ...history]
  saveHistory(newHistory)
  useGenerationStore.setState({
    status: 'done',
    videoUrl: url,
    resultKind: currentKind,
    history: newHistory,
    progress: null,
  })
}

// WebSocketイベント → ストア反映
client.onEvent((ev) => {
  const state = useGenerationStore.getState()
  switch (ev.type) {
    case 'status':
      if (ev.message === 'connected') {
        useGenerationStore.setState({ connected: true })
        void client.getLoraList().then((loraList) => useGenerationStore.setState({ loraList }))
      }
      if (ev.message === 'disconnected') useGenerationStore.setState({ connected: false })
      if (ev.queueRemaining !== undefined) useGenerationStore.setState({ queueRemaining: ev.queueRemaining })
      break
    case 'progress':
      if (ev.promptId === state.currentPromptId) {
        useGenerationStore.setState({
          status: 'running',
          progress: { value: ev.value ?? 0, max: ev.max ?? 1 },
          stepTimestamps: [...state.stepTimestamps, Date.now()],
        })
      }
      break
    case 'preview':
      if (state.status === 'running' || state.status === 'queued') {
        useGenerationStore.setState({ previewUrl: ev.previewUrl ?? null })
      }
      break
    case 'executing':
      if (ev.promptId === state.currentPromptId && ev.nodeId === null) {
        void handleDone(ev.promptId)
      }
      break
    case 'error':
      if (ev.promptId === state.currentPromptId) {
        useGenerationStore.setState({ status: 'error', error: ev.message ?? '生成エラー', progress: null })
      }
      break
    default:
      break
  }
})

client.connect()

// VRAM 監視(5秒ポーリング)
setInterval(async () => {
  const stats = await client.systemStats()
  if (stats) {
    useGenerationStore.setState({ vram: { total: stats.vramTotal, free: stats.vramFree }, connected: true })
  }
}, 5000)

import { create } from 'zustand'
import { ComfyClient, type HistoryOutput } from '../lib/comfy-client'
import { clearLegacyHistory, frameWeaverApi, takeLegacyHistory, type FrameWeaverJob } from '../lib/frameweaver-api'
import { DRAFT_KEYS, loadDraft, saveDraft } from '../lib/draft'
import { createAdaptivePoller, pollDelay } from '../lib/adaptive-poller'
import { buildImageWorkflow } from '../lib/image-workflow'
import { classifyLora } from '../lib/lora'
import { imageRecommendedParams, videoRecommendedParams } from '../lib/presets'
import { randomSeed } from '../lib/seed'
import {
  imageRewriterInstalled,
  refineImageViaOllama,
  refineVideoViaOllama,
  rewriteImageViaOllama,
  rewriteViaOllama,
  rewriterInstalled,
  translatePromptToJa,
} from '../lib/rewriter'
import { patchWorkflow } from '../lib/workflow-patcher'
import type { NodeCapabilitySnapshot } from '../lib/model-capability'
import type { GenerationMode, GenerationParams, ImageModel, ImageParams, LoraMetaMap } from '../lib/types'

// 既定は同一オリジンの /comfy(Viteプロキシ経由)。これによりPCでもLAN内の別端末でも
// 「開いているページと同じホスト」にアクセスするだけでComfyUIに繋がる。
export const COMFY_URL =
  import.meta.env.VITE_COMFY_URL ??
  (typeof location !== 'undefined' ? `${location.origin}/comfy` : 'http://127.0.0.1:8188/comfy')

export const client = new ComfyClient(COMFY_URL)

export type OutputKind = 'video' | 'image'
export type WorkerPreference = { mode: 'auto' } | { mode: 'explicit'; worker_id: string }

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
    nsfw?: boolean
    durationSec?: number
    cfg?: number
    negativePrompt?: string
  }
}

export type GenerationStatus = 'idle' | 'uploading' | 'queued' | 'running' | 'done' | 'error'

interface GenerationState {
  workerPreference: WorkerPreference
  setWorkerPreference: (preference: WorkerPreference) => void
  /** ComfyUI REST APIが応答しているか */
  connected: boolean
  /** 生成進捗・完了通知を受け取るWebSocketが接続中か */
  wsConnected: boolean
  queueRemaining: number
  vram: { total: number; free: number } | null
  capability: NodeCapabilitySnapshot | null
  /** ComfyUI 上で選択可能な LoRA 一覧(追加LoRAの候補表示用) */
  loraList: string[]
  checkpointList: string[]
  loraMeta: LoraMetaMap
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
  loraCatalogOpen: boolean
  /** プロンプト自動強化(H3リライタ)が導入済みか */
  rewriterAvailable: boolean
  /** リライト実行中 */
  rewriting: boolean
  /** リライト前のプロンプト(元に戻す用。null=戻す先なし) */
  rewriteUndo: string | null
  /** 一言 → H3本番プロンプトへ自動強化(動画タブ) */
  rewritePrompt: () => Promise<void>
  /** リライト結果を取り消して元のプロンプトに戻す */
  undoRewrite: () => void
  /** 日本語の抽象指示で動画プロンプトを改善(3ブロック形式は厳守) */
  videoRefining: boolean
  refineVideoPrompt: (instruction: string) => Promise<void>
  /** 動画プロンプトの日本語訳(レビュー表示専用) */
  videoPromptJa: string | null
  videoTranslating: boolean
  translateVideoPrompt: () => Promise<void>
  clearVideoPromptJa: () => void
  /** 画像プロンプト強化(Krea2/Z-Image)が導入済みか */
  imageRewriterAvailable: boolean
  imageRewriting: boolean
  imageRewriteUndo: string | null
  /** 一言 → 画像本番プロンプトへ自動強化(画像タブ) */
  rewriteImagePrompt: () => Promise<void>
  undoImageRewrite: () => void
  /** 日本語の抽象指示で画像プロンプトを改善(実プロンプトは英語のまま) */
  imageRefining: boolean
  refineImagePrompt: (instruction: string) => Promise<void>
  /** 実プロンプトの日本語訳(レビュー表示専用。null=未取得/非表示) */
  imagePromptJa: string | null
  imageTranslating: boolean
  translateImagePrompt: () => Promise<void>
  clearImagePromptJa: () => void
  /** シードを生成ごとにランダムにするか(動画/画像それぞれ) */
  videoSeedRandom: boolean
  imageSeedRandom: boolean

  toggleVideoSeedRandom: () => void
  toggleImageSeedRandom: () => void
  setGuideOpen: (open: boolean) => void
  setLoraCatalogOpen: (open: boolean) => void
  refreshLoraMeta: () => Promise<void>
  /** GPU・モデル在庫をComfyUIから再取得する */
  refreshCapability: () => Promise<void>
  /** カタログからLoRAを選択: 対象モデルへ自動切替し、追加LoRAに設定する */
  applyLoraFromCatalog: (metaKey: string) => void
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
  /** 生成物を削除(出力ファイル+履歴+一覧から除去) */
  deleteOutput: (item: HistoryItem) => Promise<void>
  removeSource: (index: number) => void
  generate: () => Promise<void>
  stop: () => Promise<void>
}

function outputFromJob(job: FrameWeaverJob): HistoryOutput | null {
  if (!job.output_json) return null
  try {
    const outputs = JSON.parse(job.output_json) as unknown
    if (!Array.isArray(outputs)) return null
    for (const value of outputs) {
      const output = value as Partial<HistoryOutput>
      if (typeof output.filename === 'string') {
        return {
          filename: output.filename,
          subfolder: typeof output.subfolder === 'string' ? output.subfolder : '',
          type: typeof output.type === 'string' ? output.type : 'output',
        }
      }
    }
  } catch {
    // 壊れた旧出力メタデータは、履歴行自体を消さずプレビューなしとして扱う。
  }
  return null
}

export function historyFromJob(job: FrameWeaverJob): HistoryItem {
  let settings: HistoryItem['settings']
  try {
    settings = JSON.parse(job.settings_json) as HistoryItem['settings']
  } catch {
    settings = undefined
  }
  const output = outputFromJob(job)
  return {
    promptId: job.id,
    kind: job.kind,
    mode: job.mode,
    prompt: job.prompt,
    nsfw: job.kind === 'video' && settings?.nsfw === true,
    videoUrl: output ? client.viewUrl(output) : '',
    filename: output?.filename ?? job.id,
    createdAt: job.created_at,
    settings,
  }
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
  workerPreference: { mode: 'auto' },
  setWorkerPreference: (workerPreference) => set({ workerPreference }),
  connected: false,
  wsConnected: false,
  queueRemaining: 0,
  vram: null,
  capability: null,
  params: {
    mode: 'text',
    prompt: loadDraft(localStorage, DRAFT_KEYS.videoPrompt),
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
  checkpointList: [],
  loraMeta: {},
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
  history: takeLegacyHistory<HistoryItem>(),
  appTab: 'video',
  imageParams: {
    model: 'zimage',
    prompt: loadDraft(localStorage, DRAFT_KEYS.imagePrompt),
    width: 864,
    height: 1536,
    steps: 8,
    seed: randomSeed(),
    extraLora: '',
    extraLoraStrength: 1.0,
    negativePrompt: '',
    cfg: 6,
    animeCheckpoint: '',
  },

  guideOpen: localStorage.getItem('frameweaver-guide-seen') !== '1',
  loraCatalogOpen: false,
  rewriterAvailable: false,
  rewriting: false,
  rewriteUndo: null,
  videoRefining: false,
  videoPromptJa: null,
  videoTranslating: false,
  imageRewriterAvailable: false,
  imageRewriting: false,
  imageRewriteUndo: null,
  imageRefining: false,
  imagePromptJa: null,
  imageTranslating: false,
  videoSeedRandom: true,
  imageSeedRandom: true,

  toggleVideoSeedRandom: () => set((s) => ({ videoSeedRandom: !s.videoSeedRandom })),
  toggleImageSeedRandom: () => set((s) => ({ imageSeedRandom: !s.imageSeedRandom })),

  setGuideOpen: (open) => {
    if (!open) localStorage.setItem('frameweaver-guide-seen', '1')
    set({ guideOpen: open })
  },

  rewritePrompt: async () => {
    const { params, rewriting } = get()
    const text = params.prompt.trim()
    const request = { prompt: params.prompt, mode: params.mode, lengthSec: params.lengthSec }
    if (rewriting) return
    if (!text) {
      set({ error: '強化する一言(何を作りたいか)を先に入力してください' })
      return
    }
    set({ rewriting: true, error: null })
    try {
      // 軽量Ollama(Q8 8.7GB)で生成。初回のみモデル常駐化で少し待つ程度
      const out = await rewriteViaOllama(text, params.mode, params.lengthSec)
      set((s) => ({
        rewriting: false,
        ...(s.params.prompt === request.prompt && s.params.mode === request.mode && s.params.lengthSec === request.lengthSec
          ? { rewriteUndo: request.prompt, params: { ...s.params, prompt: out } }
          : {}),
      }))
    } catch (e) {
      set({ rewriting: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  undoRewrite: () => {
    set((s) =>
      s.rewriteUndo === null
        ? s
        : { params: { ...s.params, prompt: s.rewriteUndo }, rewriteUndo: null, videoPromptJa: null },
    )
  },

  refineVideoPrompt: async (instruction) => {
    const { params, videoRefining } = get()
    if (videoRefining) return
    if (!params.prompt.trim()) {
      set({ error: '先にプロンプトを用意してください' })
      return
    }
    if (!instruction.trim()) {
      set({ error: '日本語で修正の指示を入力してください' })
      return
    }
    set({ videoRefining: true, error: null })
    try {
      const out = await refineVideoViaOllama(params.prompt, instruction, params.mode, params.lengthSec)
      set((s) => ({
        videoRefining: false,
        rewriteUndo: s.params.prompt,
        params: { ...s.params, prompt: out },
        videoPromptJa: null,
      }))
    } catch (e) {
      set({ videoRefining: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  translateVideoPrompt: async () => {
    const { params, videoTranslating } = get()
    if (videoTranslating || !params.prompt.trim()) return
    set({ videoTranslating: true, error: null })
    try {
      const ja = await translatePromptToJa(params.prompt)
      set({ videoTranslating: false, videoPromptJa: ja })
    } catch (e) {
      set({ videoTranslating: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  clearVideoPromptJa: () => set({ videoPromptJa: null }),

  rewriteImagePrompt: async () => {
    const { imageParams, imageRewriting } = get()
    const text = imageParams.prompt.trim()
    const request = { prompt: imageParams.prompt, model: imageParams.model }
    if (imageRewriting) return
    if (!text) {
      set({ error: '強化する一言(何を描きたいか)を先に入力してください' })
      return
    }
    set({ imageRewriting: true, error: null })
    try {
      const out = await rewriteImageViaOllama(text, imageParams.model)
      set((s) => ({
        imageRewriting: false,
        ...(s.imageParams.prompt === request.prompt && s.imageParams.model === request.model
          ? { imageRewriteUndo: request.prompt, imageParams: { ...s.imageParams, prompt: out } }
          : {}),
      }))
    } catch (e) {
      set({ imageRewriting: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  undoImageRewrite: () => {
    set((s) =>
      s.imageRewriteUndo === null
        ? s
        : { imageParams: { ...s.imageParams, prompt: s.imageRewriteUndo }, imageRewriteUndo: null, imagePromptJa: null },
    )
  },

  refineImagePrompt: async (instruction) => {
    const { imageParams, imageRefining } = get()
    if (imageRefining) return
    if (!imageParams.prompt.trim()) {
      set({ error: '先にプロンプトを用意してください' })
      return
    }
    if (!instruction.trim()) {
      set({ error: '日本語で修正の指示を入力してください' })
      return
    }
    set({ imageRefining: true, error: null })
    try {
      const out = await refineImageViaOllama(imageParams.prompt, instruction, imageParams.model)
      set((s) => ({
        imageRefining: false,
        imageRewriteUndo: s.imageParams.prompt,
        imageParams: { ...s.imageParams, prompt: out },
        imagePromptJa: null, // 内容が変わったので古い訳は破棄
      }))
    } catch (e) {
      set({ imageRefining: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  translateImagePrompt: async () => {
    const { imageParams, imageTranslating } = get()
    if (imageTranslating || !imageParams.prompt.trim()) return
    set({ imageTranslating: true, error: null })
    try {
      const ja = await translatePromptToJa(imageParams.prompt)
      set({ imageTranslating: false, imagePromptJa: ja })
    } catch (e) {
      set({ imageTranslating: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  clearImagePromptJa: () => set({ imagePromptJa: null }),

  setLoraCatalogOpen: (open) => {
    set({ loraCatalogOpen: open })
    if (open) void get().refreshLoraMeta()
  },

  refreshLoraMeta: async () => {
    const [loraMeta, loraList] = await Promise.all([client.getLoraMeta(), client.getLoraList()])
    set({ loraMeta, loraList })
  },

  refreshCapability: async () => {
    const capability = await client.capabilities()
    const primary = capability.devices.reduce<(typeof capability.devices)[number] | null>(
      (best, device) => !best || device.vramTotal > best.vramTotal ? device : best,
      null,
    )
    set({
      capability,
      connected: capability.status === 'ready' || capability.status === 'degraded',
      ...(primary ? { vram: { total: primary.vramTotal, free: primary.vramFree } } : {}),
      checkpointList: capability.inventory.checkpoints,
      loraList: capability.inventory.loras,
    })
  },

  applyLoraFromCatalog: (metaKey) => {
    const comfyName = get().loraList.find((name) => name.replace(/\\/g, '/') === metaKey) ?? metaKey
    const target = classifyLora(metaKey).target
    set((state) => {
      const model: ImageModel =
        target === 'anime' || target === 'zimage' || target === 'krea2' ? target : state.imageParams.model
      return {
        appTab: 'image',
        loraCatalogOpen: false,
        imageParams: {
          ...state.imageParams,
          ...(model !== state.imageParams.model ? imageRecommendedParams(model) : {}),
          model,
          extraLora: comfyName,
          extraLoraStrength: 1,
        },
      }
    })
    const selectedModel = get().imageParams.model
    void imageRewriterInstalled(selectedModel).then((ok) => {
      if (get().imageParams.model === selectedModel) set({ imageRewriterAvailable: ok })
    })
  },

  setAppTab: (tab) => set({ appTab: tab }),

  setImageParams: (patch) => set((s) => ({ imageParams: { ...s.imageParams, ...patch } })),

  setImageModel: (model) => {
    set((s) => ({ imageParams: { ...s.imageParams, ...imageRecommendedParams(model) }, imageRewriterAvailable: false }))
    void imageRewriterInstalled(model).then((ok) => {
      if (get().imageParams.model === model) set({ imageRewriterAvailable: ok })
    })
  },

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
      const job = await frameWeaverApi.createJob({
        client_id: client.clientId, worker_preference: get().workerPreference,
        kind: 'image', mode: imageParams.model, prompt: imageParams.prompt, settings: imageParams, workflow: wf,
      })
      set({ currentPromptId: job.id })
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
          model: item.mode === 'krea2' || item.mode === 'anime' ? item.mode : 'zimage',
          prompt: item.prompt,
          ...(s && {
            width: s.width,
            height: s.height,
            steps: s.steps,
            seed: s.seed,
            extraLora: s.extraLora ?? '',
            extraLoraStrength: s.extraLoraStrength ?? 1.0,
            cfg: s.cfg ?? state.imageParams.cfg,
            negativePrompt: s.negativePrompt ?? state.imageParams.negativePrompt,
          }),
        },
      }))
    }
  },

  deleteOutput: async (item) => {
    const subdir = item.kind === 'video' ? 'video' : item.mode
    const ok = await client.deleteOutput(subdir, item.filename)
    if (!ok) {
      set({ error: '削除に失敗しました(カスタムノードの再起動が必要な場合があります)' })
      return
    }
    set((s) => {
      const history = s.history.filter((h) => h.filename !== item.filename)
      return {
        history,
        detailItem: s.detailItem?.filename === item.filename ? null : s.detailItem,
      }
    })
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
      const paramsWithSources = { ...params, images: sources.map((source) => source.name) }
      const wf = patchWorkflow(paramsWithSources)
      const job = await frameWeaverApi.createJob({
        client_id: client.clientId, worker_preference: get().workerPreference,
        kind: 'video', mode: params.mode, prompt: params.prompt, settings: paramsWithSources, workflow: wf,
      })
      set({ currentPromptId: job.id })
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  stop: async () => {
    const { currentPromptId } = get()
    if (!currentPromptId) return
    try {
      const job = await frameWeaverApi.cancelJob(currentPromptId)
      if (job.status === 'cancelled') {
        set({ status: 'idle', progress: null, currentPromptId: null })
      } else {
        set({ status: job.status === 'queued' ? 'queued' : 'running', progress: null })
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
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
  useGenerationStore.setState({
    status: 'done',
    videoUrl: url,
    resultKind: currentKind,
    history: [item, ...history.filter((existing) => existing.promptId !== promptId)],
    progress: null,
  })
}

// WebSocketイベント → ストア反映
client.onEvent((ev) => {
  const state = useGenerationStore.getState()
  switch (ev.type) {
    case 'status':
      if (ev.message === 'connected') {
        useGenerationStore.setState({ wsConnected: true })
        void useGenerationStore.getState().refreshCapability()
        void client.getLoraMeta().then((loraMeta) => useGenerationStore.setState({ loraMeta }))
        void rewriterInstalled().then((ok) => useGenerationStore.setState({ rewriterAvailable: ok }))
        const imageModel = useGenerationStore.getState().imageParams.model
        void imageRewriterInstalled(imageModel).then((ok) => {
          if (useGenerationStore.getState().imageParams.model === imageModel) {
            useGenerationStore.setState({ imageRewriterAvailable: ok })
          }
        })
      }
      if (ev.message === 'disconnected') useGenerationStore.setState({ wsConnected: false })
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

// プロンプト下書きの永続化(リロードしても消えないように変更のたび保存)
useGenerationStore.subscribe((s, prev) => {
  if (s.params.prompt !== prev.params.prompt) {
    saveDraft(localStorage, DRAFT_KEYS.videoPrompt, s.params.prompt)
  }
  if (s.imageParams.prompt !== prev.imageParams.prompt) {
    saveDraft(localStorage, DRAFT_KEYS.imagePrompt, s.imageParams.prompt)
  }
})

// プロンプト下書きの永続化(リロードしても消えないように変更のたび保存)
useGenerationStore.subscribe((s, prev) => {
  if (s.params.prompt !== prev.params.prompt) {
    saveDraft(localStorage, DRAFT_KEYS.videoPrompt, s.params.prompt)
  }
  if (s.imageParams.prompt !== prev.imageParams.prompt) {
    saveDraft(localStorage, DRAFT_KEYS.imagePrompt, s.imageParams.prompt)
  }
})

// VRAMだけを軽量監視。モデル在庫は接続時または手動更新時に取得する。
const vramPoller = createAdaptivePoller({
  poll: async () => {
    const stats = await client.systemStats()
    if (stats) {
      useGenerationStore.setState((state) => ({
        vram: { total: stats.vramTotal, free: stats.vramFree },
        connected: true,
        capability: state.capability
          ? {
              ...state.capability,
              capturedAt: new Date().toISOString(),
              status: state.capability.errors.length > 0 ? 'degraded' : 'ready',
              devices: state.capability.devices.length > 0
                ? state.capability.devices.map((device, index) => index === 0
                    ? { ...device, vramTotal: stats.vramTotal, vramFree: stats.vramFree }
                    : device)
                : state.capability.devices,
            }
          : null,
      }))
      return
    }
    useGenerationStore.setState((state) => ({
      connected: false,
      capability: state.capability ? { ...state.capability, status: 'stale' } : null,
    }))
  },
  delay: () => pollDelay(
    useGenerationStore.getState().status,
    typeof document === 'undefined' ? 'visible' : document.visibilityState,
  ),
})
vramPoller.start()

void frameWeaverApi.listJobs()
  .then((jobs) => {
    clearLegacyHistory()
    useGenerationStore.setState({ history: jobs.map(historyFromJob) })
  })
  .catch(() => {
    // API が一時的に利用できない間だけ、初期化時に読んだ旧履歴を表示し続ける。
  })

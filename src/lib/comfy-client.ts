import type { LoraMetaMap, WorkflowJson } from './types'
import { collectNodeCapability } from './capability-collector'
import type { NodeCapabilitySnapshot } from './model-capability'

export interface ProgressEvent {
  type: 'status' | 'progress' | 'executing' | 'executed' | 'error' | 'preview'
  /** progress: 現在ステップ / 全ステップ */
  value?: number
  max?: number
  promptId?: string
  nodeId?: string | null
  message?: string
  /** preview: バイナリフレームのblob URL */
  previewUrl?: string
  queueRemaining?: number
}

export interface HistoryOutput {
  filename: string
  subfolder: string
  type: string
}

/** クライアントIDを生成。crypto.randomUUID はセキュアコンテキスト(HTTPS/localhost)限定で、
 * LAN内のIP+HTTPアクセスでは undefined になるため、非セキュア環境向けフォールバックを持つ。 */
function makeClientId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16)
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** ComfyUI REST + WebSocket の薄いクライアント */
export class ComfyClient {
  readonly baseUrl: string
  readonly clientId: string
  private ws: WebSocket | null = null
  private listeners = new Set<(ev: ProgressEvent) => void>()
  private lastPreviewUrl: string | null = null

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.clientId = makeClientId()
  }

  onEvent(cb: (ev: ProgressEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(ev: ProgressEvent) {
    for (const cb of this.listeners) cb(ev)
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/ws?clientId=${this.clientId}`
    this.ws = new WebSocket(wsUrl)
    this.ws.binaryType = 'arraybuffer'
    this.ws.onmessage = (msg) => this.handleMessage(msg)
    this.ws.onclose = () => {
      this.emit({ type: 'status', message: 'disconnected' })
      // 3秒後に自動再接続
      setTimeout(() => this.connect(), 3000)
    }
    this.ws.onopen = () => this.emit({ type: 'status', message: 'connected' })
  }

  private handleMessage(msg: MessageEvent) {
    if (msg.data instanceof ArrayBuffer) {
      // バイナリ = 生成中プレビュー画像。先頭8バイトはイベント種別+画像タイプのヘッダ
      const view = new DataView(msg.data)
      const eventType = view.getUint32(0)
      if (eventType === 1) {
        const imageType = view.getUint32(4)
        const mime = imageType === 2 ? 'image/png' : 'image/jpeg'
        const blob = new Blob([msg.data.slice(8)], { type: mime })
        if (this.lastPreviewUrl) URL.revokeObjectURL(this.lastPreviewUrl)
        this.lastPreviewUrl = URL.createObjectURL(blob)
        this.emit({ type: 'preview', previewUrl: this.lastPreviewUrl })
      }
      return
    }
    try {
      const data = JSON.parse(msg.data as string) as { type: string; data?: Record<string, unknown> }
      const d = data.data ?? {}
      switch (data.type) {
        case 'status': {
          const execInfo = (d['status'] as { exec_info?: { queue_remaining?: number } } | undefined)?.exec_info
          this.emit({ type: 'status', queueRemaining: execInfo?.queue_remaining })
          break
        }
        case 'progress':
          this.emit({
            type: 'progress',
            value: d['value'] as number,
            max: d['max'] as number,
            promptId: d['prompt_id'] as string,
          })
          break
        case 'executing':
          this.emit({
            type: 'executing',
            nodeId: d['node'] as string | null,
            promptId: d['prompt_id'] as string,
          })
          break
        case 'executed':
          this.emit({ type: 'executed', nodeId: d['node'] as string, promptId: d['prompt_id'] as string })
          break
        case 'execution_error':
          this.emit({ type: 'error', promptId: d['prompt_id'] as string, message: String(d['exception_message'] ?? '不明なエラー') })
          break
        default:
          break
      }
    } catch {
      // JSONでないテキストは無視
    }
  }

  /** ワークフローを投入して prompt_id を返す */
  async submit(workflow: WorkflowJson): Promise<string> {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string }; node_errors?: Record<string, unknown> } | null
      const nodeErrors = body?.node_errors ? ` node_errors: ${JSON.stringify(body.node_errors)}` : ''
      throw new Error(`生成リクエスト失敗 (${res.status}): ${body?.error?.message ?? res.statusText}${nodeErrors}`)
    }
    const json = (await res.json()) as { prompt_id: string }
    return json.prompt_id
  }

  async uploadImage(file: File): Promise<string> {
    const form = new FormData()
    form.append('image', file)
    form.append('type', 'input')
    form.append('overwrite', 'false')
    const res = await fetch(`${this.baseUrl}/upload/image`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`画像アップロード失敗 (${res.status})`)
    const json = (await res.json()) as { name: string; subfolder: string }
    return json.subfolder ? `${json.subfolder}/${json.name}` : json.name
  }

  /** 出力フォルダをエクスプローラーで開く(カスタムノード frameweaver_openfolder が必要) */
  async openOutputFolder(subdir: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/frameweaver/open_output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** output/<subdir>(video/zimage/krea2)内のメディアファイル一覧を新しい順で取得。
   * prompt はファイル埋め込みワークフローから復元したもの(旧版アドオンでは undefined) */
  async listOutput(subdir: string): Promise<{ filename: string; mtime: number; prompt?: string | null }[]> {
    try {
      const res = await fetch(`${this.baseUrl}/frameweaver/list_output?subdir=${encodeURIComponent(subdir)}`)
      if (!res.ok) return []
      const json = (await res.json()) as { files?: { filename: string; mtime: number; prompt?: string | null }[] }
      return json.files ?? []
    } catch {
      return []
    }
  }

  /** 出力フォルダの生成物を1件削除(カスタムノード frameweaver_openfolder が必要) */
  async deleteOutput(subdir: string, filename: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/frameweaver/delete_output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir, filename }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async freeMemory(): Promise<void> {
    await fetch(`${this.baseUrl}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    })
  }

  /** 完了したジョブの動画出力(SaveVideoノードの出力)を取得 */
  async fetchOutputs(promptId: string): Promise<HistoryOutput[]> {
    const res = await fetch(`${this.baseUrl}/history/${promptId}`)
    if (!res.ok) return []
    const json = (await res.json()) as Record<string, { outputs?: Record<string, Record<string, unknown>> }>
    const entry = json[promptId]
    if (!entry?.outputs) return []
    const outputs: HistoryOutput[] = []
    for (const nodeOutput of Object.values(entry.outputs)) {
      for (const value of Object.values(nodeOutput)) {
        if (!Array.isArray(value)) continue
        for (const item of value) {
          const it = item as Partial<HistoryOutput>
          if (it.filename) {
            outputs.push({ filename: it.filename, subfolder: it.subfolder ?? '', type: it.type ?? 'output' })
          }
        }
      }
    }
    return outputs
  }

  viewUrl(output: HistoryOutput, promptId?: string): string {
    const params = new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder,
      type: output.type,
    })
    if (promptId) params.set('prompt_id', promptId)
    return `${this.baseUrl}/view?${params}`
  }

  /** 選択可能な LoRA ファイル名一覧を取得 */
  async getLoraList(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/object_info/LoraLoaderModelOnly`)
      if (!res.ok) return []
      const json = (await res.json()) as Record<string, { input?: { required?: { lora_name?: [string[]] } } }>
      return json['LoraLoaderModelOnly']?.input?.required?.lora_name?.[0] ?? []
    } catch {
      return []
    }
  }

  /** 完了ジョブのテキスト出力(PreviewAny等の ui.text)を取得。無ければ null */
  async fetchTextOutput(promptId: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/history/${promptId}`)
    if (!res.ok) return null
    const json = (await res.json()) as Record<string, { outputs?: Record<string, { text?: string[] }> }>
    const entry = json[promptId]
    if (!entry?.outputs) return null
    for (const nodeOutput of Object.values(entry.outputs)) {
      const t = nodeOutput.text
      if (Array.isArray(t) && typeof t[0] === 'string' && t[0].trim()) return t[0]
    }
    return null
  }

  /** Civitai由来のLoRA説明メタ(名前・トリガー・ジャンル等)を取得 */
  async getLoraMeta(): Promise<LoraMetaMap> {
    try {
      const res = await fetch(`${this.baseUrl}/frameweaver/lora_meta`)
      if (!res.ok) return {}
      const json = (await res.json()) as { meta?: LoraMetaMap }
      return json.meta ?? {}
    } catch {
      return {}
    }
  }

  /** 選択可能なCLIP/テキストエンコーダのファイル名一覧を取得(リライタ導入判定用) */
  async getClipList(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/object_info/CLIPLoader`)
      if (!res.ok) return []
      const json = (await res.json()) as Record<string, { input?: { required?: { clip_name?: [string[]] } } }>
      return json['CLIPLoader']?.input?.required?.clip_name?.[0] ?? []
    } catch {
      return []
    }
  }

  /** 選択可能なチェックポイント(SDXL等)ファイル名一覧を取得 */
  async getCheckpointList(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/object_info/CheckpointLoaderSimple`)
      if (!res.ok) return []
      const json = (await res.json()) as Record<string, { input?: { required?: { ckpt_name?: [string[]] } } }>
      return json['CheckpointLoaderSimple']?.input?.required?.ckpt_name?.[0] ?? []
    } catch {
      return []
    }
  }

  async systemStats(): Promise<{ vramTotal: number; vramFree: number } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, { signal: AbortSignal.timeout(2_000) })
      if (!res.ok) return null
      const json = (await res.json()) as { devices?: Array<{ vram_total?: number; vram_free?: number }> }
      const dev = json.devices?.[0]
      if (!dev) return null
      return { vramTotal: dev.vram_total ?? 0, vramFree: dev.vram_free ?? 0 }
    } catch {
      return null
    }
  }

  async capabilities(): Promise<NodeCapabilitySnapshot> {
    return collectNodeCapability(this.baseUrl)
  }
}

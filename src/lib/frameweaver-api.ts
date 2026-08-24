import type { WorkflowJson } from './types'

const OWNER_STORAGE_KEY = 'frameweaver-owner-id'
const LEGACY_HISTORY_STORAGE_KEY = 'frameweaver-history'

export type FrameWeaverJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'orphaned'

export interface FrameWeaverJob {
  id: string
  owner_id: string
  worker_id?: string | null
  kind: 'image' | 'video'
  mode: string
  status: FrameWeaverJobStatus
  prompt: string
  settings_json: string
  output_json: string | null
  error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

export interface CreateJobRequest {
  client_id: string
  kind: 'image' | 'video'
  mode: string
  prompt: string
  settings: object
  workflow: WorkflowJson
  worker_preference?: { mode: 'auto' } | { mode: 'explicit'; worker_id: string }
}

function newOwnerId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16)
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16)
  })
}

export function getOwnerId(): string {
  const existing = localStorage.getItem(OWNER_STORAGE_KEY)
  if (existing) return existing
  const ownerId = newOwnerId()
  localStorage.setItem(OWNER_STORAGE_KEY, ownerId)
  return ownerId
}

/** 移行中の旧ブラウザ履歴は、API履歴を読み込むまでの一度だけ表示する。 */
export function takeLegacyHistory<T = unknown>(): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_HISTORY_STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value as T[] : []
  } catch {
    return []
  }
}

export function clearLegacyHistory(): void {
  localStorage.removeItem(LEGACY_HISTORY_STORAGE_KEY)
}

export class FrameWeaverApi {
  private headers(): HeadersInit {
    return { 'X-FrameWeaver-Owner': getOwnerId() }
  }

  private async json<T>(response: Response): Promise<T> {
    if (response.ok) return response.json() as Promise<T>
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `ジョブ API リクエスト失敗 (${response.status})`)
  }

  async createJob(request: CreateJobRequest): Promise<FrameWeaverJob> {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    return this.json<FrameWeaverJob>(response)
  }

  async listJobs(limit = 50): Promise<FrameWeaverJob[]> {
    const response = await fetch(`/api/jobs?limit=${limit}`, { headers: this.headers() })
    return (await this.json<{ jobs: FrameWeaverJob[] }>(response)).jobs
  }

  async cancelJob(id: string): Promise<FrameWeaverJob> {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    return this.json<FrameWeaverJob>(response)
  }
}

export const frameWeaverApi = new FrameWeaverApi()

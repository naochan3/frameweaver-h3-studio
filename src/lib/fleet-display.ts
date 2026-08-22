export type WorkerDisplayInput = {
  hostStatus: 'unknown' | 'online' | 'offline'
  comfyStatus: 'unknown' | 'online' | 'offline'
  stale: boolean
}

export type WorkerDisplayState = {
  label: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
}

export function getWorkerDisplayState(sample: WorkerDisplayInput): WorkerDisplayState {
  if (sample.hostStatus === 'unknown') return { label: '確認中', tone: 'neutral' }
  if (sample.hostStatus === 'offline') return { label: 'PC未接続', tone: 'danger' }
  if (sample.stale) return { label: 'データ古い', tone: 'warning' }
  if (sample.comfyStatus === 'online') return { label: 'Comfy稼働', tone: 'success' }
  if (sample.comfyStatus === 'offline') return { label: 'Comfy停止', tone: 'warning' }
  return { label: 'Comfy不明', tone: 'neutral' }
}

export function formatSampleAge(ageMs: number | null): string {
  if (ageMs === null) return '未取得'
  if (ageMs < 1_000) return 'たった今'
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}秒前`
  return `${Math.floor(ageMs / 60_000)}分前`
}

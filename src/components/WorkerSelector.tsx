import { useEffect, useMemo, useState } from 'react'
import { useGenerationStore, type WorkerPreference } from '../store/generation'

interface Worker {
  id: string
  label: string
  online: boolean
  stale: boolean
  free_vram_mb: number
}

const order = ['rtx5060ti', 'rtx3070', 'rtx2070', 'rtx4090']

export function WorkerSelector() {
  const preference = useGenerationStore((state) => state.workerPreference)
  const setPreference = useGenerationStore((state) => state.setWorkerPreference)
  const [workers, setWorkers] = useState<Worker[]>([])

  useEffect(() => {
    let active = true
    const refresh = async () => {
      const response = await fetch('/api/workers', { credentials: 'same-origin' })
      if (!response.ok) throw new Error('GPU一覧を取得できません')
      const body = await response.json() as { workers: Worker[] }
      if (active) setWorkers(body.workers)
    }
    void refresh().catch(() => { if (active) setWorkers([]) })
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const sorted = useMemo(() => [...workers].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)), [workers])
  const value = preference.mode === 'auto' ? 'auto' : preference.worker_id
  return (
    <label className="flex items-center gap-2 text-xs font-semibold text-ink-600">
      GPU
      <select
        aria-label="生成GPU"
        className="min-h-11 rounded-lg border border-cream-200 bg-white px-2"
        value={value}
        onChange={(event) => setPreference(event.target.value === 'auto' ? { mode: 'auto' } : { mode: 'explicit', worker_id: event.target.value } as WorkerPreference)}
      >
        <option value="auto">Auto（推奨）</option>
        {sorted.map((worker) => {
          const unavailable = !worker.online || worker.stale
          const detail = unavailable ? 'オフライン' : `空き ${(worker.free_vram_mb / 1024).toFixed(1)} GB`
          return <option key={worker.id} value={worker.id} disabled={unavailable}>{worker.label} — {detail}</option>
        })}
      </select>
    </label>
  )
}

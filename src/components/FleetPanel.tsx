import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { formatSampleAge, getWorkerDisplayState } from '../lib/fleet-display'

type Sample = {
  worker: string
  hostStatus: 'unknown' | 'online' | 'offline'
  comfyStatus: 'unknown' | 'online' | 'offline'
  host?: string
  vramTotal?: number
  vramUsed?: number
  peakVramUsed?: number
  utilization?: number
  powerDraw?: number
  powerLimit?: number
  temperature?: number
  pstate?: string
  powerPlan?: string
  ageMs: number | null
  stale: boolean
  sampleIntervalMs?: number
}

type Snapshot = { samples: Sample[]; at: string; collecting: boolean }

const labels: Record<string, { name: string; role: string; url?: string }> = {
  rtx4090: { name: 'RTX 4090', role: 'FrameWeaver H3 / 重量級' },
  rtx5060ti: { name: 'RTX 5060 Ti', role: 'SDXL 画像', url: 'https://rtx5060ti.tail37947a.ts.net:8188/' },
  nicolas2025: { name: 'RTX 3070', role: 'Wan 2.1 軽量動画', url: 'https://nicolas2025.tail37947a.ts.net:8188/' },
  nicoyuri: { name: 'RTX 2070', role: '軽量ワーカー（準備中）' },
}

const initialSamples: Sample[] = Object.keys(labels).map((worker) => ({
  worker,
  hostStatus: 'unknown',
  comfyStatus: 'unknown',
  ageMs: null,
  stale: true,
}))

const toneClasses = {
  neutral: 'bg-cream-100 text-ink-500',
  success: 'bg-green-50 text-green-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-600',
}

function gib(mib: number): string {
  return (mib / 1024).toFixed(1)
}

function FleetCard({ sample }: { sample: Sample }) {
  const label = labels[sample.worker] ?? { name: sample.host ?? sample.worker, role: 'GPUワーカー' }
  const state = getWorkerDisplayState(sample)
  const hasMetrics = sample.vramTotal !== undefined && sample.vramUsed !== undefined
  const used = sample.vramUsed ?? 0
  const total = sample.vramTotal ?? 0
  const width = total > 0 ? Math.min(100, used / total * 100) : 0

  return <article className={`rounded-lg border p-3 ${sample.stale ? 'border-amber-200 bg-amber-50/30' : 'border-cream-200 bg-white'}`}>
    <div className="flex items-start justify-between gap-2">
      <div><h3 className="font-semibold text-sm">{label.name}</h3><p className="mt-1 text-xs text-ink-400">{label.role}</p></div>
      <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${toneClasses[state.tone]}`}>{state.label}</span>
    </div>
    {hasMetrics ? <>
      <div className="mt-3 flex items-baseline justify-between gap-2 text-xs tabular-nums">
        <span className="font-semibold text-ink-700">GPU全体 {gib(used)} / {gib(total)} GiB</span>
        <span className="text-ink-400">{width.toFixed(0)}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-cream-200"><div className="h-full bg-accent-500 transition-[width]" style={{ width: `${width}%` }} /></div>
      <p className="mt-2 text-xs tabular-nums text-ink-600">
        {sample.utilization ?? 0}% · {sample.powerDraw?.toFixed(0) ?? '--'}W / {sample.powerLimit ?? '--'}W · {sample.temperature ?? '--'}°C
      </p>
      <p className="mt-1 text-[11px] tabular-nums text-ink-400">直近60秒の採取最大 {gib(sample.peakVramUsed ?? used)} GiB · {(sample.sampleIntervalMs ?? 0) / 1000}秒間隔</p>
      <p className="mt-1 text-[11px] text-ink-400">{sample.pstate ?? '--'} · 電源: {sample.powerPlan || '--'}</p>
    </> : <p className="mt-3 text-xs text-ink-400">GPU情報を取得しています…</p>}
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-cream-100 pt-2">
      <span className="text-[10px] text-ink-400">更新 {formatSampleAge(sample.ageMs)}{sample.stale && hasMetrics ? '（最終正常値）' : ''}</span>
      {label.url ? <a className="text-xs font-semibold text-accent-600" href={label.url} target="_blank" rel="noreferrer">ComfyUIを開く →</a> : null}
    </div>
  </article>
}

export function FleetPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ samples: initialSamples, at: '', collecting: true })
  const [error, setError] = useState(false)
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 640px)').matches)
  const [expanded, setExpanded] = useState(desktop)
  const detailsId = useId()
  const inFlight = useRef(false)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await fetch('/api/fleet', { cache: 'no-store', signal: AbortSignal.timeout(3_000) })
      if (!res.ok) throw new Error(`fleet telemetry ${res.status}`)
      const json = await res.json() as Snapshot
      if (mounted.current) {
        setSnapshot(json)
        setError(false)
      }
    } catch {
      if (mounted.current) setError(true)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const initial = window.setTimeout(() => { void refresh() }, 0)
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 2_000)
    return () => {
      mounted.current = false
      window.clearTimeout(initial)
      window.clearInterval(id)
    }
  }, [refresh])

  useEffect(() => {
    const media = window.matchMedia('(min-width: 640px)')
    const updateDisclosure = (event: MediaQueryListEvent) => {
      setDesktop(event.matches)
      setExpanded(event.matches)
    }
    media.addEventListener('change', updateDisclosure)
    return () => media.removeEventListener('change', updateDisclosure)
  }, [])

  const onlineCount = snapshot.samples.filter((sample) => sample.hostStatus === 'online').length
  const usedVram = snapshot.samples.reduce((total, sample) => total + (sample.vramUsed ?? 0), 0)
  const hasStaleVram = snapshot.samples.some((sample) => sample.stale && sample.vramUsed !== undefined)
  const vramSummary = `使用 VRAM ${gib(usedVram)} GiB${hasStaleVram ? '（古い値を含む）' : ''}`
  const ages = snapshot.samples.flatMap((sample) => sample.ageMs === null ? [] : [sample.ageMs])
  const oldestAge = ages.length === 0 ? null : Math.max(...ages)
  const showDetails = desktop || expanded

  return <section className="rounded-xl border border-cream-200 bg-white p-4" aria-labelledby="fleet-panel-title">
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 id="fleet-panel-title" className="font-bold">GPU ワーカー監視</h2>
        <p className="text-xs text-ink-400">4090は2秒、遠隔GPUは15秒ごとにサーバーで採取 · 画面は2秒ごとにキャッシュ更新</p>
        {error ? <p role="alert" className="mt-1 text-xs font-semibold text-red-600">監視APIに接続できません。表示は最終正常値です。</p> : null}
      </div>
      <button onClick={() => void refresh()} className="min-h-11 rounded-lg border border-cream-200 px-3 py-2 text-xs">再読込</button>
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-ink-600" aria-live="polite">
      <span>オンライン {onlineCount} / {snapshot.samples.length}</span>
      <span aria-label={vramSummary}>{vramSummary}</span>
      <span>最古 {formatSampleAge(oldestAge)}</span>
    </div>
    {!desktop ? <button
      type="button"
      aria-controls={detailsId}
      aria-expanded={expanded}
      aria-label={`GPU ワーカー監視を${expanded ? '非表示' : '表示'}`}
      onClick={() => setExpanded((visible) => !visible)}
      className="mt-3 min-h-11 rounded-lg border border-cream-200 px-3 py-2 text-xs font-semibold text-ink-600"
    >
      {expanded ? '詳細を隠す' : '詳細を表示'}
    </button> : null}
    {showDetails ? <div id={detailsId} className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{snapshot.samples.map((sample) => <FleetCard key={sample.worker} sample={sample} />)}</div> : null}
    {showDetails ? <p className="mt-3 text-xs text-ink-400">これは監視表示です。FrameWeaver H3の生成先はRTX 4090固定で、カード操作では切り替わりません。</p> : null}
  </section>
}

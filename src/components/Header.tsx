import { client, useGenerationStore } from '../store/generation'

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

export function Header() {
  const connected = useGenerationStore((s) => s.connected)
  const vram = useGenerationStore((s) => s.vram)
  const queueRemaining = useGenerationStore((s) => s.queueRemaining)
  const stop = useGenerationStore((s) => s.stop)
  const setGuideOpen = useGenerationStore((s) => s.setGuideOpen)

  const vramUsed = vram ? vram.total - vram.free : 0
  const vramPct = vram && vram.total > 0 ? Math.min(100, (vramUsed / vram.total) * 100) : 0

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-cream-200 bg-white px-3 py-3 sm:gap-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-500 font-bold text-white">F</span>
        <h1 className="text-sm font-bold tracking-tight sm:text-lg">FrameWeaver H3 Studio</h1>
      </div>

      <div className="flex items-center gap-1.5 rounded-full bg-cream-100 px-3 py-1 text-xs text-ink-600">
        <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-400'}`} />
        {connected ? 'ComfyUI 接続済み' : 'ComfyUI 未接続'}
        {queueRemaining > 0 && <span className="ml-1 font-semibold text-accent-600">キュー {queueRemaining}</span>}
      </div>

      <div className="flex w-full flex-wrap items-center gap-2 xl:ml-auto xl:w-auto xl:gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-cream-200 px-3 py-1.5">
          <span className="text-[10px] font-bold tracking-wider text-ink-400">COMFY使用</span>
          <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-cream-200 sm:block">
            <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${vramPct}%` }} />
          </div>
          <span className="text-xs tabular-nums text-ink-600">
            {vram ? `${formatGb(vramUsed)} / ${formatGb(vram.total)} GB` : '--'}
          </span>
        </div>
        <button
          onClick={() => void stop()}
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100"
        >
          ■ 停止
        </button>
        <button
          onClick={() => setGuideOpen(true)}
          className="rounded-lg border border-accent-400 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-accent-600 hover:bg-orange-100"
        >
          使い方
        </button>
        <a
          href="/auth/logout"
          className="rounded-lg border border-cream-200 px-3 py-1.5 text-xs font-semibold text-ink-600 hover:bg-cream-100"
        >
          ログアウト
        </a>
        <span className="hidden text-xs text-ink-400 2xl:inline">{client.baseUrl}</span>
      </div>
    </header>
  )
}

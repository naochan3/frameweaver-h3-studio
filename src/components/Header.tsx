import { useGenerationStore } from '../store/generation'
import { ThemePicker } from './ThemePicker'

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

export function Header() {
  const connected = useGenerationStore((s) => s.connected)
  const wsConnected = useGenerationStore((s) => s.wsConnected)
  const vram = useGenerationStore((s) => s.vram)
  const queueRemaining = useGenerationStore((s) => s.queueRemaining)
  const stop = useGenerationStore((s) => s.stop)
  const freeVram = useGenerationStore((s) => s.freeVram)
  const refreshCapability = useGenerationStore((s) => s.refreshCapability)
  const openOutputFolder = useGenerationStore((s) => s.openOutputFolder)
  const setGuideOpen = useGenerationStore((s) => s.setGuideOpen)

  const vramUsed = vram ? vram.total - vram.free : 0
  const vramPct = vram && vram.total > 0 ? Math.min(100, (vramUsed / vram.total) * 100) : 0
  const connectionLabel = !connected ? '未接続' : wsConnected ? '接続済み' : 'APIのみ'
  const connectionDot = !connected ? 'bg-red-400' : wsConnected ? 'bg-green-500' : 'bg-amber-400'

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-cream-200 bg-white px-3 py-2 sm:gap-4 sm:px-5 sm:py-3">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-500 font-bold text-white sm:h-8 sm:w-8">F</span>
        <h1 className="text-base font-bold tracking-tight sm:text-lg">FrameWeaver H3 Studio</h1>
      </div>

      <div className="flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 text-xs text-ink-600">
        <span className={`h-2 w-2 rounded-full ${connectionDot}`} />
        <span className="hidden sm:inline">ComfyUI {connectionLabel}</span>
        <span className="sm:hidden">{connectionLabel}</span>
        {queueRemaining > 0 && <span className="ml-1 font-semibold text-accent-600">キュー {queueRemaining}</span>}
      </div>

      <ThemePicker />

      {/* 操作系: モバイルでは折り返して2段目に並ぶ。横スクロールは発生させない */}
      <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto sm:gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-cream-200 px-2.5 py-1.5">
          <span className="text-[10px] font-bold tracking-wider text-ink-400">VRAM</span>
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-cream-200 sm:w-24">
            <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${vramPct}%` }} />
          </div>
          <span className="text-xs tabular-nums text-ink-600">
            {vram ? `${formatGb(vramUsed)}/${formatGb(vram.total)}GB` : '--'}
          </span>
          <button
            type="button"
            onClick={() => void refreshCapability()}
            className="rounded px-1 text-ink-400 hover:bg-cream-100 hover:text-accent-600"
            title="GPU能力とモデル在庫を再診断"
            aria-label="GPU能力とモデル在庫を再診断"
          >
            ↻
          </button>
        </div>
        <button
          onClick={() => void stop()}
          className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100"
        >
          ■ 停止
        </button>
        <button
          onClick={() => void freeVram()}
          className="rounded-lg border border-cream-200 px-2.5 py-1.5 text-xs font-semibold text-ink-600 hover:bg-cream-100"
          title="モデルをアンロードしてVRAMを解放"
        >
          解放
        </button>
        <button
          onClick={() => void openOutputFolder('')}
          className="hidden rounded-lg border border-cream-200 px-2.5 py-1.5 text-xs font-semibold text-ink-600 hover:bg-cream-100 sm:block"
          title="生成物の保存フォルダをエクスプローラーで開く(PCのみ)"
        >
          出力フォルダ
        </button>
        <button
          onClick={() => setGuideOpen(true)}
          className="rounded-lg border border-accent-400 bg-orange-50 px-2.5 py-1.5 text-xs font-semibold text-accent-600 hover:bg-orange-100"
        >
          使い方
        </button>
      </div>
    </header>
  )
}

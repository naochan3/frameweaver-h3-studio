import { useEffect } from 'react'
import { useGenerationStore } from '../store/generation'

const MODE_LABEL: Record<string, string> = {
  text: 'Text',
  first: 'First',
  first_last: 'First+Last',
  last: 'Last',
  reference: 'Reference',
  video: '動画',
  zimage: 'Z-Image',
  krea2: 'Krea 2',
  anime: 'アニメ',
}

const TABS: { key: 'video' | 'zimage' | 'krea2' | 'anime'; label: string; sub: string }[] = [
  { key: 'video', label: '動画', sub: 'MiniMax H3' },
  { key: 'zimage', label: 'Z-Image', sub: '画像' },
  { key: 'krea2', label: 'Krea 2', sub: '画像' },
  { key: 'anime', label: 'アニメ', sub: 'Illustrious' },
]

export function HistoryPanel() {
  const historyTab = useGenerationStore((s) => s.historyTab)
  const setHistoryTab = useGenerationStore((s) => s.setHistoryTab)
  const folderItems = useGenerationStore((s) => s.folderItems)
  const folderLoading = useGenerationStore((s) => s.folderLoading)
  const connected = useGenerationStore((s) => s.connected)
  const openDetail = useGenerationStore((s) => s.openDetail)
  const sendImageToSource = useGenerationStore((s) => s.sendImageToSource)
  const openOutputFolder = useGenerationStore((s) => s.openOutputFolder)
  const reloadFolder = useGenerationStore((s) => s.reloadFolder)

  // 接続後に一度読み込む(接続イベントを取りこぼした場合の保険)
  useEffect(() => {
    if (connected && folderItems.length === 0) void reloadFolder()
  }, [connected]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">RECENT</p>
          <h2 className="text-lg font-bold">最近の生成</h2>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => void reloadFolder()}
            className="rounded-lg border border-cream-200 px-3 py-1 text-xs text-ink-600 hover:bg-cream-100"
          >
            更新
          </button>
          <button
            onClick={() => void openOutputFolder(historyTab)}
            className="rounded-lg border border-cream-200 px-3 py-1 text-xs text-ink-600 hover:bg-cream-100"
          >
            フォルダを開く
          </button>
        </div>
      </div>

      {/* 分類タブ */}
      <div className="mb-3 flex gap-1 rounded-xl bg-cream-100 p-1">
        {TABS.map((t) => {
          const active = historyTab === t.key
          return (
            <button
              key={t.key}
              onClick={() => setHistoryTab(t.key)}
              className={`flex flex-1 flex-col items-center rounded-lg px-2 py-1.5 transition-colors ${
                active ? 'bg-white shadow-sm' : 'text-ink-600 hover:bg-white/50'
              }`}
            >
              <span className={`text-xs font-bold ${active ? 'text-accent-600' : 'text-ink-600'}`}>{t.label}</span>
              <span className="text-[9px] tracking-wider text-ink-400">{t.sub}</span>
            </button>
          )
        })}
      </div>

      {folderLoading ? (
        <p className="py-4 text-center text-xs text-ink-400">読み込み中…</p>
      ) : folderItems.length === 0 ? (
        <p className="py-4 text-center text-xs text-ink-400">この分類にはまだ生成物がありません</p>
      ) : (
        <ul className="max-h-96 space-y-2 overflow-y-auto">
          {folderItems.map((item) => (
            <li
              key={item.filename}
              onClick={() => openDetail(item)}
              className="flex cursor-pointer gap-3 rounded-xl border border-cream-200 p-2 transition-colors hover:border-accent-400 hover:bg-cream-50"
              title="クリックで詳細を表示"
            >
              {item.kind === 'image' ? (
                <img src={item.videoUrl} alt={item.filename} className="h-16 w-28 shrink-0 rounded-lg bg-black object-cover" />
              ) : (
                <video src={item.videoUrl} muted preload="metadata" className="h-16 w-28 shrink-0 rounded-lg bg-black object-cover" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-cream-100 px-1.5 py-0.5 text-[10px] font-bold text-ink-600">{MODE_LABEL[item.mode] ?? item.mode}</span>
                  {item.nsfw && <span className="rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-bold text-pink-600">NSFW</span>}
                  <span className="truncate text-[10px] text-ink-400">{item.filename}</span>
                </div>
                {item.prompt ? (
                  <p className="mt-1 truncate text-xs text-ink-600" title={item.prompt}>{item.prompt}</p>
                ) : (
                  <p className="mt-1 text-xs text-ink-400">{new Date(item.createdAt).toLocaleString('ja-JP')}</p>
                )}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] font-semibold text-accent-600">詳細を見る →</span>
                  {item.kind === 'image' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void sendImageToSource(item.videoUrl)
                      }}
                      className="text-[11px] font-semibold text-ink-900 hover:underline"
                      title="この画像を動画生成の参照素材に送る"
                    >
                      動画の素材にする →
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

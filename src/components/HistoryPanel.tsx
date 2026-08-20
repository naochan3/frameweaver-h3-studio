import { useGenerationStore } from '../store/generation'

const MODE_LABEL: Record<string, string> = {
  text: 'Text',
  first: 'First',
  first_last: 'First+Last',
  last: 'Last',
  reference: 'Reference',
  zimage: 'Z-Image',
  krea2: 'Krea 2',
}

export function HistoryPanel() {
  const history = useGenerationStore((s) => s.history)
  const clearHistory = useGenerationStore((s) => s.clearHistory)
  const sendImageToSource = useGenerationStore((s) => s.sendImageToSource)
  const openDetail = useGenerationStore((s) => s.openDetail)

  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">RECENT</p>
          <h2 className="text-lg font-bold">最近の生成</h2>
        </div>
        {history.length > 0 && (
          <button onClick={clearHistory} className="rounded-lg border border-cream-200 px-3 py-1 text-xs text-ink-600 hover:bg-cream-100">
            履歴を消去
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <p className="py-4 text-center text-xs text-ink-400">まだ生成履歴がありません</p>
      ) : (
        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {history.map((item) => (
            <li
              key={item.promptId}
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
                  <span className="rounded bg-cream-100 px-1.5 py-0.5 text-[10px] font-bold text-ink-600">{MODE_LABEL[item.mode]}</span>
                  {item.nsfw && <span className="rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-bold text-pink-600">NSFW</span>}
                  <span className="text-[10px] text-ink-400">{new Date(item.createdAt).toLocaleString('ja-JP')}</span>
                </div>
                <p className="mt-1 truncate text-xs text-ink-600" title={item.prompt}>{item.prompt}</p>
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

import { useMemo, useState } from 'react'
import { useBodyScrollLock } from '../lib/useBodyScrollLock'
import { useGenerationStore } from '../store/generation'

/** ジャンルごとの「いつ使うか」の日本語説明 */
const GENRE_INFO: Record<string, string> = {
  'キャラ/人物': '特定のキャラ・人物を出したいとき',
  画風: '絵柄・タッチ・作風を変えたいとき',
  NSFW表現: '性的表現を追加・強化したいとき',
  'ポーズ/構図': '姿勢・アングル・構図を指定したいとき',
  品質補正: 'ディテール・肌質などを底上げしたいとき',
  その他: '',
}

/** ベースモデルの日本語ラベル(どのモデルで使えるか) */
const BASE_LABEL: Record<string, string> = {
  illustrious: 'アニメ(Illustrious)',
  noobai: 'アニメ(NoobAI)',
  pony: 'アニメ(Pony)',
  sdxl10: 'アニメ(SDXL)',
  anima: 'アニメ',
  zimageturbo: 'Z-Image',
  krea2: 'Krea 2',
  qwen: 'Qwen(Krea 2で試用)',
}

export function LoraCatalog() {
  const open = useGenerationStore((s) => s.loraCatalogOpen)
  const setOpen = useGenerationStore((s) => s.setLoraCatalogOpen)
  const loraMeta = useGenerationStore((s) => s.loraMeta)
  const applyLora = useGenerationStore((s) => s.applyLoraFromCatalog)
  const [q, setQ] = useState('')
  const [baseFilter, setBaseFilter] = useState('all')
  const [genreFilter, setGenreFilter] = useState('all')
  useBodyScrollLock(open)

  const entries = useMemo(() => Object.entries(loraMeta), [loraMeta])
  const bases = useMemo(() => [...new Set(entries.map(([k]) => k.split('/')[0]))].sort(), [entries])
  const genres = useMemo(() => [...new Set(entries.map(([, v]) => v.genre))].sort(), [entries])

  if (!open) return null

  const filtered = entries.filter(([key, v]) => {
    if (baseFilter !== 'all' && key.split('/')[0] !== baseFilter) return false
    if (genreFilter !== 'all' && v.genre !== genreFilter) return false
    if (q) {
      const t = `${v.name} ${v.desc} ${v.triggers.join(' ')} ${key}`.toLowerCase()
      if (!t.includes(q.toLowerCase())) return false
    }
    return true
  })

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/50 p-2 sm:p-4" onClick={() => setOpen(false)}>
      <div
        className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between border-b border-cream-200 p-4">
          <div>
            <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">LoRA CATALOG</p>
            <h2 className="text-lg font-bold">
              LoRAカタログ <span className="text-sm font-normal text-ink-400">{entries.length}件</span>
            </h2>
          </div>
          <button onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-ink-400 hover:bg-cream-100">
            閉じる
          </button>
        </div>

        {/* フィルタ */}
        <div className="flex flex-wrap items-center gap-2 border-b border-cream-100 p-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="名前・トリガー・説明で検索"
            className="min-w-40 flex-1 rounded-lg border border-cream-200 bg-cream-50 px-3 py-1.5 text-sm outline-none focus:border-accent-400"
          />
          <select value={baseFilter} onChange={(e) => setBaseFilter(e.target.value)} className="rounded-lg border border-cream-200 bg-cream-50 px-2 py-1.5 text-sm">
            <option value="all">全モデル</option>
            {bases.map((b) => (
              <option key={b} value={b}>{BASE_LABEL[b] ?? b}</option>
            ))}
          </select>
          <select value={genreFilter} onChange={(e) => setGenreFilter(e.target.value)} className="rounded-lg border border-cream-200 bg-cream-50 px-2 py-1.5 text-sm">
            <option value="all">全ジャンル</option>
            {genres.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
          <span className="text-xs text-ink-400">{filtered.length}件表示</span>
        </div>

        {/* グリッド */}
        {entries.length === 0 ? (
          <p className="p-8 text-center text-sm text-ink-400">
            LoRAのメタ情報がまだありません。ダウンロードが進むと自動で並びます。
          </p>
        ) : (
          <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-3 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map(([key, v]) => (
              <div key={key} className="flex flex-col overflow-hidden rounded-xl border border-cream-200 bg-white">
                <div className="relative aspect-[3/4] bg-cream-100">
                  {v.image ? (
                    <img src={v.image} alt={v.name} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-ink-400">画像なし</div>
                  )}
                  {v.nsfw && <span className="absolute left-1.5 top-1.5 rounded bg-pink-600/90 px-1.5 py-0.5 text-[10px] font-bold text-white">NSFW</span>}
                  <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">{v.genre}</span>
                </div>
                <div className="flex flex-1 flex-col p-2.5">
                  <p className="line-clamp-2 text-xs font-bold text-ink-900" title={v.name}>{v.name}</p>
                  <p className="mt-0.5 text-[10px] text-ink-400">{BASE_LABEL[key.split('/')[0]] ?? v.base}</p>
                  {GENRE_INFO[v.genre] && <p className="mt-1 text-[10px] leading-snug text-ink-500">{GENRE_INFO[v.genre]}</p>}
                  {v.triggers.length > 0 && (
                    <p className="mt-1 line-clamp-1 font-mono text-[10px] text-accent-600" title={v.triggers.join(', ')}>
                      trig: {v.triggers.join(', ')}
                    </p>
                  )}
                  <div className="mt-auto flex gap-1.5 pt-2">
                    <button
                      onClick={() => applyLora(key)}
                      className="flex-1 rounded-lg bg-accent-500 px-2 py-1.5 text-xs font-bold text-white hover:bg-accent-600"
                    >
                      使う
                    </button>
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-cream-200 px-2 py-1.5 text-xs font-semibold text-ink-600 hover:bg-cream-100"
                      title="Civitaiで詳しく見る"
                    >
                      詳細↗
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

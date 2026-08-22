import { useState } from 'react'
import { formatDuration } from '../lib/eta'
import { useGenerationStore } from '../store/generation'
import { useBodyScrollLock } from '../lib/useBodyScrollLock'

const MODE_LABEL: Record<string, string> = {
  text: 'Text(テキスト→動画)',
  first: 'First(開始画像→動画)',
  first_last: 'First+Last(2枚をつなぐ)',
  last: 'Last(終了画像→動画)',
  reference: 'Reference(参照→動画)',
  video: '動画(MiniMax H3)',
  zimage: 'Z-Image Turbo',
  krea2: 'Krea 2 Turbo',
  anime: 'アニメ(Illustrious)',
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-cream-100 py-1.5 text-sm last:border-0">
      <span className="w-24 shrink-0 font-semibold text-ink-400">{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink-900">{value}</span>
    </div>
  )
}

export function HistoryDetail() {
  const item = useGenerationStore((s) => s.detailItem)
  const closeDetail = useGenerationStore((s) => s.closeDetail)
  const applyHistorySettings = useGenerationStore((s) => s.applyHistorySettings)
  const sendImageToSource = useGenerationStore((s) => s.sendImageToSource)
  const [zoomed, setZoomed] = useState(false)
  useBodyScrollLock(item != null)

  if (!item) return null
  const s = item.settings

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={closeDetail}>
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl md:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        {/* メディア(モバイルは高さを抑えて詳細も見えるように) */}
        <div className="flex shrink-0 items-center justify-center bg-black p-2 md:w-1/2">
          {item.kind === 'image' ? (
            <img
              src={item.videoUrl}
              alt={item.filename}
              onClick={() => setZoomed(true)}
              className="max-h-[40vh] w-auto max-w-full cursor-zoom-in object-contain md:max-h-[84vh]"
              title="クリックで拡大"
            />
          ) : (
            <video
              src={item.videoUrl}
              controls
              autoPlay
              loop
              muted
              ref={(el) => {
                if (el) el.muted = true
              }}
              className="max-h-[40vh] w-auto max-w-full md:max-h-[84vh]"
            />
          )}
        </div>

        {/* 詳細 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">
                {item.kind === 'image' ? '画像の詳細' : '動画の詳細'}
              </p>
              <h2 className="text-lg font-bold">{MODE_LABEL[item.mode] ?? item.mode}</h2>
            </div>
            <button onClick={closeDetail} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-ink-400 hover:bg-cream-100">
              閉じる
            </button>
          </div>

          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-400">プロンプト</span>
              <button
                onClick={() => void navigator.clipboard?.writeText(item.prompt)}
                className="rounded border border-cream-200 px-2 py-0.5 text-[11px] font-semibold text-ink-600 hover:bg-cream-100"
              >
                コピー
              </button>
            </div>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-cream-200 bg-cream-50 p-3 text-sm leading-relaxed">
              {item.prompt}
            </p>
          </div>

          <div className="mb-4">
            <span className="text-xs font-semibold text-ink-400">設定</span>
            <div className="mt-1 rounded-lg border border-cream-200 px-3">
              {item.nsfw && <Row label="NSFW" value="ON(無検閲エンコーダ)" />}
              {s ? (
                <>
                  {s.durationSec !== undefined && <Row label="生成時間" value={formatDuration(s.durationSec)} />}
                  <Row label="解像度" value={`${s.width} × ${s.height}`} />
                  <Row label="ステップ数" value={String(s.steps)} />
                  {s.cfg !== undefined && <Row label="CFG" value={s.cfg.toFixed(1)} />}
                  {s.negativePrompt ? <Row label="ネガティブ" value={s.negativePrompt} /> : null}
                  <Row label="シード" value={s.seed === -1 ? 'ランダム' : String(s.seed)} />
                  {s.lengthSec !== undefined && <Row label="長さ" value={`${s.lengthSec}秒`} />}
                  {s.turbo !== undefined && <Row label="Turbo LoRA" value={s.turbo ? 'ON' : 'OFF'} />}
                  {s.extraLora ? <Row label="追加LoRA" value={`${s.extraLora}(強度 ${(s.extraLoraStrength ?? 1).toFixed(2)})`} /> : null}
                </>
              ) : (
                <p className="py-2 text-xs text-ink-400">この生成には設定の記録がありません(旧バージョンで生成)。</p>
              )}
              <Row label="ファイル名" value={item.filename} />
              <Row label="生成日時" value={new Date(item.createdAt).toLocaleString('ja-JP')} />
            </div>
          </div>

          <div className="mt-auto flex flex-wrap gap-2">
            <button
              onClick={() => applyHistorySettings(item)}
              className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-bold text-white hover:bg-accent-600"
            >
              この設定を読み込む
            </button>
            {item.kind === 'image' && (
              <button
                onClick={() => void sendImageToSource(item.videoUrl)}
                className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-bold text-white hover:bg-ink-600"
              >
                動画の素材にする →
              </button>
            )}
            <a
              href={item.videoUrl}
              download
              className="rounded-lg border border-cream-200 px-4 py-2 text-sm font-semibold text-ink-600 hover:bg-cream-100"
            >
              {item.kind === 'image' ? '画像を保存' : '動画を保存'}
            </a>
          </div>
        </div>
      </div>
    </div>

    {/* 拡大表示(ライトボックス) */}
    {zoomed && item.kind === 'image' && (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4"
        onClick={() => setZoomed(false)}
      >
        <img
          src={item.videoUrl}
          alt={item.filename}
          className="max-h-full max-w-full cursor-zoom-out object-contain"
        />
        <button
          onClick={() => setZoomed(false)}
          className="absolute right-4 top-4 rounded-lg bg-white/90 px-3 py-1.5 text-sm font-semibold text-ink-900 hover:bg-white"
        >
          閉じる
        </button>
      </div>
    )}
    </>
  )
}

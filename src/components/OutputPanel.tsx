import { useEffect, useState } from 'react'
import { estimateRemainingSec, formatDuration } from '../lib/eta'
import { useGenerationStore } from '../store/generation'

export function OutputPanel() {
  const status = useGenerationStore((s) => s.status)
  const progress = useGenerationStore((s) => s.progress)
  const startedAt = useGenerationStore((s) => s.startedAt)
  const stepTimestamps = useGenerationStore((s) => s.stepTimestamps)
  const previewUrl = useGenerationStore((s) => s.previewUrl)
  const videoUrl = useGenerationStore((s) => s.videoUrl)
  const resultKind = useGenerationStore((s) => s.resultKind)
  const sendImageToSource = useGenerationStore((s) => s.sendImageToSource)
  const openOutputFolder = useGenerationStore((s) => s.openOutputFolder)
  const imageModel = useGenerationStore((s) => s.imageParams.model)

  // 1秒ごとに再描画して経過/残り時間を更新
  const [now, setNow] = useState(() => Date.now())
  const busy = status === 'running' || status === 'queued'
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy])

  const pct = progress && progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : 0
  const elapsedSec = busy && startedAt ? Math.floor((now - startedAt) / 1000) : null
  const remainingSec = progress
    ? estimateRemainingSec(stepTimestamps, progress.value, progress.max, now)
    : null

  return (
    <section className="rounded-2xl bg-surface p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">OUTPUT</p>
          <h2 className="text-lg font-bold">
            {status === 'running' ? `生成中… ${pct}%` : status === 'queued' ? 'キュー待機中…' : status === 'done' ? '完成' : '出力'}
          </h2>
        </div>
        {videoUrl && (
          <div className="flex gap-2">
            {resultKind === 'image' && (
              <button
                onClick={() => void sendImageToSource(videoUrl)}
                className="rounded-lg bg-onsurface px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                title="この画像を動画生成の参照素材(SOURCE)に送る"
              >
                動画の素材にする →
              </button>
            )}
            <a
              href={videoUrl}
              download
              className="rounded-lg border border-cream-200 px-3 py-1.5 text-xs font-semibold text-ink-600 hover:bg-cream-100"
            >
              {resultKind === 'image' ? '画像を保存' : '動画を保存'}
            </a>
            <button
              onClick={() => void openOutputFolder(resultKind === 'image' ? imageModel : 'video')}
              className="rounded-lg border border-cream-200 px-3 py-1.5 text-xs font-semibold text-ink-600 hover:bg-cream-100"
              title="保存先フォルダをエクスプローラーで開く"
            >
              保存先を開く
            </button>
          </div>
        )}
      </div>

      {/* 縦動画・縦画像は枠がコンテンツに追従する(黒帯で潰さない) */}
      <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-xl bg-black">
        {videoUrl && resultKind === 'image' ? (
          <img key={videoUrl} src={videoUrl} alt="生成画像" className="max-h-[68vh] w-auto max-w-full object-contain" />
        ) : videoUrl ? (
          <video
            key={videoUrl}
            src={videoUrl}
            controls
            autoPlay
            loop
            muted
            ref={(el) => {
              if (el) el.muted = true
            }}
            className="max-h-[68vh] w-auto max-w-full"
          />
        ) : previewUrl && busy ? (
          <img src={previewUrl} alt="生成中プレビュー" className="max-h-[68vh] w-auto max-w-full object-contain" />
        ) : (
          <p className="py-24 text-sm text-white/40">
            {busy ? 'プレビュー待機中…' : 'ここに生成結果が表示されます'}
          </p>
        )}
      </div>

      {busy && (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-cream-200">
            <div
              className={`h-full rounded-full bg-accent-500 transition-all ${status === 'queued' ? 'animate-pulse' : ''}`}
              style={{ width: `${status === 'queued' ? 100 : pct}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-xs tabular-nums text-ink-400">
            <span>{elapsedSec !== null ? `経過 ${formatDuration(elapsedSec)}` : ''}</span>
            <span>
              {progress && `ステップ ${progress.value} / ${progress.max}`}
              {remainingSec !== null && (
                <span className="ml-2 font-semibold text-accent-600">
                  残り 約{formatDuration(remainingSec)}(+デコード処理)
                </span>
              )}
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

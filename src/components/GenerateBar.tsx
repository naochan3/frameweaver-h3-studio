import { imageSlots, useGenerationStore } from '../store/generation'

/** 画面下部に常時固定される生成バー。スクロール位置に関係なくいつでも生成できる。 */
export function GenerateBar() {
  const appTab = useGenerationStore((s) => s.appTab)
  const status = useGenerationStore((s) => s.status)
  const progress = useGenerationStore((s) => s.progress)
  const params = useGenerationStore((s) => s.params)
  const imageParams = useGenerationStore((s) => s.imageParams)
  const sources = useGenerationStore((s) => s.sources)
  const generate = useGenerationStore((s) => s.generate)
  const generateImage = useGenerationStore((s) => s.generateImage)
  const stop = useGenerationStore((s) => s.stop)

  const busy = status === 'queued' || status === 'running' || status === 'uploading'

  const isVideo = appTab === 'video'
  const prompt = isVideo ? params.prompt : imageParams.prompt
  const [minImages] = isVideo ? imageSlots(params.mode) : [0]
  const ready = !busy && prompt.trim().length > 0 && (isVideo ? sources.length >= minImages : true)

  const pct = progress && progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : 0

  const label = busy
    ? isVideo
      ? '動画を生成中…'
      : '画像を生成中…'
    : isVideo
      ? 'この内容で動画を生成'
      : 'この内容で画像を生成'

  return (
    <div className="sticky bottom-0 z-30 border-t border-cream-200 bg-white/90 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink-600">
            <span className="font-bold text-ink-900">{isVideo ? '動画生成' : '画像生成'}</span>
            {prompt.trim() ? `: ${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}` : ' — プロンプトを入力してください'}
          </p>
          {busy && (
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-cream-200">
              <div
                className={`h-full rounded-full bg-accent-500 transition-all ${status === 'queued' ? 'animate-pulse' : ''}`}
                style={{ width: `${status === 'queued' ? 100 : pct}%` }}
              />
            </div>
          )}
        </div>

        {busy ? (
          <button
            onClick={() => void stop()}
            className="shrink-0 rounded-xl border border-red-200 bg-red-50 px-6 py-3 text-sm font-bold text-red-600 hover:bg-red-100"
          >
            ■ 停止
          </button>
        ) : (
          <button
            onClick={() => void (isVideo ? generate() : generateImage())}
            disabled={!ready}
            className="shrink-0 rounded-xl bg-accent-500 px-4 py-3 text-sm font-bold text-white shadow-lg transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:bg-cream-200 disabled:text-ink-400 sm:px-8"
          >
            <span className="sm:hidden">{isVideo ? '動画生成' : '画像生成'} →</span>
            <span className="hidden sm:inline">{label} →</span>
          </button>
        )}
      </div>
    </div>
  )
}

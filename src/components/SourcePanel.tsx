import { useCallback, useRef, useState } from 'react'
import { imageSlots, useGenerationStore } from '../store/generation'

const SLOT_LABEL: Record<string, string[]> = {
  first: ['開始画像'],
  first_last: ['開始画像', '終了画像'],
  last: ['終了画像'],
}

export function SourcePanel() {
  const mode = useGenerationStore((s) => s.params.mode)
  const sources = useGenerationStore((s) => s.sources)
  const addSourceFiles = useGenerationStore((s) => s.addSourceFiles)
  const removeSource = useGenerationStore((s) => s.removeSource)
  const status = useGenerationStore((s) => s.status)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const [min, max] = imageSlots(mode)

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
      if (files.length > 0) void addSourceFiles(files)
    },
    [addSourceFiles],
  )

  if (max === 0) return null

  const hint =
    mode === 'reference'
      ? `参照画像を最大${max}枚追加できます(<Picture 1>〜)。`
      : `${SLOT_LABEL[mode]?.join('と') ?? '画像'}を追加してください。`

  return (
    <section className="rounded-2xl bg-surface p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">SOURCE</p>
          <h2 className="text-lg font-bold">参照素材</h2>
        </div>
        <p className="text-xs text-ink-400">{hint}</p>
      </div>

      <div className="flex flex-wrap gap-3">
        {sources.map((src, i) => (
          <div key={src.name} className="group relative h-28 w-44 overflow-hidden rounded-xl border border-cream-200">
            <img src={src.previewUrl} alt={src.name} className="h-full w-full object-cover" />
            <span className="absolute bottom-0 left-0 right-0 truncate bg-black/50 px-2 py-0.5 text-[10px] text-white">
              {SLOT_LABEL[mode]?.[i] ? `${SLOT_LABEL[mode][i]}: ` : `Picture ${i + 1}: `}
              {src.name}
            </span>
            <button
              onClick={() => removeSource(i)}
              className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}

        {sources.length < max && (
          <button
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex h-28 w-44 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed text-xs transition-colors ${
              dragging ? 'border-accent-500 bg-accent-50 text-accent-600' : 'border-cream-200 text-ink-400 hover:border-accent-400'
            }`}
          >
            <span className="text-2xl leading-none">+</span>
            {status === 'uploading' ? 'アップロード中…' : 'クリック / ドラッグ&ドロップ'}
          </button>
        )}
      </div>

      {min > sources.length && (
        <p className="mt-2 text-xs text-accent-600">あと{min - sources.length}枚必要です</p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={max > 1}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) void addSourceFiles(files)
          e.target.value = ''
        }}
      />
    </section>
  )
}

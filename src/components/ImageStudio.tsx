import { useState } from 'react'
import { classifyLora, selectableLoras } from '../lib/lora'
import { IMAGE_RECOMMENDED } from '../lib/presets'
import { ASPECT_OPTIONS, IMAGE_MP_OPTIONS, computeResolution, type AspectRatio } from '../lib/resolution'
import type { ImageModel } from '../lib/types'
import { useGenerationStore } from '../store/generation'

const IMAGE_MODELS: { key: ImageModel; label: string; desc: string }[] = [
  { key: 'zimage', label: 'Z-Image Turbo', desc: '導入済み・高速。アニメ〜実写まで万能' },
  { key: 'krea2', label: 'Krea 2 Turbo', desc: '実写・iPhone写真風の自然な人物に強い' },
  { key: 'anime', label: 'アニメ (Illustrious)', desc: 'キャラ名で生成・NSFW対応。ネガティブ/cfgが効く' },
]

/** チェックポイント一覧からアニメ(SDXL)系を優先表示。該当が無ければ全件返す */
function animeCheckpoints(list: string[]): string[] {
  const hit = list.filter((n) => /wai|illustrious|noobai|nova|pony|sdxl|ilv|anime|_il|vpred|v-pred/i.test(n))
  return hit.length > 0 ? hit : list
}


export function ImageStudio() {
  const imageParams = useGenerationStore((s) => s.imageParams)
  const setImageParams = useGenerationStore((s) => s.setImageParams)
  const setImageModel = useGenerationStore((s) => s.setImageModel)
  const resetImageRecommended = useGenerationStore((s) => s.resetImageRecommended)
  const seedRandom = useGenerationStore((s) => s.imageSeedRandom)
  const toggleSeedRandom = useGenerationStore((s) => s.toggleImageSeedRandom)
  const loraList = useGenerationStore((s) => s.loraList)
  const checkpointList = useGenerationStore((s) => s.checkpointList)
  const status = useGenerationStore((s) => s.status)
  const error = useGenerationStore((s) => s.error)

  const busy = status === 'queued' || status === 'running'
  const ready = !busy && imageParams.prompt.trim().length > 0
  const isAnime = imageParams.model === 'anime'

  const [aspect, setAspect] = useState<AspectRatio>('9:16')
  const [mp, setMp] = useState(1.3)
  const applyResolution = (nextAspect: AspectRatio, nextMp: number) => {
    setAspect(nextAspect)
    setMp(nextMp)
    setImageParams(computeResolution(nextAspect, nextMp))
  }
  const resetRecommended = () => {
    setAspect('9:16')
    setMp(IMAGE_RECOMMENDED[imageParams.model].mp)
    resetImageRecommended()
  }
  // モデル切替: ストア側の推奨値適用に加え、解像度セレクタのローカル表示も同期させる
  const switchModel = (model: ImageModel) => {
    setImageModel(model)
    setAspect('9:16')
    setMp(IMAGE_RECOMMENDED[model].mp)
  }

  return (
    <div className="space-y-4">
      {/* SCENE */}
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">SCENE</p>
            <h2 className="text-lg font-bold">画像を描く</h2>
          </div>
          <p className="text-xs text-ink-400">動画の元画像(Motion Sync素材)には全身・手足が写る構図が◎</p>
        </div>
        <textarea
          value={imageParams.prompt}
          onChange={(e) => setImageParams({ prompt: e.target.value })}
          placeholder="生成したい画像を詳しく描写してください。実写人物なら iPhone photo / realistic skin texture / full body 等が有効です。"
          className="h-40 w-full resize-y rounded-xl border border-cream-200 bg-cream-50 p-3 text-sm leading-relaxed outline-none focus:border-accent-400"
        />
        <p className="mt-1 text-right text-xs text-ink-400">{imageParams.prompt.length}文字</p>
      </section>

      {/* RECIPE */}
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">RECIPE</p>
            <h2 className="text-lg font-bold">モデルと仕上がり</h2>
          </div>
          <button
            onClick={resetRecommended}
            className="rounded-lg border border-cream-200 px-3 py-1.5 text-xs font-semibold text-ink-600 hover:bg-cream-100"
            title="このモデルのおすすめ設定に戻す"
          >
            推奨に戻す
          </button>
        </div>

        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {IMAGE_MODELS.map((m) => {
            const active = imageParams.model === m.key
            return (
              <button
                key={m.key}
                onClick={() => switchModel(m.key)}
                className={`rounded-xl border-2 p-3 text-left transition-colors ${
                  active ? 'border-accent-500 bg-orange-50' : 'border-cream-200 hover:border-accent-400'
                }`}
              >
                <span className={`text-sm font-bold ${active ? 'text-accent-600' : 'text-ink-900'}`}>{m.label}</span>
                <p className="mt-0.5 text-xs text-ink-600">{m.desc}</p>
              </button>
            )
          })}
        </div>

        {isAnime && (
          <div className="mb-4 space-y-3 rounded-xl border border-pink-200 bg-pink-50/60 p-3">
            <label className="block text-xs font-semibold text-ink-600">
              アニメモデル(チェックポイント)
              {animeCheckpoints(checkpointList).length > 0 ? (
                <select
                  value={imageParams.animeCheckpoint || ''}
                  onChange={(e) => setImageParams({ animeCheckpoint: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-cream-200 bg-white p-2 text-sm font-normal"
                >
                  <option value="">おすすめ(WAI・自動)</option>
                  {animeCheckpoints(checkpointList).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <p className="mt-1 font-normal text-amber-600">
                  チェックポイント未検出。DL完了後にComfyUIを再読込すると候補が並びます(WAI/NoobAI等)。
                </p>
              )}
              <span className="mt-1 block font-normal text-ink-400">
                ファイル名に「vpred」を含むモデル(NoobAI V-Pred等)は自動でv-prediction設定に切替わります。
              </span>
            </label>

            <label className="block text-xs font-semibold text-ink-600">
              ネガティブプロンプト(SDXL系のみ有効)
              <textarea
                value={imageParams.negativePrompt ?? ''}
                onChange={(e) => setImageParams({ negativePrompt: e.target.value })}
                placeholder="除外したい要素。空でも可"
                className="mt-1 h-16 w-full resize-y rounded-lg border border-cream-200 bg-white p-2 text-sm font-normal leading-relaxed"
              />
            </label>

            <label className="block text-xs font-semibold text-ink-600">
              CFGスケール: {(imageParams.cfg ?? 6).toFixed(1)}(5〜7が目安。高いほどプロンプト忠実・硬い)
              <input
                type="range"
                min={1}
                max={12}
                step={0.5}
                value={imageParams.cfg ?? 6}
                onChange={(e) => setImageParams({ cfg: Number(e.target.value) })}
                className="mt-3 w-full accent-accent-500"
              />
            </label>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="text-xs font-semibold text-ink-600">
            アスペクト比(縦横比)
            <div className="mt-1 flex gap-1">
              {ASPECT_OPTIONS.map((a) => (
                <button
                  key={a}
                  onClick={() => applyResolution(a, mp)}
                  className={`flex-1 rounded-lg border px-1 py-2 text-xs font-bold transition-colors ${
                    aspect === a ? 'border-accent-500 bg-orange-50 text-accent-600' : 'border-cream-200 text-ink-600 hover:border-accent-400'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          <label className="text-xs font-semibold text-ink-600">
            画質(現在 {imageParams.width}×{imageParams.height})
            <select
              value={mp}
              onChange={(e) => applyResolution(aspect, Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-cream-200 bg-cream-50 p-2 text-sm font-normal"
            >
              {IMAGE_MP_OPTIONS.map((o) => (
                <option key={o.mp} value={o.mp}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="text-xs font-semibold text-ink-600">
            ステップ数: {imageParams.steps}({isAnime ? 'SDXLは25〜30推奨' : 'Turbo系は8推奨'})
            <input
              type="range"
              min={isAnime ? 10 : 4}
              max={isAnime ? 40 : 12}
              step={1}
              value={imageParams.steps}
              onChange={(e) => setImageParams({ steps: Number(e.target.value) })}
              className="mt-3 w-full accent-accent-500"
            />
          </label>

          <label className="sm:col-span-2 text-xs font-semibold text-ink-600">
            追加LoRA(キャラ・画風LoRA・任意)
            <input
              list="lora-list-image"
              value={imageParams.extraLora}
              onChange={(e) => setImageParams({ extraLora: e.target.value })}
              placeholder="例: hinano_v2_lora.safetensors(未使用なら空のまま)"
              className="mt-1 w-full rounded-lg border border-cream-200 bg-cream-50 p-2 text-sm font-normal"
            />
            <datalist id="lora-list-image">
              {(() => {
                const { compatible, unknown } = selectableLoras(loraList, imageParams.model)
                return [...compatible, ...unknown].map((name) => (
                  <option key={name} value={name} label={classifyLora(name).note} />
                ))
              })()}
            </datalist>
            {(() => {
              const { compatible, unknown } = selectableLoras(loraList, imageParams.model)
              const modelLabel = imageParams.model === 'krea2' ? 'Krea 2' : imageParams.model === 'anime' ? 'アニメ' : 'Z-Image'
              if (compatible.length + unknown.length === 0)
                return (
                  <p className="mt-1 font-normal text-amber-600">
                    {modelLabel}用のLoRAが未導入のため候補がありません。導入したら候補に自動で並びます。
                  </p>
                )
              return (
                <p className="mt-1 font-normal text-ink-400">
                  候補には{modelLabel}用のLoRAだけを表示しています。
                  LoRAは学習元モデル専用で、別モデル用を選んでも効きません。
                </p>
              )
            })()}
            {imageParams.extraLora.trim() &&
              (() => {
                const info = classifyLora(imageParams.extraLora.trim())
                if (info.target === imageParams.model) return null
                if (info.target === 'unknown')
                  return (
                    <p className="mt-1 font-semibold text-amber-600">
                      注意: このLoRAの対象モデルは未確認です。効かない可能性があります。
                    </p>
                  )
                return (
                  <p className="mt-1 font-semibold text-red-600">
                    警告: {info.note}。{imageParams.model === 'krea2' ? 'Krea 2' : imageParams.model === 'anime' ? 'アニメ' : 'Z-Image'} では効きません。
                  </p>
                )
              })()}
          </label>

          {imageParams.extraLora.trim() && (
            <label className="sm:col-span-2 text-xs font-semibold text-ink-600">
              追加LoRA強度: {imageParams.extraLoraStrength.toFixed(2)}(キャラLoRAは0.7〜1.0が目安)
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={imageParams.extraLoraStrength}
                onChange={(e) => setImageParams({ extraLoraStrength: Number(e.target.value) })}
                className="mt-3 w-full accent-accent-500"
              />
            </label>
          )}

          <div className="sm:col-span-2 text-xs font-semibold text-ink-600">
            シード
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={toggleSeedRandom}
                className="flex shrink-0 items-center gap-2 rounded-lg border border-cream-200 px-3 py-2 hover:bg-cream-100"
                title={seedRandom ? 'ランダムON(押すと固定に切替)' : 'ランダムOFF(押すと毎回ランダムに切替)'}
              >
                <span className={`relative h-5 w-9 rounded-full transition-colors ${seedRandom ? 'bg-accent-500' : 'bg-cream-200'}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${seedRandom ? 'left-[18px]' : 'left-0.5'}`} />
                </span>
                ランダム
              </button>
              <input
                type="number"
                value={imageParams.seed}
                onChange={(e) => setImageParams({ seed: Number(e.target.value) })}
                disabled={seedRandom}
                className="w-full rounded-lg border border-cream-200 bg-cream-50 p-2 text-sm font-normal disabled:opacity-50"
              />
            </div>
            <p className="mt-1 font-normal text-ink-400">
              {seedRandom ? '生成ごとに自動でランダムになります。' : '固定シード。同じ値なら同じ結果です。'}
            </p>
          </div>
        </div>

        {error && <p className="mt-3 rounded-lg bg-red-50 p-2 text-xs text-red-600">{error}</p>}

        <p className="mt-4 text-xs text-ink-400">
          {ready ? '設定完了。画面下の「生成」ボタンで開始できます。' : 'プロンプトを入力してください。'}
        </p>
      </section>
    </div>
  )
}

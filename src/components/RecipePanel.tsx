import { useState } from 'react'
import { loraNote } from '../lib/lora'
import { ASPECT_OPTIONS, VIDEO_MP_OPTIONS, computeResolution, type AspectRatio } from '../lib/resolution'
import { imageSlots, useGenerationStore } from '../store/generation'

export function RecipePanel() {
  const params = useGenerationStore((s) => s.params)
  const loraList = useGenerationStore((s) => s.loraList)
  const sources = useGenerationStore((s) => s.sources)
  const status = useGenerationStore((s) => s.status)
  const error = useGenerationStore((s) => s.error)
  const setParams = useGenerationStore((s) => s.setParams)
  const resetVideoRecommended = useGenerationStore((s) => s.resetVideoRecommended)
  const seedRandom = useGenerationStore((s) => s.videoSeedRandom)
  const toggleSeedRandom = useGenerationStore((s) => s.toggleVideoSeedRandom)

  const busy = status === 'queued' || status === 'running' || status === 'uploading'
  const [minImages] = imageSlots(params.mode)
  const ready = !busy && params.prompt.trim().length > 0 && sources.length >= minImages

  // アスペクト比×画質(MP)の2軸で解像度を決める(実測: 1.3MP超は12GBで非実用)
  const [aspect, setAspect] = useState<AspectRatio>('9:16')
  const [mp, setMp] = useState(0.5)
  const applyResolution = (nextAspect: AspectRatio, nextMp: number) => {
    setAspect(nextAspect)
    setMp(nextMp)
    setParams(computeResolution(nextAspect, nextMp))
  }
  const resetRecommended = () => {
    setAspect('9:16')
    setMp(0.5)
    resetVideoRecommended()
  }

  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">RECIPE</p>
          <h2 className="text-lg font-bold">仕上がりを選ぶ</h2>
          <p className="mt-0.5 text-xs text-ink-400">初期値は12GB VRAM向けのおすすめ設定です。</p>
        </div>
        <button
          onClick={resetRecommended}
          className="shrink-0 rounded-lg border border-cream-200 px-3 py-1.5 text-xs font-semibold text-ink-600 hover:bg-cream-100"
          title="おすすめ設定に戻す"
        >
          推奨に戻す
        </button>
      </div>

      {/* NSFWトグル(目立つ位置) */}
      <label className={`mb-4 flex cursor-pointer items-center justify-between rounded-xl border-2 p-3 transition-colors ${
        params.nsfw ? 'border-pink-400 bg-pink-50' : 'border-cream-200 bg-cream-50'
      }`}>
        <div>
          <span className={`text-sm font-bold ${params.nsfw ? 'text-pink-600' : 'text-ink-900'}`}>
            NSFW モード {params.nsfw ? 'ON' : 'OFF'}
          </span>
          <p className="text-xs text-ink-600">
            ONにすると無検閲テキストエンコーダ(Heretic)に切り替えます。初回切替時はモデル再読込が走ります。
          </p>
        </div>
        <div className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${params.nsfw ? 'bg-pink-500' : 'bg-cream-200'}`}>
          <input
            type="checkbox"
            checked={params.nsfw}
            onChange={(e) => setParams({ nsfw: e.target.checked })}
            className="peer sr-only"
          />
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${params.nsfw ? 'left-[22px]' : 'left-0.5'}`} />
        </div>
      </label>

      <div className="grid grid-cols-2 gap-4">
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
          画質(現在 {params.width}×{params.height})
          <select
            value={mp}
            onChange={(e) => applyResolution(aspect, Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-cream-200 bg-cream-50 p-2 text-sm font-normal"
          >
            {VIDEO_MP_OPTIONS.map((o) => (
              <option key={o.mp} value={o.mp}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="text-xs font-semibold text-ink-600">
          長さ: {params.lengthSec}秒
          <input
            type="range"
            min={3}
            max={15}
            step={1}
            value={params.lengthSec}
            onChange={(e) => setParams({ lengthSec: Number(e.target.value) })}
            className="mt-3 w-full accent-accent-500"
          />
        </label>

        <div className="text-xs font-semibold text-ink-600">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={params.turbo}
              onChange={(e) => {
                const turbo = e.target.checked
                // Turbo(lightx2v 4step)は Steps = forwards+1 = 5 が最良(実測レポート準拠)
                setParams({ turbo, steps: turbo ? 5 : 20 })
              }}
              className="h-4 w-4 accent-accent-500"
            />
            Turbo LoRA(高速化・推奨)
          </label>
          <p className="mt-1 font-normal text-ink-400">
            少ないステップで仕上げる高速化用LoRA。ONで5秒動画が約2分、OFFだと高品質だが約4倍遅い。
          </p>
        </div>

        <label className="text-xs font-semibold text-ink-600">
          ステップ数: {params.steps}{params.turbo && params.steps === 5 ? '(推奨)' : ''}
          <input
            type="range"
            min={params.turbo ? 4 : 10}
            max={params.turbo ? 8 : 30}
            step={1}
            value={params.steps}
            onChange={(e) => setParams({ steps: Number(e.target.value) })}
            className="mt-1 w-full accent-accent-500"
          />
        </label>

        <label className="col-span-2 text-xs font-semibold text-ink-600">
          追加LoRA(自作キャラ・画風LoRA・任意)
          <input
            list="lora-list"
            value={params.extraLora}
            onChange={(e) => setParams({ extraLora: e.target.value })}
            placeholder="例: minimax-h3/mychar.safetensors(未使用なら空のまま)"
            className="mt-1 w-full rounded-lg border border-cream-200 bg-cream-50 p-2 text-sm font-normal"
          />
          <datalist id="lora-list">
            {loraList.map((name) => (
              <option key={name} value={name} label={loraNote(name)} />
            ))}
          </datalist>
          <p className="mt-1 font-normal text-ink-400">
            自分で学習したキャラ/画風LoRAを重ねたいときだけ指定します。上のTurbo LoRAは自動で適用されるので、
            ここで <code className="rounded bg-cream-100 px-1">turbo</code> を含むファイルを選ぶ必要はありません。
          </p>
        </label>

        {params.extraLora.trim() && (
          <label className="col-span-2 text-xs font-semibold text-ink-600">
            追加LoRA強度: {params.extraLoraStrength.toFixed(2)}(キャラLoRAは0.8〜1.0が目安)
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={params.extraLoraStrength}
              onChange={(e) => setParams({ extraLoraStrength: Number(e.target.value) })}
              className="mt-3 w-full accent-accent-500"
            />
          </label>
        )}

        <div className="col-span-2 text-xs font-semibold text-ink-600">
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
              value={params.seed}
              onChange={(e) => setParams({ seed: Number(e.target.value) })}
              disabled={seedRandom}
              className="w-full rounded-lg border border-cream-200 bg-cream-50 p-2 text-sm font-normal disabled:opacity-50"
            />
          </div>
          <p className="mt-1 font-normal text-ink-400">
            {seedRandom ? '生成ごとに自動でランダムになります。' : '固定シード。同じ値なら同じ結果です。'}
          </p>
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 p-2 text-xs text-red-600">{error}</p>
      )}

      <p className="mt-4 text-xs text-ink-400">
        {ready ? '設定完了。画面下の「生成」ボタンで開始できます。' : 'プロンプトと必要な画像を用意してください。'}
      </p>
    </section>
  )
}

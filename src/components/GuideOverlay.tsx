import { useState } from 'react'
import { useGenerationStore } from '../store/generation'
import { useBodyScrollLock } from '../lib/useBodyScrollLock'

interface GuideStep {
  title: string
  body: string
  demo: React.ReactNode
}

/** 各ステップの説明に添えるCSSアニメーションのミニデモ */
function DemoTabs() {
  return (
    <div className="flex gap-1 rounded-xl bg-cream-100 p-1.5">
      {['Text', 'First', 'First+Last', 'Last', 'Reference'].map((t, i) => (
        <span
          key={t}
          className="guide-tab flex-1 rounded-lg px-2 py-2 text-center text-[10px] font-bold text-ink-600"
          style={{ animationDelay: `${i * 0.6}s` }}
        >
          {t}
        </span>
      ))}
    </div>
  )
}

function DemoProgress() {
  return (
    <div className="space-y-2">
      <div className="h-3 overflow-hidden rounded-full bg-cream-200">
        <div className="guide-progress h-full rounded-full bg-accent-500" />
      </div>
      <p className="text-center text-[11px] tabular-nums text-ink-400">経過 1分12秒 / 残り 約2分40秒(+デコード処理)</p>
    </div>
  )
}

function DemoNsfw() {
  return (
    <div className="flex items-center justify-center gap-3 rounded-xl border-2 border-pink-200 bg-pink-50 p-3">
      <span className="text-xs font-bold text-pink-600">NSFW モード</span>
      <div className="guide-toggle relative h-6 w-11 rounded-full bg-cream-200">
        <span className="guide-toggle-knob absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow" />
      </div>
    </div>
  )
}

function DemoUpload() {
  return (
    <div className="flex justify-center gap-3">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="guide-drop flex h-16 w-24 items-center justify-center rounded-xl border-2 border-dashed border-accent-400 text-xl text-accent-500"
          style={{ animationDelay: `${i * 0.8}s` }}
        >
          +
        </div>
      ))}
    </div>
  )
}

function DemoModels() {
  return (
    <div className="grid grid-cols-2 gap-2">
      {['Z-Image Turbo', 'Krea 2 Turbo'].map((m, i) => (
        <div
          key={m}
          className="guide-card rounded-xl border-2 border-cream-200 p-2 text-center text-[11px] font-bold text-ink-600"
          style={{ animationDelay: `${i * 1.2}s` }}
        >
          {m}
        </div>
      ))}
    </div>
  )
}

const STEPS: GuideStep[] = [
  {
    title: 'FrameWeaver H3 Studio へようこそ',
    body: '上部のタブで「動画生成(MiniMax H3)」と「画像生成(Krea 2 / Z-Image)」を切り替えて使います。どちらも 左でつくる → 右で見る の同じ流れです。',
    demo: (
      <div className="flex gap-1 rounded-2xl bg-cream-100 p-1.5">
        <span className="guide-tab flex-1 rounded-xl bg-onsurface px-3 py-2 text-center text-xs font-bold text-white">動画生成</span>
        <span className="guide-tab flex-1 rounded-xl px-3 py-2 text-center text-xs font-bold text-ink-600" style={{ animationDelay: '1s' }}>画像生成</span>
      </div>
    ),
  },
  {
    title: '動画: 5つのモード',
    body: 'Text=文章だけ / First=開始画像から / First+Last=2枚の間をつなぐ / Last=終了画像へ向かう / Reference=写したい人・物の参照画像(最大9枚)を登場させる。音声も同時に生成されます。',
    demo: <DemoTabs />,
  },
  {
    title: '画像のアップロード',
    body: 'First系とReferenceでは、点線の枠にドラッグ&ドロップ(またはクリック)で画像を追加します。Referenceのプロンプトでは <Picture 1> のように番号で参照します。',
    demo: <DemoUpload />,
  },
  {
    title: 'プロンプトのコツ',
    body: '自然な文章で「誰が・どこで・何をするか+カメラの動き+音(セリフ/環境音/BGM)」を書くのが最良です。箇条書きで細かく縛りすぎると動きが硬くなります。',
    demo: (
      <div className="guide-typing rounded-xl border border-cream-200 bg-cream-50 p-3 text-xs leading-relaxed text-ink-600">
        夕暮れの部屋で、ピンク髪の女の子がカメラに向かって微笑み、小さく手を振る。柔らかい環境音と静かなBGM。
      </div>
    ),
  },
  {
    title: '仕上がり設定と生成時間',
    body: 'Turbo LoRA(推奨ON)なら5秒動画が約2〜4分。解像度は 576×832 が標準で、上げるほど高品質ですが時間がかかります(上限1.3MP)。生成中は進捗と残り時間が表示されます。',
    demo: <DemoProgress />,
  },
  {
    title: 'NSFWモード',
    body: 'RECIPE内のトグルをONにすると無検閲エンコーダ(Heretic)に切り替わり、成人向け表現の制限が大きく緩和されます。切替直後の1回目はモデル再読込のため時間がかかります。',
    demo: <DemoNsfw />,
  },
  {
    title: '画像生成タブ',
    body: 'Z-Image Turbo(万能・高速)と Krea 2 Turbo(実写・iPhone写真風)を切り替えて静止画を生成。9:16(864×1536)はTikTok素材やMotion Syncの元画像に最適です。生成した画像はFirstモードやReferenceに流用できます。',
    demo: <DemoModels />,
  },
  {
    title: '困ったときは',
    body: '生成を止めたいときはヘッダーの「停止」。VRAMが足りないときは解像度を下げるか、完了後に時間を置いてください。この案内はヘッダーの「使い方」からいつでも見られます。',
    demo: (
      <div className="flex justify-center gap-2">
        <span className="guide-card rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-600">■ 停止</span>
      </div>
    ),
  },
]

export function GuideOverlay() {
  const guideOpen = useGenerationStore((s) => s.guideOpen)
  const setGuideOpen = useGenerationStore((s) => s.setGuideOpen)
  const [step, setStep] = useState(0)
  useBodyScrollLock(guideOpen)

  if (!guideOpen) return null
  const s = STEPS[step]
  const last = step === STEPS.length - 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setGuideOpen(false)}>
      <div
        key={step}
        className="guide-panel w-full max-w-lg rounded-2xl bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">
          使い方ガイド {step + 1} / {STEPS.length}
        </p>
        <h2 className="mt-1 text-xl font-bold">{s.title}</h2>
        <div className="my-5">{s.demo}</div>
        <p className="min-h-16 text-sm leading-relaxed text-ink-600">{s.body}</p>

        <div className="mt-5 flex items-center justify-between">
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`h-2 rounded-full transition-all ${i === step ? 'w-6 bg-accent-500' : 'w-2 bg-cream-200 hover:bg-ink-400'}`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setGuideOpen(false)}
              className="rounded-lg px-3 py-2 text-xs font-semibold text-ink-400 hover:bg-cream-100"
            >
              閉じる
            </button>
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="rounded-lg border border-cream-200 px-4 py-2 text-xs font-semibold text-ink-600 hover:bg-cream-100"
              >
                戻る
              </button>
            )}
            <button
              onClick={() => (last ? setGuideOpen(false) : setStep(step + 1))}
              className="rounded-lg bg-accent-500 px-5 py-2 text-xs font-bold text-white hover:bg-accent-600"
            >
              {last ? 'はじめる' : '次へ'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

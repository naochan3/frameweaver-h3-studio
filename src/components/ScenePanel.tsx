import { useGenerationStore } from '../store/generation'

const MODE_HINT: Record<string, string> = {
  text: 'テキストだけで映像と音声を生成します。',
  first: '開始画像から続きの映像と音声を生成します。',
  first_last: '開始・終了画像の間を映像と音声でつなぎます。',
  last: '終了画像に向かう映像と音声を生成します。',
  reference: '参照素材の人物・物を登場させます。プロンプトでは <Picture 1> のように参照します。',
}

export function ScenePanel() {
  const prompt = useGenerationStore((s) => s.params.prompt)
  const mode = useGenerationStore((s) => s.params.mode)
  const setParams = useGenerationStore((s) => s.setParams)

  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <p className="text-[10px] font-bold tracking-[0.2em] text-accent-500">SCENE</p>
          <h2 className="text-lg font-bold">映像を描く</h2>
        </div>
        <p className="text-xs text-ink-400">{MODE_HINT[mode]}</p>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setParams({ prompt: e.target.value })}
        placeholder="生成したい映像を詳しく描写してください。カメラワーク・動き・音(セリフ/環境音/BGM)も指定できます。"
        className="h-48 w-full resize-y rounded-xl border border-cream-200 bg-cream-50 p-3 text-sm leading-relaxed outline-none focus:border-accent-400"
      />
      <p className="mt-1 text-right text-xs text-ink-400">{prompt.length}文字</p>
    </section>
  )
}

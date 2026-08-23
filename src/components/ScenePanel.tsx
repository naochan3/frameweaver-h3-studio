import { rewriterSupportsMode } from '../lib/rewriter'
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
  const rewriterAvailable = useGenerationStore((s) => s.rewriterAvailable)
  const rewriting = useGenerationStore((s) => s.rewriting)
  const rewriteUndo = useGenerationStore((s) => s.rewriteUndo)
  const rewritePrompt = useGenerationStore((s) => s.rewritePrompt)
  const undoRewrite = useGenerationStore((s) => s.undoRewrite)

  const canRewrite = rewriterAvailable && rewriterSupportsMode(mode)

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
      <div className="mt-1 flex items-center justify-between gap-2">
        {canRewrite ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void rewritePrompt()}
              disabled={rewriting || !prompt.trim()}
              className="rounded-lg border border-accent-300 bg-white px-3 py-1.5 text-xs font-bold text-accent-600 hover:bg-accent-50 disabled:opacity-50"
              title="一言(やりたいこと)を、映像+音響+BGMまで書かれた本番プロンプトに自動変換します"
            >
              {rewriting ? '強化中…(初回はモデル読込で数分)' : 'プロンプト自動強化'}
            </button>
            {rewriteUndo !== null && !rewriting && (
              <button
                type="button"
                onClick={undoRewrite}
                className="rounded-lg border border-cream-200 px-3 py-1.5 text-xs font-semibold text-ink-600 hover:bg-cream-100"
              >
                元に戻す
              </button>
            )}
          </div>
        ) : (
          <span className="text-xs text-ink-400">
            {rewriterAvailable ? 'Referenceモードは自動強化の対象外です' : ''}
          </span>
        )}
        <p className="text-right text-xs text-ink-400">{prompt.length}文字</p>
      </div>
    </section>
  )
}

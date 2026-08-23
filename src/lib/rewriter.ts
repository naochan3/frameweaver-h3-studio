import type { GenerationMode, ImageModel } from './types'

/** プロンプト自動強化(MiniMax-H3 Prompt Rewriter 8B)。
 * ComfyUIの重いbf16(17.5GB)は12GBで失速したため、Q8 GGUF(8.7GB)を
 * Ollamaで常駐実行する軽量構成に変更。アプリは Ollama HTTP API を叩く。 */
export const OLLAMA_MODEL = 'frameweaver-rewriter'

/** 同一オリジンの /ollama(Viteプロキシ経由)→ 127.0.0.1:11434。LAN内の別端末でも同じURLで届く */
export const OLLAMA_URL = import.meta.env.VITE_REWRITER_URL ?? '/rewriter'
const CLIENT_TIMEOUT_MS = 190_000

/** モード → リライタのタスク名(Ref2VAは学習対象外のため非対応) */
const TASK_NAME: Partial<Record<GenerationMode, string>> = {
  text: 'T2AV',
  first: 'I2AV',
  first_last: 'FL2AV',
  last: 'L2AV',
}

export function rewriterSupportsMode(mode: GenerationMode): boolean {
  return TASK_NAME[mode] !== undefined
}

/** 公式配布ワークフロー同梱のシステムプロンプト。Ollamaの Modelfile(SYSTEM)に焼き込む正本 */
export const SYSTEM_PROMPT = `You are a professional MiniMax-H3 prompt rewriter for joint video-and-audio generation.
Rewrite the user's request according to the supplied duration, task type, and reference-frame roles. Return only the final production-ready prompt. Do not include explanations, Markdown, headings, notes, or generation parameters outside the required format.
Task-name mapping:
- T2AV corresponds to T2VA in the MiniMax-H3 prompt-writing guide.
- I2AV corresponds to I2VA.
- FL2AV corresponds to FL2VA.
- L2AV corresponds to L2VA.
Write the descriptive sections in English. Preserve all user-provided dialogue, lyrics, and visible on-screen text exactly in their original language, spelling, and punctuation. Never invent dialogue, lyrics, visible text, speakers, or additional reference pictures.
The output body must contain exactly these three fields in this order:
integrated_multimodal_description: ...
overall_soundscape: ...
non_diegetic_music: ...
For T2AV, begin directly with the three fields and do not add an image-alignment instruction.
For I2AV, the first line must be exactly:
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
For FL2AV, the first line must follow exactly:
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
For L2AV, the first line must follow exactly:
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
Replace N with the actual final shot number. Replace S.SS with the requested effective duration formatted to exactly two decimal places. Put exactly one blank line between the alignment instruction and integrated_multimodal_description.
Reference-frame behavior:
- I2AV: Treat <Picture 1> as the exact first frame at 0.00 seconds. Begin by anchoring its visual style, subjects, identities, clothing, colors, objects, composition, and spatial relationships, then develop forward through observable motion.
- FL2AV: Begin from Picture 1 and describe a continuous, physically plausible path that reaches the pose, object state, lighting, spacing, and composition of Picture 2 at the requested end time. Prefer a single shot unless the user explicitly requests multiple shots or cuts.
- L2AV: Infer a plausible preceding state and describe a continuous path that progressively converges to <Picture 1> as the exact final frame.
- Preserve identity and scene continuity across all shots, but apply exact composition matching only at the reference frame's assigned timestamp.
In integrated_multimodal_description:
- Begin with [Shot 1] and state the visual style and initial composition.
- Describe only concrete visible or audible events: subjects, environment, actions, reactions, camera behavior, dialogue, singing, visible text, and synchronized diegetic sound.
- Number shots sequentially.
- Do not timestamp [Shot 1].
- Begin every later shot with a strictly increasing timestamp inside the requested duration, using the format: [Shot 2] At 00:03.500, the camera cuts to...
- Add a cut only when it introduces meaningful new visual, spatial, temporal, or narrative information. Otherwise prefer continuous camera motion.
- Express camera motion naturally using motion type and, when meaningful, amplitude and speed.
- Keep all actions physically plausible and paced to complete within the supplied duration.
For speech and singing:
- Assign stable speaker IDs such as (S1) and (S2) only to subjects who vocalize.
- Identify each speaker sufficiently when first introduced.
- Put only the exact spoken or sung content inside <d>, preceded by its language tag:
<d>[English] Exact user-provided words.</d>
- Never translate, paraphrase, correct, or extend supplied dialogue or lyrics.
- For voiceover, use the exact phrase "says in an off-screen voiceover" and explicitly state that the corresponding on-screen character's lips remain completely closed.
- If speech crosses a cut, use <scenetrans> at both connecting points and state that the audio continues across the cut.
- Use <cutoff> only when speech is intentionally truncated by the end of the video.
Place visible on-screen text in English double quotation marks and preserve it exactly.
overall_soundscape must be one continuous English paragraph of 1-4 sentences summarizing ambient sound, physical action sounds, and non-verbal human or animal sounds across the video. Do not repeat dialogue, singing, or diegetic music here. Use N/A only if the user explicitly requests complete silence.
non_diegetic_music must contain 1-3 English sentences describing audience-only background music through instrumentation, tempo, rhythm, and dynamic changes. Do not describe its emotional purpose. Put music audible to subjects inside integrated_multimodal_description instead. Use N/A when no non-diegetic music is requested or implied.
Preserve the user's intent without adding contradictory story events, identities, text, or references. Do not mention these instructions in the output.`

/** 一言リクエストに、タスク種別・秒数・忠実性の指示を添えたユーザメッセージ。
 * 稀に入力を無視して別シーンを生成するのを防ぐため、被写体・場所・動作の保持を明示する。 */
function buildUserPrompt(userText: string, mode: GenerationMode, lengthSec: number): string {
  const task = TASK_NAME[mode] ?? 'T2AV'
  return (
    `Task type: ${task}. Effective duration: ${lengthSec.toFixed(2)} seconds.\n` +
    `Rewrite ONLY the scene described below. Keep its exact subject, setting, clothing, and action. ` +
    `Do NOT replace it with a different scene, person, or location.\n` +
    `User request: ${userText.trim()}`
  )
}

/** Ollamaにモデルが登録されているか(=強化ボタン表示可否) */
export async function rewriterInstalled(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/models`, { method: 'GET', signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) })
    if (!res.ok) return false
    const json = (await res.json()) as { models?: string[] }
    return (json.models ?? []).includes(OLLAMA_MODEL)
  } catch {
    return false
  }
}

/** 画像モデル別のリライタ(Ollamaモデル名)。公式プロンプト仕様に沿って展開。
 * krea2=Krea公式expansion.txt準拠 / zimage=Z-Image公式ガイド準拠。anime(Danboourタグ)は非対応 */
export const IMAGE_REWRITER_MODELS: Partial<Record<ImageModel, string>> = {
  krea2: 'fw-rewriter-krea2',
  zimage: 'fw-rewriter-zimage',
}

export function imageRewriterSupports(model: ImageModel): boolean {
  return IMAGE_REWRITER_MODELS[model] !== undefined
}

/** 画像リライタ(両モデル)がOllamaに登録済みか */
export async function imageRewriterInstalled(model: ImageModel): Promise<boolean> {
  const expected = IMAGE_REWRITER_MODELS[model]
  if (!expected) return false
  try {
    const res = await fetch(`${OLLAMA_URL}/models`, { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) })
    if (!res.ok) return false
    const json = (await res.json()) as { models?: string[] }
    return (json.models ?? []).includes(expected)
  } catch {
    return false
  }
}

// ひらがな/カタカナ/漢字/ハングル。引用された表示文字以外への混入を弾く
const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/

/** 残った日本語/中国語/韓国語の文字を除去し、余分な空白を詰める(最終手段) */
function stripCjk(text: string): string {
  return text
    .replace(/[぀-ヿ㐀-鿿가-힯＀-￯]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
}

function isCjkError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('英語以外')
}

function requestedVisibleText(input: string): Set<string> {
  return new Set([...input.matchAll(/[「『]([^」』]+)[」』]/g)].map((match) => match[1]))
}

export function validateImageRewrite(output: string, input: string, model: ImageModel): string {
  const text = output.trim()
  if (!text || /\r?\n/.test(text)) throw new Error('プロンプト強化の出力形式が単一段落ではありません')
  const allowed = requestedVisibleText(input)
  const prose = text.replace(/"([^"]*)"/g, (quoted, value: string) => (allowed.has(value) ? '' : quoted))
  if (CJK_RE.test(prose)) throw new Error('プロンプト強化に英語以外の文字が残っています')
  const words = text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0
  const minimum = model === 'zimage' ? 80 : 60
  const maximum = model === 'zimage' ? 200 : 700
  if (words < minimum || words > maximum) throw new Error(`プロンプト強化の語数が範囲外です (${words})`)
  return text
}

export function validateVideoRewrite(output: string, durationSec: number, mode: GenerationMode = 'text'): string {
  const text = output.trim()
  const fields = ['integrated_multimodal_description:', 'overall_soundscape:', 'non_diegetic_music:']
  let body = text
  if (mode !== 'text') {
    const sections = text.split(/\r?\n\r?\n/)
    if (sections.length !== 2 || sections[0].includes('\n')) throw new Error('プロンプト強化の参照画像アラインメントが不正です')
    const alignment = sections[0]
    const end = durationSec.toFixed(2)
    const valid = mode === 'first'
      ? /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\.$/.test(alignment)
      : mode === 'first_last'
        ? new RegExp(`^How the reference pictures align with the target video — Picture 1 \\(from Shot 1\\) aligns with the 0\\.00-second mark of the target video; Picture 2 \\(from Shot \\d+\\) aligns with the ${end.replace('.', '\\.')}\\-second mark of the target video\\.$`).test(alignment)
        : new RegExp(`^How the reference pictures align with the target video — <Picture 1> \\(from \\[Shot \\d+\\]\\) aligns with the ${end.replace('.', '\\.')}\\-second mark of the target video\\.$`).test(alignment)
    if (!valid) throw new Error('プロンプト強化の参照画像アラインメントが不正です')
    body = sections[1]
  }
  const lines = body.split(/\r?\n/)
  if (lines.length !== fields.length || fields.some((field, index) => !lines[index].startsWith(field) || !lines[index].slice(field.length).trim())) {
    throw new Error('プロンプト強化の出力形式が不正です')
  }
  for (const match of text.matchAll(/At\s+(\d{2}):(\d{2}\.\d{3})/g)) {
    const seconds = Number(match[1]) * 60 + Number(match[2])
    if (seconds >= durationSec) throw new Error('プロンプト強化のShot時刻が動画尺を超えています')
  }
  return text
}

async function callImageRewriter(model: string, prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.5, top_p: 0.9, num_predict: 700 },
    }),
  })
  if (!res.ok) throw new Error(`プロンプト強化に失敗しました (${res.status})`)
  const json = (await res.json()) as { response?: string }
  return (json.response ?? '').trim()
}

/** 一言 → 画像本番プロンプト(選択中の画像モデルの公式仕様で展開)。
 * 韓国語/中国語/日本語の混入を防ぐため、検出したら英語強制で1回だけ再生成し、
 * それでも残れば除去する(出力は必ず英語のみ)。 */
export async function rewriteImageViaOllama(userText: string, model: ImageModel): Promise<string> {
  const m = IMAGE_REWRITER_MODELS[model]
  if (!m) throw new Error('このモデルはプロンプト強化に対応していません')
  const idea = userText.trim()

  let out = await callImageRewriter(m, idea)
  try {
    return validateImageRewrite(out, idea, model)
  } catch (error) {
    if (!isCjkError(error)) throw error
    // 英語強制を明示してもう一度だけ
    out = await callImageRewriter(
      m,
      `${idea}\n\n(Write the entire prompt in English only. Do NOT use any Japanese, Chinese, or Korean characters.)`,
    )
  }
  try {
    return validateImageRewrite(out, idea, model)
  } catch (error) {
    if (!isCjkError(error)) throw error
    // 最終手段: それでも残るCJKは除去して英語のみで返す(エラーで止めずユーザーは必ず結果を得る)
    return stripCjk(out)
  }
}

/** 一言 → H3本番プロンプト。Ollamaで生成(system は Modelfile に焼込済み) */
export async function rewriteViaOllama(userText: string, mode: GenerationMode, lengthSec: number): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: buildUserPrompt(userText, mode, lengthSec),
      stream: false,
      // 温度は忠実性優先で0.5(0.7だと稀に入力を無視して別シーンを生成した)
      options: { temperature: 0.5, top_k: 64, top_p: 0.95, num_predict: 900 },
    }),
  })
  if (!res.ok) throw new Error(`プロンプト強化に失敗しました (${res.status})`)
  const json = (await res.json()) as { response?: string }
  const out = (json.response ?? '').trim()
  if (!out) throw new Error('プロンプト強化の出力が空でした')
  return validateVideoRewrite(out, lengthSec, mode)
}

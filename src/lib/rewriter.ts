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

/** 残った日本語/中国語/韓国語(記号・全角含む)を除去し、除去跡の空カンマ・空白を整える(最終手段) */
function stripCjk(text: string): string {
  return text
    .replace(/[　-〿぀-ヿ㐀-鿿가-힯＀-￯]/g, '') // かな/漢字/ハングル/CJK記号/全角
    .replace(/,\s*(?=[,.;:])/g, '') // 連続/孤立カンマの整理
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim()
}

function isCjkError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('英語以外')
}

function isWordCountError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('語数')
}

/** 検証を通して最終文字列を得る。CJKは除去、語数は許容(短くても長くてもエラーにしない)。
 * 単一段落などの致命的な形式崩れのみ例外を投げる(=ユーザーは基本必ず結果を得られる)。 */
function finalizeImageRewrite(out: string, idea: string, model: ImageModel): string {
  try {
    return validateImageRewrite(out, idea, model)
  } catch (error) {
    if (isCjkError(error)) {
      if ([...requestedVisibleText(idea)].some((value) => CJK_RE.test(value))) throw error
      const stripped = stripCjk(out)
      try {
        return validateImageRewrite(stripped, idea, model)
      } catch (retryError) {
        if (isWordCountError(retryError)) return stripped
        throw retryError
      }
    }
    if (isWordCountError(error)) return out.trim()
    throw error
  }
}

function requestedVisibleText(input: string): Set<string> {
  const requested = new Set<string>()
  for (const match of input.matchAll(/「([^」\r\n]+)」|『([^』\r\n]+)』|"([^"\r\n]+)"/g)) {
    const value = match[1] ?? match[2] ?? match[3]
    const before = input.slice(Math.max(0, (match.index ?? 0) - 60), match.index)
    const after = input.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 40)
    const japaneseNegative = /^\s*(?:と)?\s*(?:表示|記載|印字|描画|書|入れ)[^。、\r\n]{0,12}(?:しない|しません|不要|禁止|なし)/.test(after)
    const englishNegative = /(?:do\s+not|don't|not|without)\s+(?:display|show|write)[^"\r\n]*$/i.test(before)
    const japaneseDisplayRequest = /^\s*(?:と)?\s*(?:表示|記載|印字|描画|書(?:く|いて)|入れ(?:る|て))/.test(after)
    const englishDisplayRequest = /(?:(?:sign|label|screen|display|poster|billboard|caption|text|logo|title|placard|marquee)\s+(?:reads?|says?|shows?|displays?)|(?:display|show|write|render)|text\s+is)\s*$/i.test(before)
    if (!japaneseNegative && !englishNegative && (japaneseDisplayRequest || englishDisplayRequest)) requested.add(value)
  }
  return requested
}

function withoutPreservedContent(text: string): string {
  return text.replace(/<d>[^<]*<\/d>/g, ' ').replace(/"[^"\r\n]*"/g, ' ')
}

export function validateImageRewrite(output: string, input: string, model: ImageModel): string {
  const text = output.trim()
  if (!text || /\r?\n/.test(text)) throw new Error('プロンプト強化の出力形式が単一段落ではありません')
  const allowed = requestedVisibleText(input)
  if ([...allowed].some((value) => !text.includes(`"${value}"`))) {
    throw new Error('プロンプト強化に指定された表示文字が残っていません')
  }
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
  const structuralDescription = withoutPreservedContent(lines[0].slice(fields[0].length).trim())
  if (!structuralDescription.startsWith('[Shot 1]')) throw new Error('プロンプト強化のShot番号が不正です')
  const laterShotHeaders = [...structuralDescription.matchAll(/\[Shot (\d+)\]\s+At\s+(\d{2}):(\d{2}\.\d{3})(,?)/g)]
  const shots = [1, ...laterShotHeaders.map((match) => Number(match[1]))]
  if (shots.length === 0 || shots.some((shot, index) => shot !== index + 1)) throw new Error('プロンプト強化のShot番号が不正です')
  if (mode === 'first_last' || mode === 'last') {
    const match = mode === 'first_last'
      ? /Picture 2 \(from Shot (\d+)\)/.exec(text)
      : /<Picture 1> \(from \[Shot (\d+)\]\)/.exec(text)
    if (!match || Number(match[1]) !== shots.at(-1)) throw new Error('プロンプト強化の参照画像アラインメントが不正です')
  }
  let previousSeconds = -1
  for (const match of laterShotHeaders) {
    const seconds = Number(match[2]) * 60 + Number(match[3])
    if (seconds >= durationSec) throw new Error('プロンプト強化のShot時刻が動画尺を超えています')
    if (seconds <= previousSeconds) throw new Error('プロンプト強化のShot時刻順が不正です')
    previousSeconds = seconds
  }
  if (laterShotHeaders.some((match) => match[4] !== ',')) throw new Error('プロンプト強化の出力形式が不正です')
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
  // 検証に引っかかったら(CJK混入・語数不足・形式崩れ)、英語+詳細を促して1回だけ再生成
  let needsRetry = false
  try {
    validateImageRewrite(out, idea, model)
  } catch {
    needsRetry = true
  }
  if (needsRetry) {
    out = await callImageRewriter(
      m,
      `${idea}\n\n(Write ONE detailed single-paragraph prompt in English only — no Japanese, Chinese, or Korean characters. Add rich, concrete visual detail (camera, lighting, texture, composition) so it is sufficiently long.)`,
    )
  }
  // CJKは除去・語数は許容して必ず結果を返す(段落崩れ等の致命的な時のみエラー)
  return finalizeImageRewrite(out, idea, model)
}

/** 現在の英語プロンプトに、日本語の抽象的な修正指示を反映して改善する(出力は英語のまま)。
 * 実プロンプトは英語を維持し、指示だけ日本語でOK。 */
export async function refineImageViaOllama(current: string, instruction: string, model: ImageModel): Promise<string> {
  const m = IMAGE_REWRITER_MODELS[model]
  if (!m) throw new Error('このモデルはプロンプト強化に対応していません')
  const cur = current.trim()
  const inst = instruction.trim()
  if (!cur) throw new Error('先にプロンプトを用意してください')
  if (!inst) throw new Error('修正の指示を入力してください')
  const prompt =
    `Existing image prompt:\n"""${cur}"""\n\n` +
    `Revision request (may be written in Japanese): ${inst}\n\n` +
    `Apply the revision to the existing prompt. IMPORTANT: change ONLY what the revision explicitly asks; keep ALL other concrete details — the subject identity, setting, background, lighting, camera, lens, composition, and mood — exactly the same as the original. ` +
    `Output ONE single-paragraph English prompt — English only, no Japanese, Chinese, or Korean characters. Output only the final prompt.`
  let out = await callImageRewriter(m, prompt)
  // CJK混入・形式崩れなら、英語強制でもう一度だけ再生成(除去より品質が良い)
  let needsRetry = false
  try {
    validateImageRewrite(out, '', model)
  } catch {
    needsRetry = true
  }
  if (needsRetry) {
    out = await callImageRewriter(
      m,
      `${prompt}\n\n(Write ONE detailed single-paragraph prompt in English ONLY. Absolutely no Japanese, Chinese, or Korean characters anywhere.)`,
    )
  }
  // 視認テキスト許容は無し('')=残ったCJKは必ず除去。語数は許容・段落は必須
  return finalizeImageRewrite(out, '', model)
}

/** 英語プロンプトを、ユーザーがレビューするための日本語に翻訳する(表示専用・実プロンプトは変えない) */
export async function translatePromptToJa(text: string): Promise<string> {
  const body = text.trim()
  if (!body) return ''
  const res = await fetch(`${OLLAMA_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    body: JSON.stringify({
      model: 'fw-translate-ja',
      prompt: body,
      stream: false,
      options: { temperature: 0.2, top_p: 0.9, num_predict: 700 },
    }),
  })
  if (!res.ok) throw new Error(`日本語訳に失敗しました (${res.status})`)
  const json = (await res.json()) as { response?: string }
  return (json.response ?? '').trim()
}

async function callVideoRewriter(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      // 温度は忠実性優先で0.5(0.7だと稀に入力を無視して別シーンを生成した)
      options: { temperature: 0.5, top_k: 64, top_p: 0.95, num_predict: 900 },
    }),
  })
  if (!res.ok) throw new Error(`プロンプト強化に失敗しました (${res.status})`)
  const json = (await res.json()) as { response?: string }
  const out = (json.response ?? '').trim()
  if (!out) throw new Error('プロンプト強化の出力が空でした')
  return out
}

/** 一言 → H3本番プロンプト。Ollamaで生成(system は Modelfile に焼込済み) */
export async function rewriteViaOllama(userText: string, mode: GenerationMode, lengthSec: number): Promise<string> {
  const out = await callVideoRewriter(buildUserPrompt(userText, mode, lengthSec))
  return validateVideoRewrite(out, lengthSec, mode)
}

/** 現在のH3プロンプトに日本語の抽象指示を反映する(3ブロック形式は厳守、セリフは原語保持)。 */
export async function refineVideoViaOllama(
  current: string,
  instruction: string,
  mode: GenerationMode,
  lengthSec: number,
): Promise<string> {
  const cur = current.trim()
  const inst = instruction.trim()
  if (!cur) throw new Error('先にプロンプトを用意してください')
  if (!inst) throw new Error('修正の指示を入力してください')
  const task = TASK_NAME[mode] ?? 'T2AV'
  const alignNote =
    mode === 'text'
      ? ''
      : ' Keep the reference-frame alignment line at the very top, followed by one blank line before the three fields, unchanged in format.'
  const base =
    `Existing MiniMax-H3 prompt (${task}, ${lengthSec.toFixed(2)} seconds):\n${cur}\n\n` +
    `Revision request (may be written in Japanese): ${inst}\n\n` +
    `Apply the revision to the existing prompt. IMPORTANT: change ONLY what the revision explicitly asks; keep ALL other concrete details — subjects, setting, actions, camera, lighting, mood, and sound — exactly the same as the original. ` +
    `Keep the EXACT same format: the three fields integrated_multimodal_description / overall_soundscape / non_diegetic_music as exactly three lines with no blank lines between them.${alignNote} ` +
    `Preserve any user dialogue, lyrics, or on-screen text in its original language exactly. Output only the prompt.`

  const out = await callVideoRewriter(base)
  try {
    return validateVideoRewrite(out, lengthSec, mode)
  } catch {
    // 形式が崩れたら念押しでもう一度だけ
    const retry = await callVideoRewriter(
      `${base}\n\n(Output exactly the three-field format with no blank lines between fields. Output only the prompt.)`,
    )
    return validateVideoRewrite(retry, lengthSec, mode)
  }
}

import type { GenerationMode } from './types'

/** プロンプト自動強化(MiniMax-H3 Prompt Rewriter 8B)。
 * ComfyUIの重いbf16(17.5GB)は12GBで失速したため、Q8 GGUF(8.7GB)を
 * Ollamaで常駐実行する軽量構成に変更。アプリは Ollama HTTP API を叩く。 */
export const OLLAMA_MODEL = 'frameweaver-rewriter'

/** 同一オリジンの /ollama(Viteプロキシ経由)→ 127.0.0.1:11434。LAN内の別端末でも同じURLで届く */
export const OLLAMA_URL =
  import.meta.env.VITE_OLLAMA_URL ??
  (typeof location !== 'undefined' ? `${location.origin}/ollama` : 'http://127.0.0.1:11434')

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

/** 一言リクエストに、タスク種別と秒数を添えたユーザメッセージ */
function buildUserPrompt(userText: string, mode: GenerationMode, lengthSec: number): string {
  const task = TASK_NAME[mode] ?? 'T2AV'
  return `Task type: ${task}. Effective duration: ${lengthSec.toFixed(2)} seconds.\nUser request: ${userText.trim()}`
}

/** Ollamaにモデルが登録されているか(=強化ボタン表示可否) */
export async function rewriterInstalled(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' })
    if (!res.ok) return false
    const json = (await res.json()) as { models?: { name?: string }[] }
    return (json.models ?? []).some((m) => (m.name ?? '').startsWith(OLLAMA_MODEL))
  } catch {
    return false
  }
}

/** 一言 → H3本番プロンプト。Ollamaで生成(system は Modelfile に焼込済み) */
export async function rewriteViaOllama(userText: string, mode: GenerationMode, lengthSec: number): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: buildUserPrompt(userText, mode, lengthSec),
      stream: false,
      options: { temperature: 0.7, top_k: 64, top_p: 0.95, num_predict: 900 },
    }),
  })
  if (!res.ok) throw new Error(`プロンプト強化に失敗しました (${res.status})`)
  const json = (await res.json()) as { response?: string }
  const out = (json.response ?? '').trim()
  if (!out) throw new Error('プロンプト強化の出力が空でした')
  return out
}

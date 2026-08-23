// ============================================================================
// FrameWeaver LoRA コレクター
//   Civitaiの人気LoRAをベースモデル別に自動DLし、アプリのLoRAカタログ用メタ
//   (frameweaver_lora_meta.json)と人間用カタログ(docs/LORA_CATALOG.md)を生成する。
//
// 使い方(PowerShell):
//   $env:CIVITAI_TOKEN = "<あなたのCivitai APIキー>"   # Manage Account → API Keys で発行
//   node scripts/fetch-loras.mjs
//
// 環境変数:
//   CIVITAI_TOKEN  (必須) Civitai APIキー。NSFW/一部LoRAのDLに必要
//   LORA_DIR       (任意) LoRA保存先。既定 C:/AI/ComfyUI_Data/models/loras
//   CKPT_DIR       (任意) Checkpoint保存先。既定 C:/AI/ComfyUI_Data/models/checkpoints
//
// 特徴: 429(レート制限)を指数バックオフでリトライ / 既存ファイルはスキップ /
//        ベースモデル別サブフォルダに自動仕分け(アプリが対象モデルを判別できる)。
//
// 注意: 収集対象(下の CURATED / QUERIES)は編集可。動物(ケモナー)エロ等、不要な
//        ジャンルは各自 loras/_trash 等へ退避してよい。未成年表現は絶対に扱わない。
// ============================================================================
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const TOKEN = process.env.CIVITAI_TOKEN
if (!TOKEN) {
  console.error('CIVITAI_TOKEN が未設定です。PowerShell で $env:CIVITAI_TOKEN = "<APIキー>" を設定してください。')
  process.exit(1)
}
const LORA = process.env.LORA_DIR || 'C:/AI/ComfyUI_Data/models/loras'
const CKPT = process.env.CKPT_DIR || 'C:/AI/ComfyUI_Data/models/checkpoints'
const META = path.join(LORA, 'frameweaver_lora_meta.json')
const MD = path.join(process.cwd(), 'docs', 'LORA_CATALOG.md')
const AUTH = { Authorization: `Bearer ${TOKEN}` }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`)

// キュレーション(実写/アニメの定番。Civitaiのモデルページ番号)。自由に編集可。
const CURATED = [
  2246543, 2523771, 2268008, 2194714, 2283998, 2185778, 2175402, 2186181, // Z-Image系
  2605595, 2746042, 1426727, 2759847, 2594665, 2088956, 2764349, 2727641, // Krea2系
]
// ベースモデル別に人気LoRAを自動収集([baseModel, 取得件数])。件数は調整可。
const QUERIES = [
  ['Illustrious', 60],
  ['NoobAI', 30],
  ['Pony', 40],
  ['SDXL 1.0', 15],
  ['ZImageTurbo', 30],
  ['Krea 2', 25],
  ['Qwen', 15],
]

const slug = (s) => (s || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'other'
const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
function genre(name, desc, trig) {
  const t = `${name} ${desc} ${trig.join(' ')}`.toLowerCase()
  if (/\b(style|artstyle|aesthetic|illustration|painting|niji|watercolor|lineart)\b/.test(t)) return '画風'
  if (/\b(nsfw|nude|sex|penis|pussy|cum|hentai|explicit|blowjob|paizuri)\b/.test(t)) return 'NSFW表現'
  if (/\b(pose|position|angle|pov|lying|sitting|standing|spread)\b/.test(t)) return 'ポーズ/構図'
  if (/\b(detail|quality|enhancer|slider|fix|booster|skin|tweaker)\b/.test(t)) return '品質補正'
  if (/\b(character|char|girl|waifu|face|idol|woman|1girl)\b/.test(t)) return 'キャラ/人物'
  return 'その他'
}

// 429/5xxは指数バックオフ。成功後も最低間隔を空けてレート制限を避ける。
async function api(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: AUTH })
    if (r.ok) { await sleep(1300); return r.json() }
    if (r.status === 429 || r.status >= 500) { await sleep(Math.min(60000, 2000 * 2 ** i)); continue }
    throw new Error(`API ${r.status}`)
  }
  throw new Error('rate-limited (max retries)')
}

async function topLoras(base, limit) {
  try {
    const j = await api(`https://civitai.com/api/v1/models?types=LORA&baseModels=${encodeURIComponent(base)}&sort=Most%20Downloaded&limit=${limit}&nsfw=true`)
    return (j.items || []).map((m) => m.id)
  } catch (e) { log(`auto ${base} 失敗: ${e.message}`); return [] }
}

const meta = fs.existsSync(META) ? JSON.parse(fs.readFileSync(META, 'utf8')) : {}

async function handle(id) {
  let info
  try { info = await api(`https://civitai.com/api/v1/models/${id}`) } catch (e) { log(`SKIP ${id} ${e.message}`); return }
  if (info.type !== 'LORA' && info.type !== 'Checkpoint') return
  const ver = (info.modelVersions || [])[0]; if (!ver) return
  const file = (ver.files || []).find((f) => f.primary) || (ver.files || [])[0]; if (!file) return
  const base = slug(ver.baseModel)
  const fname = file.name.replace(/[\\/:*?"<>|]/g, '_')
  const dir = info.type === 'Checkpoint' ? CKPT : path.join(LORA, base)
  const key = `${base}/${fname}`
  if (info.type === 'LORA') {
    const trig = ver.trainedWords || []
    const desc = stripHtml(info.description).slice(0, 300)
    const img = (ver.images || []).find((x) => !x.type || x.type === 'image')?.url
    meta[key] = { name: info.name, base: ver.baseModel, genre: genre(info.name, desc, trig), triggers: trig, nsfw: !!info.nsfw, url: `https://civitai.com/models/${id}`, desc, ...(img && { image: img }) }
    fs.mkdirSync(LORA, { recursive: true })
    fs.writeFileSync(META, JSON.stringify(meta))
  }
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, fname)
  if (fs.existsSync(out) && fs.statSync(out).size > 1_000_000) return
  log(`DL ${info.type}/${ver.baseModel} -> ${key}`)
  const rc = spawnSync('curl', ['-L', '-C', '-', '--retry', '5', '--retry-delay', '10', '-H', `Authorization: Bearer ${TOKEN}`, '-o', out, file.downloadUrl], { stdio: ['ignore', 'ignore', 'ignore'] })
  if (rc.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 1_000_000) {
    log(`FAILED ${key}(early-access/権限の可能性)`)
    try { if (fs.existsSync(out) && fs.statSync(out).size < 1_000_000) fs.unlinkSync(out) } catch {}
  }
}

log('=== collect ids ===')
let ids = [...CURATED]
for (const [b, l] of QUERIES) ids = ids.concat(await topLoras(b, l))
ids = [...new Set(ids)]
log(`対象 ${ids.length} モデル`)
let n = 0
for (const id of ids) { await handle(id); if (++n % 20 === 0) log(`progress ${n}/${ids.length}`) }

// 人間用カタログMD
const rows = Object.entries(meta).map(([key, v]) => ({ key, baseSlug: key.split('/')[0], ...v }))
rows.sort((a, b) => a.baseSlug.localeCompare(b.baseSlug) || a.genre.localeCompare(b.genre) || a.name.localeCompare(b.name))
let md = '# LoRAカタログ(自動収集)\n\nCivitai人気LoRAを自動DL・分類。**トリガー**はプロンプトに入れないと効かない。ファイル名がアプリの選択候補に対応。\n'
let cur = ''
for (const r of rows) {
  if (r.baseSlug !== cur) { cur = r.baseSlug; md += `\n## ${r.base} (${r.baseSlug})\n\n| 名前 | ジャンル | トリガー | NSFW | ファイル |\n|---|---|---|---|---|\n` }
  const t = r.triggers.length ? '`' + r.triggers.join('`, `') + '`' : '—'
  md += `| [${r.name}](${r.url}) | ${r.genre} | ${t} | ${r.nsfw ? 'あり' : '—'} | \`${r.key}\` |\n`
}
fs.mkdirSync(path.dirname(MD), { recursive: true })
fs.writeFileSync(MD, md)
log(`=== 完了: メタ ${Object.keys(meta).length}件 / カタログ ${MD} ===`)

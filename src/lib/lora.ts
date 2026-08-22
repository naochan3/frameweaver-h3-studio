/** LoRAの適用対象。LoRAは学習元モデル専用で、別モデルに入れても効かない(または壊れる)。
 * video=MiniMax H3 / zimage=Z-Image Turbo / krea2=Krea 2 Turbo / anime=Illustrious系SDXL /
 * system=Turbo等の自動適用(手動選択の対象外) / unsupported=本スタジオ未対応モデル用 / unknown=判別不能 */
export type LoraTarget = 'video' | 'zimage' | 'krea2' | 'anime' | 'system' | 'unsupported' | 'unknown'

export interface LoraInfo {
  target: LoraTarget
  note: string
}

/** 導入済みLoRAの確定情報(一次資料で確認済み)。
 * 根拠: hinano/ZIT=実ワークフロー(06_hinano_v2_lora_test.json)でZ-Image構成を確認。
 * K2R_*=Krea 2 Raw学習(RawのLoRAはTurboでそのまま動く。Civitai公式ecosystem解説)。
 * larryvrh turbo_v4=専用サンプラー必須+pruned系で過飽和報告あり(GitHub issue #5)。 */
const CATALOG: Record<string, LoraInfo> = {
  'hinano_v2_lora.safetensors': {
    target: 'zimage',
    note: 'Z-Image用キャラLoRA(ひなの v2)。トリガー「hinano」、強度0.7実績',
  },
  'hinano_v1.safetensors': {
    target: 'zimage',
    note: 'Z-Image用キャラLoRA(ひなの v1・旧版)。v2推奨',
  },
  'Amateur_Photography_ZIT.safetensors': {
    target: 'zimage',
    note: 'Z-Image用画風LoRA(スマホ写真風)。強度0.2前後の実績',
  },
  'K2R_KTMix_KR_v01.safetensors': {
    target: 'krea2',
    note: 'Krea 2用キャラLoRA(KTMix)。強度0.4〜0.8推奨',
  },
  'K2R_KTMix_KR_beta.safetensors': {
    target: 'krea2',
    note: 'Krea 2用キャラLoRA(KTMix β・旧版)。v01推奨',
  },
  'K2R_yayoi_S1_1k.safetensors': {
    target: 'krea2',
    note: 'Krea 2用キャラLoRA(yayoi)',
  },
  'h3-realism-people-t2v-i2v-r2v.safetensors': {
    target: 'video',
    note: 'H3用実写人物LoRA(fal製・T2V/I2V/R2V対応)。プロンプト先頭にトリガー「r34l1sm」、強度1.0(軽めは0.6〜0.8)',
  },
  'minimax_h3_turbo_v4_step600_ema.safetensors': {
    target: 'system',
    note: 'larryvrh版H3高速化LoRA。専用サンプラー必須+品質報告に難あり(未使用推奨)',
  },
}

/** ファイル名からLoRAの適用対象と説明を返す。カタログ優先、なければ
 * DL時のフォルダ接頭辞(loras/<base>/)→命名規則の順で推定 */
export function classifyLora(name: string): LoraInfo {
  const base = name.split(/[\\/]/).pop() ?? name
  const hit = CATALOG[base]
  if (hit) return hit

  // 自動DLでベースモデル別サブフォルダに振り分けているので、パス接頭辞が最も確実
  const dir = name.toLowerCase().replace(/\\/g, '/')
  if (/^(illustrious|noobai|pony|sdxl\d*|sdxl)\//.test(dir))
    return { target: 'anime', note: 'アニメ(Illustrious系SDXL)用のキャラ・画風LoRA' }
  if (/^(zimageturbo|zimage)\//.test(dir)) return { target: 'zimage', note: 'Z-Image用のキャラ・画風LoRA' }
  if (/^(krea2|krea_2)\//.test(dir)) return { target: 'krea2', note: 'Krea 2用のキャラ・画風LoRA' }
  if (/^qwen\//.test(dir)) return { target: 'krea2', note: 'Qwen-Image系LoRA(Krea 2で動く場合あり・未保証)' }

  const n = base.toLowerCase()
  // アニメ系SDXL(本スタジオはアニメモデルに対応)。wan/hunyuan/flux のみ未対応
  if (/wan\s*2|hunyuan|flux/.test(n)) {
    return { target: 'unsupported', note: '本スタジオ未対応モデル用のLoRA(選択しても効かない)' }
  }
  if (/illustrious|noobai|pony|sdxl/.test(n)) {
    return { target: 'anime', note: 'アニメ(Illustrious系SDXL)用のキャラ・画風LoRA' }
  }
  if (n.includes('minimax') || n.includes('_h3_') || n.startsWith('h3_')) {
    if (n.includes('turbo')) {
      return { target: 'system', note: '【システム】動画の高速化LoRA(自動適用・手動選択不要)' }
    }
    return { target: 'video', note: '動画(MiniMax H3)用のキャラ・画風LoRA' }
  }
  if (n.startsWith('k2r_') || n.includes('krea2') || n.includes('krea_2')) {
    return { target: 'krea2', note: 'Krea 2用のキャラ・画風LoRA' }
  }
  if (n.includes('_zit') || n.includes('zit.') || n.includes('zimage') || n.includes('z_image') || n.includes('z-image')) {
    return { target: 'zimage', note: 'Z-Image用のキャラ・画風LoRA' }
  }
  return { target: 'unknown', note: '【未確認】対象モデル不明。効かない可能性あり' }
}

/** 指定モデルの追加LoRA候補を返す。compatible=対象一致、unknown=判別不能(自己責任で選択可)。
 * システムLoRA・未対応モデル用・他モデル用は候補に出さない(誤選択で「効かない」事故を防ぐ) */
export function selectableLoras(
  list: string[],
  target: 'video' | 'zimage' | 'krea2' | 'anime',
): { compatible: string[]; unknown: string[] } {
  const compatible: string[] = []
  const unknown: string[] = []
  for (const name of list) {
    const info = classifyLora(name)
    if (info.target === target) compatible.push(name)
    else if (info.target === 'unknown') unknown.push(name)
  }
  return { compatible, unknown }
}

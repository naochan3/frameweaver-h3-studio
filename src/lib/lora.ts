/** LoRAファイル名から役割の補足を返す(datalistの候補ラベルに表示) */
export function loraNote(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('turbo') && n.includes('ref2v')) return '【システム】Reference用の高速化LoRA(自動適用・手動選択不要)'
  if (n.includes('turbo')) return '【システム】動画の高速化LoRA(自動適用・手動選択不要)'
  if (n.includes('heretic') || n.includes('uncensored')) return '【システム】NSFW用エンコーダ関連(手動選択不要)'
  return '自作/導入したキャラ・画風LoRA'
}

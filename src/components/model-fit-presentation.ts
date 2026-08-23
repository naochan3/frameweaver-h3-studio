import type { ModelFit } from '../lib/model-capability'

export function modelFitLabel(fit: ModelFit): string {
  if (fit.status === 'recommended') return '推奨'
  if (fit.status === 'available') return '実行可'
  if (fit.status === 'warning') return '注意'
  return fit.reasons.includes('missing-model-files') ? '未導入' : '利用不可'
}

export function modelFitSummary(fit: ModelFit): string {
  if (fit.missingFiles.length > 0) return `不足: ${fit.missingFiles.join(', ')}`
  if (fit.reasons.includes('insufficient-vram')) return 'VRAM容量不足'
  if (fit.reasons.includes('unsupported-accelerator')) return 'GPU非対応'
  if (fit.reasons.includes('capability-unavailable')) return '能力API停止'
  if (fit.reasons.includes('stale-capability')) return '能力情報が古い'
  if (fit.reasons.includes('degraded-capability')) return '能力情報が一部欠落'
  if (fit.reasons.includes('low-free-vram')) return '空きVRAM不足'
  if (fit.reasons.includes('recommended-memory')) return '導入済み・推奨VRAM'
  return '導入済み・最小VRAM'
}

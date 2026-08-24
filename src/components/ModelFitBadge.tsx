import type { ModelFit } from '../lib/model-capability'
import { modelFitLabel, modelFitSummary } from './model-fit-presentation'

const STATUS_CLASS: Record<ModelFit['status'], string> = {
  recommended: 'border-green-200 bg-green-50 text-green-700',
  available: 'border-blue-200 bg-blue-50 text-blue-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  unavailable: 'border-cream-200 bg-cream-100 text-ink-500',
}

export function ModelFitBadge({ fit }: { fit: ModelFit }) {
  const summary = modelFitSummary(fit)
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_CLASS[fit.status]}`}
      title={summary}
    >
      <span>{modelFitLabel(fit)}</span>
      <span className="hidden max-w-44 truncate font-normal sm:inline">{summary}</span>
    </span>
  )
}

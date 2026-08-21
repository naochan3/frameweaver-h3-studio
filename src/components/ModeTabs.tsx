import type { GenerationMode } from '../lib/types'
import { useGenerationStore } from '../store/generation'

const MODES: { mode: GenerationMode; label: string; sub: string }[] = [
  { mode: 'text', label: 'Text', sub: 'T2VA' },
  { mode: 'first', label: 'First', sub: 'I2VA' },
  { mode: 'first_last', label: 'First + Last', sub: 'FL2VA' },
  { mode: 'last', label: 'Last', sub: 'L2VA' },
  { mode: 'reference', label: 'Reference', sub: 'Ref2VA' },
]

export function ModeTabs() {
  const mode = useGenerationStore((s) => s.params.mode)
  const setMode = useGenerationStore((s) => s.setMode)

  return (
    <nav className="flex gap-1 overflow-x-auto rounded-2xl bg-white p-1.5 shadow-sm sm:p-2">
      {MODES.map((m) => {
        const active = m.mode === mode
        return (
          <button
            key={m.mode}
            onClick={() => setMode(m.mode)}
            className={`flex shrink-0 flex-col items-center whitespace-nowrap rounded-xl px-3 py-2 transition-colors sm:flex-1 sm:px-4 ${
              active ? 'bg-accent-500 text-white shadow' : 'text-ink-600 hover:bg-cream-100'
            }`}
          >
            <span className="text-sm font-bold">{m.label}</span>
            <span className={`text-[10px] tracking-wider ${active ? 'text-orange-100' : 'text-ink-400'}`}>{m.sub}</span>
          </button>
        )
      })}
    </nav>
  )
}

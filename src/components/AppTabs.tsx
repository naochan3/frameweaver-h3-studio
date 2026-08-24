import { useGenerationStore } from '../store/generation'

export function AppTabs() {
  const appTab = useGenerationStore((s) => s.appTab)
  const setAppTab = useGenerationStore((s) => s.setAppTab)

  const tabs = [
    { key: 'video' as const, label: '動画生成', sub: 'MiniMax H3' },
    { key: 'image' as const, label: '画像生成', sub: 'Krea 2 / Z-Image' },
  ]

  return (
    <nav className="flex gap-1 rounded-2xl bg-surface p-1.5 shadow-sm">
      {tabs.map((t) => {
        const active = appTab === t.key
        return (
          <button
            key={t.key}
            onClick={() => setAppTab(t.key)}
            className={`flex flex-1 flex-col items-center justify-center gap-0 rounded-xl px-2 py-2 transition-all duration-300 sm:flex-row sm:gap-2 sm:px-4 sm:py-2.5 ${
              active ? 'bg-onsurface text-white shadow' : 'text-ink-600 hover:bg-cream-100'
            }`}
          >
            <span className="whitespace-nowrap text-sm font-bold">{t.label}</span>
            <span className={`whitespace-nowrap text-[10px] tracking-wider ${active ? 'text-white/60' : 'text-ink-400'}`}>{t.sub}</span>
          </button>
        )
      })}
    </nav>
  )
}

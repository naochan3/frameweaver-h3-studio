import { useGenerationStore } from '../store/generation'

export function AppTabs() {
  const appTab = useGenerationStore((s) => s.appTab)
  const setAppTab = useGenerationStore((s) => s.setAppTab)

  const tabs = [
    { key: 'video' as const, label: '動画生成', sub: 'MiniMax H3' },
    { key: 'image' as const, label: '画像生成', sub: 'Krea 2 / Z-Image' },
  ]

  return (
    <nav className="flex gap-1 rounded-2xl bg-white p-1.5 shadow-sm">
      {tabs.map((t) => {
        const active = appTab === t.key
        return (
          <button
            key={t.key}
            onClick={() => setAppTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 transition-all duration-300 ${
              active ? 'bg-ink-900 text-white shadow' : 'text-ink-600 hover:bg-cream-100'
            }`}
          >
            <span className="text-sm font-bold">{t.label}</span>
            <span className={`text-[10px] tracking-wider ${active ? 'text-white/60' : 'text-ink-400'}`}>{t.sub}</span>
          </button>
        )
      })}
    </nav>
  )
}

import { Header } from './components/Header'
import { AppTabs } from './components/AppTabs'
import { ModeTabs } from './components/ModeTabs'
import { ScenePanel } from './components/ScenePanel'
import { SourcePanel } from './components/SourcePanel'
import { RecipePanel } from './components/RecipePanel'
import { OutputPanel } from './components/OutputPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { ImageStudio } from './components/ImageStudio'
import { GuideOverlay } from './components/GuideOverlay'
import { GenerateBar } from './components/GenerateBar'
import { HistoryDetail } from './components/HistoryDetail'
import { LoraCatalog } from './components/LoraCatalog'
import { useGenerationStore } from './store/generation'

export default function App() {
  const appTab = useGenerationStore((s) => s.appTab)

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-[1600px] space-y-4 p-4">
        <AppTabs />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="space-y-4">
            {appTab === 'video' ? (
              <>
                <ModeTabs />
                <ScenePanel />
                <SourcePanel />
                <RecipePanel />
              </>
            ) : (
              <ImageStudio />
            )}
          </div>
          <div className="space-y-4">
            <OutputPanel />
            <HistoryPanel />
          </div>
        </div>
      </main>
      <GenerateBar />
      <footer className="py-3 text-center text-xs text-ink-400">
        FrameWeaver H3 Studio v1.0 | ComfyUI + MiniMax H3 + Z-Image + Krea 2
      </footer>
      <GuideOverlay />
      <HistoryDetail />
      <LoraCatalog />
    </div>
  )
}

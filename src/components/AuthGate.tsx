import { useEffect, useState, type ReactNode } from 'react'
import { fetchAuthState, HttpApiError, type AuthState } from '../lib/auth-api'

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetchAuthState().then(setState).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      if (reason instanceof HttpApiError && reason.status === 401) {
        setState({ enabled: true, authenticated: false })
      } else {
        setError(reason instanceof Error ? reason.message : '認証状態を確認できません')
      }
    })
    return () => controller.abort()
  }, [])

  if (error) return <main className="mx-auto max-w-md p-8 text-center"><h1 className="text-xl font-bold">接続エラー</h1><p className="mt-3 text-sm text-red-600">{error}</p></main>
  if (!state) return <main className="p-8 text-center" aria-busy="true">認証を確認しています…</main>
  if (state.enabled && !state.authenticated) return (
    <main className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-bold">FrameWeaver H3 Studio</h1>
      <p className="mt-3 text-sm text-ink-600">許可されたDiscordユーザーでログインしてください。</p>
      <a className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-accent-500 px-6 font-bold text-white" href="/auth/login">Discordでログイン</a>
    </main>
  )
  return <>{children}</>
}

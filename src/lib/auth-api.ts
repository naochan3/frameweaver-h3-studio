export interface AuthState {
  enabled: boolean
  authenticated: boolean
  displayName?: string
}

export class HttpApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'HttpApiError'
  }
}

export async function fetchAuthState(): Promise<AuthState> {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' })
  const body = await response.json().catch(() => null) as (AuthState & { error?: string }) | null
  if (!response.ok) throw new HttpApiError(response.status, body?.error ?? `認証確認に失敗しました (${response.status})`)
  return body as AuthState
}

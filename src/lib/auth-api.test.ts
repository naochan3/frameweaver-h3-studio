import { describe, expect, it, vi } from 'vitest'
import { fetchAuthState } from './auth-api'

describe('auth api', () => {
  it('uses same-origin credentials and preserves HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"denied"}', { status: 403 })))
    await expect(fetchAuthState()).rejects.toMatchObject({ status: 403, message: 'denied' })
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', { credentials: 'same-origin' })
    vi.unstubAllGlobals()
  })
})

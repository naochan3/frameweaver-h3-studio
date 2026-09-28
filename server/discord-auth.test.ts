import { describe, expect, it } from 'vitest'
import { discordAuthConfig } from './discord-auth.js'

describe('Discord auth configuration', () => {
  it('fails closed when auth is enabled without an allowlist or OAuth settings', () => {
    const config = discordAuthConfig({ DISCORD_AUTH_ENABLED: '1' })

    expect(config.enabled).toBe(true)
    expect(config.ready).toBe(false)
    expect(config.missing).toContain('DISCORD_ALLOWED_USER_IDS')
  })

  it('accepts only a complete configuration with numeric allowlist IDs', () => {
    const config = discordAuthConfig({
      DISCORD_AUTH_ENABLED: '1',
      DISCORD_CLIENT_ID: 'client-id',
      DISCORD_CLIENT_SECRET: 'secret',
      DISCORD_REDIRECT_URI: 'https://studio.tailnet.ts.net/auth/discord/callback',
      DISCORD_ALLOWED_USER_IDS: '123456789012345678',
    })

    expect(config.ready).toBe(true)
    expect(config.allowedUserIds.has('123456789012345678')).toBe(true)
  })
})

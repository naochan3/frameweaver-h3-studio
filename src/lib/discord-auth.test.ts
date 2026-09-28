import { describe, expect, it } from 'vitest'
import { isDiscordUserAllowed, parseAllowedDiscordUserIds } from './discord-auth'

describe('Discord allowlist', () => {
  it('allows only an exact configured Discord snowflake', () => {
    const allowed = parseAllowedDiscordUserIds('123456789012345678, 987654321098765432')

    expect(isDiscordUserAllowed('123456789012345678', allowed)).toBe(true)
    expect(isDiscordUserAllowed('123456789012345679', allowed)).toBe(false)
  })

  it('fails closed for empty, display-name, and malformed entries', () => {
    const allowed = parseAllowedDiscordUserIds('creator, 1234, 123456789012345678')

    expect([...allowed]).toEqual(['123456789012345678'])
    expect(isDiscordUserAllowed('', allowed)).toBe(false)
    expect(isDiscordUserAllowed('creator', allowed)).toBe(false)
  })
})

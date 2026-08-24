const DISCORD_USER_ID = /^[1-9]\d{16,19}$/

/** 環境変数のDiscord User ID一覧を正規化する。無効な値は許可しない。 */
export function parseAllowedDiscordUserIds(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => DISCORD_USER_ID.test(id)),
  )
}

/** Discordの表示名ではなく不変の数値User IDだけで判定する。 */
export function isDiscordUserAllowed(userId: string | undefined, allowedUserIds: Set<string>): boolean {
  return typeof userId === 'string' && allowedUserIds.has(userId)
}

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Plugin } from 'vite'
import { isDiscordUserAllowed, parseAllowedDiscordUserIds } from '../src/lib/discord-auth.js'

type Env = Record<string, string | undefined>

type DiscordAuthConfig = {
  enabled: boolean
  ready: boolean
  missing: string[]
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  allowedUserIds: Set<string>
}

type Session = { userId: string; username: string; expiresAt: number }

const SESSION_COOKIE = 'frameweaver_session'
const STATE_COOKIE = 'frameweaver_oauth_state'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const STATE_TTL_MS = 10 * 60 * 1000

export function discordAuthConfig(env: Env): DiscordAuthConfig {
  const enabled = env.DISCORD_AUTH_ENABLED === '1'
  const allowedUserIds = parseAllowedDiscordUserIds(env.DISCORD_ALLOWED_USER_IDS)
  const required = [
    ['DISCORD_CLIENT_ID', env.DISCORD_CLIENT_ID],
    ['DISCORD_CLIENT_SECRET', env.DISCORD_CLIENT_SECRET],
    ['DISCORD_REDIRECT_URI', env.DISCORD_REDIRECT_URI],
  ] as const
  const missing = enabled
    ? [...required.filter(([, value]) => !value).map(([name]) => name), ...(allowedUserIds.size ? [] : ['DISCORD_ALLOWED_USER_IDS'])]
    : []

  return {
    enabled,
    ready: !enabled || missing.length === 0,
    missing,
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    redirectUri: env.DISCORD_REDIRECT_URI,
    allowedUserIds,
  }
}

function readCookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? '').split(';').flatMap((part) => {
      const [name, ...value] = part.trim().split('=')
      return name && value.length ? [[name, decodeURIComponent(value.join('='))]] : []
    }),
  )
}

function setCookie(res: ServerResponse, name: string, value: string, maxAgeSeconds: number) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`)
}

function clearCookie(res: ServerResponse, name: string) {
  res.setHeader('Set-Cookie', `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`)
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

export function discordAuthPlugin(env: Env = process.env): Plugin {
  const config = discordAuthConfig(env)
  const states = new Map<string, number>()
  const sessions = new Map<string, Session>()

  const activeSession = (req: IncomingMessage) => {
    const token = readCookies(req)[SESSION_COOKIE]
    const session = token ? sessions.get(token) : undefined
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token)
      return undefined
    }
    return session
  }

  const deny = (res: ServerResponse) => json(res, config.ready ? 401 : 503, { error: config.ready ? 'authentication_required' : 'discord_auth_not_configured' })

  const guard = (req: IncomingMessage, res: ServerResponse) => {
    if (!config.enabled) return true
    if (!config.ready || !activeSession(req)) {
      deny(res)
      return false
    }
    return true
  }

  return {
    name: 'discord-allowlist-auth',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url ?? '/', 'https://frameweaver.invalid').pathname
        if (path === '/api/auth/session') {
          if (!config.enabled) return json(res, 200, { enabled: false, authenticated: false })
          if (!config.ready) return json(res, 503, { enabled: true, authenticated: false, error: 'discord_auth_not_configured' })
          const session = activeSession(req)
          return json(res, 200, session
            ? { enabled: true, authenticated: true, user: { id: session.userId, username: session.username } }
            : { enabled: true, authenticated: false })
        }

        if (path === '/auth/logout' && req.method === 'POST') {
          const token = readCookies(req)[SESSION_COOKIE]
          if (token) sessions.delete(token)
          clearCookie(res, SESSION_COOKIE)
          return json(res, 200, { ok: true })
        }

        if (path === '/auth/discord') {
          if (!config.enabled || !config.ready || !config.clientId || !config.redirectUri) return deny(res)
          const state = randomBytes(32).toString('base64url')
          states.set(state, Date.now() + STATE_TTL_MS)
          setCookie(res, STATE_COOKIE, state, STATE_TTL_MS / 1000)
          const query = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            response_type: 'code',
            scope: 'identify',
            state,
          })
          res.statusCode = 302
          res.setHeader('Location', `https://discord.com/oauth2/authorize?${query}`)
          return res.end()
        }

        if (path === '/auth/discord/callback') {
          if (!config.enabled || !config.ready || !config.clientId || !config.clientSecret || !config.redirectUri) return deny(res)
          const url = new URL(req.url ?? '/', 'https://frameweaver.invalid')
          const state = url.searchParams.get('state')
          const code = url.searchParams.get('code')
          const validState = state && state === readCookies(req)[STATE_COOKIE] && states.get(state) && states.get(state)! > Date.now()
          if (!validState || !code) return json(res, 400, { error: 'invalid_oauth_callback' })
          states.delete(state)
          clearCookie(res, STATE_COOKIE)

          try {
            const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                grant_type: 'authorization_code',
                code,
                redirect_uri: config.redirectUri,
              }),
            })
            const token = await tokenResponse.json() as { access_token?: string }
            if (!tokenResponse.ok || !token.access_token) return json(res, 502, { error: 'discord_token_exchange_failed' })
            const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } })
            const user = await userResponse.json() as { id?: string; username?: string; global_name?: string }
            if (!userResponse.ok || !isDiscordUserAllowed(user.id, config.allowedUserIds)) return json(res, 403, { error: 'discord_user_not_allowed' })

            const sessionToken = randomBytes(32).toString('base64url')
            sessions.set(sessionToken, { userId: user.id!, username: user.global_name || user.username || user.id!, expiresAt: Date.now() + SESSION_TTL_MS })
            setCookie(res, SESSION_COOKIE, sessionToken, SESSION_TTL_MS / 1000)
            res.statusCode = 302
            res.setHeader('Location', '/')
            return res.end()
          } catch {
            return json(res, 502, { error: 'discord_unavailable' })
          }
        }

        if (path.startsWith('/comfy') || path === '/api/fleet') {
          if (!guard(req, res)) return
        }
        next()
      })

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Socket) => {
        if (config.enabled && req.url?.startsWith('/comfy') && (!config.ready || !activeSession(req))) socket.destroy()
      })
    },
  }
}

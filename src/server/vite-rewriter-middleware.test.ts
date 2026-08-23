import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRewriterGateway } from './rewriter-gateway'
import { createViteRewriterMiddleware } from './vite-rewriter-middleware'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function start(upstream: typeof fetch) {
  const middleware = createViteRewriterMiddleware(createRewriterGateway({ upstream }))
  const server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('Vite rewriter middleware', () => {
  it('serves the bounded generation endpoint', async () => {
    const upstream = vi.fn(async () => Response.json({ response: 'rewritten' })) as typeof fetch
    const base = await start(upstream)
    const response = await fetch(`${base}/rewriter/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: 'frameweaver-rewriter', prompt: 'make a clip' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ response: 'rewritten' })
  })

  it('does not expose Ollama management endpoints', async () => {
    const upstream = vi.fn() as unknown as typeof fetch
    const base = await start(upstream)
    const response = await fetch(`${base}/ollama/api/delete`, { method: 'DELETE' })
    expect(response.status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
})

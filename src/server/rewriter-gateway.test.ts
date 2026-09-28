import { describe, expect, it, vi } from 'vitest'
import { createRewriterGateway } from './rewriter-gateway'

const models = ['frameweaver-rewriter', 'fw-rewriter-krea2', 'fw-rewriter-zimage']

function request(path: string, init?: RequestInit) {
  return new Request(`http://frameweaver.test${path}`, init)
}

describe('rewriter gateway', () => {
  it('returns only the configured rewriter models', async () => {
    const upstream = vi.fn(async () =>
      Response.json({ models: [{ name: 'frameweaver-rewriter:latest' }, { name: 'qwen-private:latest' }] }),
    )
    const gateway = createRewriterGateway({ upstream })

    const response = await gateway(request('/models'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ models: ['frameweaver-rewriter'] })
  })

  it('forwards generation only for an exact allowed model name', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json({ response: 'rewritten', echoed: JSON.parse(String(init?.body)) }),
    )
    const gateway = createRewriterGateway({ upstream })

    const response = await gateway(
      request('/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: models[1], prompt: 'portrait', options: { temperature: 99, num_ctx: 999999 } }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ response: 'rewritten' })
    expect(upstream).toHaveBeenCalledOnce()
    const forwarded = JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))
    expect(forwarded.options).toEqual({ temperature: 2 })
  })

  it.each(['qwen-private', 'frameweaver-rewriter-evil'])('rejects unapproved model %s', async (model) => {
    const upstream = vi.fn()
    const gateway = createRewriterGateway({ upstream })
    const response = await gateway(
      request('/generate', { method: 'POST', body: JSON.stringify({ model, prompt: 'x' }) }),
    )
    expect(response.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each(['null', '[]'])('rejects non-object JSON %s with a bounded client error', async (body) => {
    const upstream = vi.fn()
    const gateway = createRewriterGateway({ upstream })
    const response = await gateway(request('/generate', { method: 'POST', body }))
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rejects unknown management routes without contacting Ollama', async () => {
    const upstream = vi.fn()
    const gateway = createRewriterGateway({ upstream })
    const response = await gateway(request('/api/delete', { method: 'DELETE' }))
    expect(response.status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rejects request bodies above the configured limit', async () => {
    const upstream = vi.fn()
    const gateway = createRewriterGateway({ upstream, requestBytes: 64 })
    const response = await gateway(
      request('/generate', { method: 'POST', body: JSON.stringify({ model: models[0], prompt: 'x'.repeat(100) }) }),
    )
    expect(response.status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rejects upstream responses above the configured limit', async () => {
    const gateway = createRewriterGateway({
      responseBytes: 32,
      upstream: vi.fn(async () => Response.json({ response: 'x'.repeat(100) })),
    })
    const response = await gateway(
      request('/generate', { method: 'POST', body: JSON.stringify({ model: models[0], prompt: 'x' }) }),
    )
    expect(response.status).toBe(502)
  })

  it('maps an upstream timeout to 504', async () => {
    const gateway = createRewriterGateway({
      timeoutMs: 5,
      upstream: vi.fn(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          ),
      ),
    })
    const response = await gateway(
      request('/generate', { method: 'POST', body: JSON.stringify({ model: models[0], prompt: 'x' }) }),
    )
    expect(response.status).toBe(504)
  })
})

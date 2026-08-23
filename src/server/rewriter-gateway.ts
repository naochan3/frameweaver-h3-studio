export const REWRITER_MODELS = ['frameweaver-rewriter', 'fw-rewriter-krea2', 'fw-rewriter-zimage'] as const

type GatewayOptions = {
  upstream?: typeof fetch
  ollamaUrl?: string
  timeoutMs?: number
  requestBytes?: number
  responseBytes?: number
}

function safeOptions(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const bounded: Record<string, number> = {}
  const limits = { temperature: [0, 2], top_p: [0, 1], top_k: [1, 100], num_predict: [1, 1200] } as const
  for (const [key, [minimum, maximum]] of Object.entries(limits)) {
    const candidate = source[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) bounded[key] = Math.min(maximum, Math.max(minimum, candidate))
  }
  return bounded
}

function json(status: number, value: unknown) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error('response-too-large')
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

function exactModel(name: unknown): name is (typeof REWRITER_MODELS)[number] {
  return typeof name === 'string' && REWRITER_MODELS.some((allowed) => allowed === name)
}

export function createRewriterGateway(options: GatewayOptions = {}) {
  const upstream = options.upstream ?? fetch
  const ollamaUrl = options.ollamaUrl ?? 'http://127.0.0.1:11434'
  const timeoutMs = options.timeoutMs ?? 180_000
  const requestBytes = options.requestBytes ?? 16 * 1024
  const responseBytes = options.responseBytes ?? 128 * 1024

  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (path === '/models' && request.method === 'GET') {
      try {
        const response = await upstream(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) return json(502, { error: 'rewriter unavailable' })
        const text = await readLimited(response, responseBytes)
        const payload = JSON.parse(text) as { models?: { name?: string }[] }
        const installed = REWRITER_MODELS.filter((allowed) =>
          (payload.models ?? []).some(({ name }) => name === allowed || name === `${allowed}:latest`),
        )
        return json(200, { models: installed })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') return json(504, { error: 'rewriter timeout' })
        return json(502, { error: 'rewriter unavailable' })
      }
    }
    if (path !== '/generate') return json(404, { error: 'not found' })
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' })

    const declared = Number(request.headers.get('content-length') ?? 0)
    if (declared > requestBytes) return json(413, { error: 'request too large' })
    const raw = await request.arrayBuffer()
    if (raw.byteLength > requestBytes) return json(413, { error: 'request too large' })

    let input: { model?: unknown; prompt?: unknown; options?: unknown }
    try {
      input = JSON.parse(new TextDecoder().decode(raw)) as typeof input
    } catch {
      return json(400, { error: 'invalid json' })
    }
    if (!exactModel(input.model)) return json(403, { error: 'model not allowed' })
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0 || input.prompt.length > 8_000) {
      return json(400, { error: 'invalid prompt' })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await upstream(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model: input.model, prompt: input.prompt, stream: false, options: safeOptions(input.options) }),
      })
      if (!response.ok) return json(502, { error: 'rewriter failed' })
      const text = await readLimited(response, responseBytes)
      const payload = JSON.parse(text) as { response?: unknown }
      if (typeof payload.response !== 'string') return json(502, { error: 'invalid rewriter response' })
      return json(200, { response: payload.response })
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        return json(504, { error: 'rewriter timeout' })
      }
      return json(502, { error: error instanceof Error && error.message === 'response-too-large' ? 'response too large' : 'rewriter unavailable' })
    } finally {
      clearTimeout(timeout)
    }
  }
}

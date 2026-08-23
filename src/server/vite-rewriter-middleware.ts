import type { IncomingMessage, ServerResponse } from 'node:http'

type Next = (error?: unknown) => void

async function readBody(request: IncomingMessage, limit: number, timeoutMs: number): Promise<Uint8Array> {
  const timeout = setTimeout(() => request.destroy(new Error('request-timeout')), timeoutMs)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
      size += bytes.byteLength
      if (size > limit) throw new Error('request-too-large')
      chunks.push(bytes)
    }
  } finally {
    clearTimeout(timeout)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export function createViteRewriterMiddleware(gateway: (request: Request) => Promise<Response>, bodyTimeoutMs = 15_000) {
  return async (request: IncomingMessage, response: ServerResponse, next: Next) => {
    const originalUrl = request.url ?? '/'
    if (!originalUrl.startsWith('/rewriter/')) return next()
    try {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBody(request, 16 * 1024, bodyTimeoutMs)
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value)
      }
      const upstreamRequest = new Request(`http://frameweaver.local${originalUrl.slice('/rewriter'.length)}`, {
        method: request.method,
        headers,
        body: body ? new Blob([body as Uint8Array<ArrayBuffer>]) : undefined,
      })
      const result = await gateway(upstreamRequest)
      response.statusCode = result.status
      result.headers.forEach((value, name) => response.setHeader(name, value))
      response.end(new Uint8Array(await result.arrayBuffer()))
    } catch (error) {
      if (error instanceof Error && error.message === 'request-too-large') {
        response.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"request too large"}')
        return
      }
      next(error)
    }
  }
}

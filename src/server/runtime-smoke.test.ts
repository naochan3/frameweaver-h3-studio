import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../../scripts/verify-runtime.mjs', import.meta.url))
const servers: Server[] = []

async function startRuntimeServer(apiReady: boolean): Promise<string> {
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>FrameWeaver H3 Studio</title>')
      return
    }
    if (!apiReady) {
      response.writeHead(503)
      response.end('backend unavailable')
      return
    }
    if (path === '/comfy/system_stats') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ devices: [{ name: 'GPU', type: 'cuda', vram_total: 24, vram_free: 20 }] }))
      return
    }
    const className = path.split('/').at(-1) ?? ''
    const fields: Record<string, string> = {
      CheckpointLoaderSimple: 'ckpt_name',
      UNETLoader: 'unet_name',
      CLIPLoader: 'clip_name',
      VAELoader: 'vae_name',
      LoraLoaderModelOnly: 'lora_name',
    }
    const field = fields[className]
    if (field) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ [className]: { input: { required: { [field]: [['model.safetensors']] } } } }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function runCli(baseUrl: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--base-url', baseUrl, '--timeout-ms', '500'], {
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('verify-runtime CLI', () => {
  it('HTML・GPU・モデルAPIが揃う実行経路をJSONで成功報告する', async () => {
    const baseUrl = await startRuntimeServer(true)

    const result = await runCli(baseUrl)
    const summary = JSON.parse(result.stdout) as { ok: boolean; checks: Record<string, boolean> }

    expect(result.code).toBe(0)
    expect(summary.ok).toBe(true)
    expect(summary.checks).toEqual({
      html: true,
      systemStats: true,
      checkpoints: true,
      unets: true,
      clips: true,
      vaes: true,
      loras: true,
    })
    expect(result.stderr).toBe('')
  })

  it('HTMLだけ表示できる状態を成功扱いにしない', async () => {
    const baseUrl = await startRuntimeServer(false)

    const result = await runCli(baseUrl)
    const summary = JSON.parse(result.stdout) as { ok: boolean; errors: string[] }

    expect(result.code).toBe(1)
    expect(summary.ok).toBe(false)
    expect(summary.errors).toContain('system-stats-http-503')
    expect(result.stdout).not.toContain('backend unavailable')
  })
})

import { describe, expect, it } from 'vitest'
import { collectNodeCapability, type FetchLike } from './capability-collector'

const modelPayloads: Record<string, unknown> = {
  CheckpointLoaderSimple: {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['wai.safetensors']] } } },
  },
  UNETLoader: {
    UNETLoader: { input: { required: { unet_name: [['z_image.safetensors']] } } },
  },
  CLIPLoader: {
    CLIPLoader: { input: { required: { clip_name: [['qwen.safetensors']] } } },
  },
  VAELoader: {
    VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
  },
  LoraLoaderModelOnly: {
    LoraLoaderModelOnly: { input: { required: { lora_name: [['style.safetensors']] } } },
  },
}

function validFetch(failClass?: string): FetchLike {
  return async (input) => {
    const url = String(input)
    if (url.endsWith('/system_stats')) {
      return Response.json({
        devices: [
          { name: 'cuda:0 GPU A', type: 'cuda', vram_total: 24_000, vram_free: 20_000 },
          { name: 'cuda:1 GPU B', type: 'cuda', vram_total: 16_000, vram_free: 8_000 },
        ],
      })
    }
    const className = url.split('/').at(-1) ?? ''
    if (className === failClass) return new Response('unavailable', { status: 503 })
    const payload = modelPayloads[className]
    return payload ? Response.json(payload) : new Response('missing', { status: 404 })
  }
}

describe('collectNodeCapability', () => {
  it('複数GPUと全モデル在庫を1つの能力スナップショットへ正規化する', async () => {
    const snapshot = await collectNodeCapability('/comfy', validFetch())

    expect(snapshot.status).toBe('ready')
    expect(snapshot.accelerator).toBe('cuda')
    expect(snapshot.devices).toEqual([
      { name: 'cuda:0 GPU A', kind: 'cuda', vramTotal: 24_000, vramFree: 20_000 },
      { name: 'cuda:1 GPU B', kind: 'cuda', vramTotal: 16_000, vramFree: 8_000 },
    ])
    expect(snapshot.inventory).toEqual({
      checkpoints: ['wai.safetensors'],
      unets: ['z_image.safetensors'],
      clips: ['qwen.safetensors'],
      vaes: ['ae.safetensors'],
      loras: ['style.safetensors'],
    })
    expect(snapshot.errors).toEqual([])
  })

  it('一部のobject_infoが失敗しても取得済み能力をdegradedとして返す', async () => {
    const snapshot = await collectNodeCapability('/comfy', validFetch('VAELoader'))

    expect(snapshot.status).toBe('degraded')
    expect(snapshot.devices).toHaveLength(2)
    expect(snapshot.inventory.vaes).toEqual([])
    expect(snapshot.errors).toEqual(['inventory-vaes-unavailable'])
  })

  it('system_statsのdevicesが不正なら利用不可として安全に閉じる', async () => {
    const fetchInvalid: FetchLike = async () => Response.json({ devices: 'not-an-array' })

    const snapshot = await collectNodeCapability('/comfy', fetchInvalid)

    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.devices).toEqual([])
    expect(snapshot.errors).toEqual(['invalid-system-stats'])
  })

  it('timeout時に生レスポンスを露出せず利用不可を返す', async () => {
    const fetchNever: FetchLike = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('private response body', 'AbortError')))
    })

    const snapshot = await collectNodeCapability('/comfy', fetchNever, { timeoutMs: 5 })

    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.errors).toEqual(['system-stats-timeout'])
    expect(JSON.stringify(snapshot)).not.toContain('private response body')
  })
})

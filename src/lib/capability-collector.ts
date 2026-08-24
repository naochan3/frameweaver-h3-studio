import type {
  AcceleratorKind,
  CapabilityDevice,
  ModelInventory,
  NodeCapabilitySnapshot,
} from './model-capability'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface CollectOptions {
  timeoutMs?: number
}

const EMPTY_INVENTORY = (): ModelInventory => ({
  checkpoints: [],
  unets: [],
  clips: [],
  vaes: [],
  loras: [],
})

const INVENTORY_ENDPOINTS = [
  { kind: 'checkpoints', className: 'CheckpointLoaderSimple', field: 'ckpt_name' },
  { kind: 'unets', className: 'UNETLoader', field: 'unet_name' },
  { kind: 'clips', className: 'CLIPLoader', field: 'clip_name' },
  { kind: 'vaes', className: 'VAELoader', field: 'vae_name' },
  { kind: 'loras', className: 'LoraLoaderModelOnly', field: 'lora_name' },
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function acceleratorKind(value: unknown): AcceleratorKind {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized.includes('cuda')) return 'cuda'
  if (normalized.includes('mps')) return 'mps'
  if (normalized.includes('cpu')) return 'cpu'
  return 'unknown'
}

function parseDevices(payload: unknown): CapabilityDevice[] | null {
  if (!isRecord(payload) || !Array.isArray(payload['devices'])) return null
  const devices: CapabilityDevice[] = []
  for (const raw of payload['devices']) {
    if (!isRecord(raw)) return null
    const vramTotal = Number(raw['vram_total'])
    const vramFree = Number(raw['vram_free'])
    if (!Number.isFinite(vramTotal) || !Number.isFinite(vramFree) || vramTotal < 0 || vramFree < 0) return null
    devices.push({
      name: String(raw['name'] ?? 'Unknown device'),
      kind: acceleratorKind(raw['type'] ?? raw['name']),
      vramTotal,
      vramFree,
    })
  }
  return devices
}

function parseInventory(payload: unknown, className: string, field: string): string[] | null {
  if (!isRecord(payload)) return null
  const node = payload[className]
  if (!isRecord(node)) return null
  const input = node['input']
  if (!isRecord(input)) return null
  const required = input['required']
  if (!isRecord(required)) return null
  const definition = required[field]
  if (!Array.isArray(definition) || !Array.isArray(definition[0])) return null
  return definition[0].filter((value): value is string => typeof value === 'string')
}

function unavailableSnapshot(code: string): NodeCapabilitySnapshot {
  return {
    capturedAt: new Date().toISOString(),
    status: 'unavailable',
    accelerator: 'unknown',
    devices: [],
    queueRemaining: null,
    inventory: EMPTY_INVENTORY(),
    features: [],
    errors: [code],
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export async function collectNodeCapability(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
  options: CollectOptions = {},
): Promise<NodeCapabilitySnapshot> {
  const root = baseUrl.replace(/\/$/, '')
  const timeoutMs = options.timeoutMs ?? 2_000
  let devices: CapabilityDevice[]
  try {
    const response = await fetchImpl(`${root}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return unavailableSnapshot('system-stats-unavailable')
    const parsed = parseDevices(await response.json())
    if (!parsed) return unavailableSnapshot('invalid-system-stats')
    devices = parsed
  } catch (error) {
    return unavailableSnapshot(isTimeout(error) ? 'system-stats-timeout' : 'system-stats-unavailable')
  }

  const inventory = EMPTY_INVENTORY()
  const errors: string[] = []
  const features: string[] = []

  await Promise.all(INVENTORY_ENDPOINTS.map(async ({ kind, className, field }) => {
    try {
      const response = await fetchImpl(`${root}/object_info/${className}`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) throw new Error('http-error')
      const values = parseInventory(await response.json(), className, field)
      if (!values) throw new Error('invalid-payload')
      inventory[kind] = values
      features.push(className)
    } catch {
      errors.push(`inventory-${kind}-unavailable`)
    }
  }))

  return {
    capturedAt: new Date().toISOString(),
    status: errors.length > 0 ? 'degraded' : 'ready',
    accelerator: devices[0]?.kind ?? 'unknown',
    devices,
    queueRemaining: null,
    inventory,
    features,
    errors,
  }
}

export type CapabilityStatus = 'ready' | 'degraded' | 'unavailable' | 'stale'
export type AcceleratorKind = 'cuda' | 'mps' | 'cpu' | 'unknown'
export type ModelTask = 'image' | 'video' | 'upscale' | 'llm'
export type ModelFitStatus = 'recommended' | 'available' | 'warning' | 'unavailable'

export interface CapabilityDevice {
  name: string
  kind: AcceleratorKind
  vramTotal: number
  vramFree: number
}

export interface ModelInventory {
  checkpoints: string[]
  unets: string[]
  clips: string[]
  vaes: string[]
  loras: string[]
}

export interface NodeCapabilitySnapshot {
  capturedAt: string
  status: CapabilityStatus
  accelerator: AcceleratorKind
  devices: CapabilityDevice[]
  queueRemaining: number | null
  inventory: ModelInventory
  features: string[]
  errors: string[]
}

type InventoryKind = keyof ModelInventory

export interface ModelCatalogEntry {
  id: 'zimage' | 'krea2' | 'anime' | 'h3-video'
  label: string
  task: ModelTask
  accelerators: AcceleratorKind[]
  minVramBytes: number
  recommendedVramBytes: number
  requiredFiles: Partial<Record<InventoryKind, string[]>>
}

export type ModelFitReason =
  | 'installed'
  | 'recommended-memory'
  | 'minimum-memory'
  | 'low-free-vram'
  | 'insufficient-vram'
  | 'missing-model-files'
  | 'unsupported-accelerator'
  | 'degraded-capability'
  | 'stale-capability'
  | 'capability-unavailable'

export interface ModelFit {
  model: ModelCatalogEntry
  status: ModelFitStatus
  reasons: ModelFitReason[]
  missingFiles: string[]
}

const gib = (value: number) => value * 1024 ** 3

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'zimage',
    label: 'Z-Image Turbo',
    task: 'image',
    accelerators: ['cuda'],
    minVramBytes: gib(8),
    recommendedVramBytes: gib(12),
    requiredFiles: {
      unets: ['z_image_turbo_nvfp4.safetensors'],
      clips: ['qwen_3_4b.safetensors'],
      vaes: ['ae_zimage.safetensors'],
    },
  },
  {
    id: 'anime',
    label: 'Anime (Illustrious)',
    task: 'image',
    accelerators: ['cuda'],
    minVramBytes: gib(8),
    recommendedVramBytes: gib(12),
    requiredFiles: { checkpoints: ['waiillustrioussdxl_v170.safetensors'] },
  },
  {
    id: 'krea2',
    label: 'Krea 2 Turbo',
    task: 'image',
    accelerators: ['cuda'],
    minVramBytes: gib(12),
    recommendedVramBytes: gib(16),
    requiredFiles: {
      unets: ['krea2_turbo_fp8_scaled.safetensors'],
      clips: ['qwen3vl_4b_fp8_scaled.safetensors'],
      vaes: ['qwen_image_vae.safetensors'],
    },
  },
  {
    id: 'h3-video',
    label: 'MiniMax H3 Video',
    task: 'video',
    accelerators: ['cuda'],
    minVramBytes: gib(12),
    recommendedVramBytes: gib(24),
    requiredFiles: {
      unets: ['minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
      clips: ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],
      vaes: ['minimax_h3_video_vae_fp16.safetensors'],
    },
  },
]

export function normalizeModelPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
}

function missingRequiredFiles(model: ModelCatalogEntry, inventory: ModelInventory): string[] {
  const missing: string[] = []
  for (const [kind, required] of Object.entries(model.requiredFiles) as [InventoryKind, string[]][]) {
    const available = inventory[kind].map(normalizeModelPath)
    for (const filename of required) {
      const wanted = normalizeModelPath(filename)
      if (!available.some((entry) => entry === wanted || entry.endsWith(`/${wanted}`))) missing.push(filename)
    }
  }
  return missing
}

function fitModel(snapshot: NodeCapabilitySnapshot, model: ModelCatalogEntry): ModelFit {
  const missingFiles = missingRequiredFiles(model, snapshot.inventory)
  const primary = snapshot.devices.reduce<CapabilityDevice | null>(
    (best, device) => !best || device.vramTotal > best.vramTotal ? device : best,
    null,
  )
  const reasons: ModelFitReason[] = []

  if (snapshot.status === 'unavailable') reasons.push('capability-unavailable')
  if (!model.accelerators.includes(snapshot.accelerator)) reasons.push('unsupported-accelerator')
  if (missingFiles.length > 0) reasons.push('missing-model-files')
  if (!primary || primary.vramTotal < model.minVramBytes) reasons.push('insufficient-vram')

  if (reasons.length > 0) return { model, status: 'unavailable', reasons, missingFiles }

  reasons.push('installed')
  if (snapshot.status === 'stale') return { model, status: 'warning', reasons: [...reasons, 'stale-capability'], missingFiles }
  if (snapshot.status === 'degraded') return { model, status: 'warning', reasons: [...reasons, 'degraded-capability'], missingFiles }
  if (primary.vramFree < model.minVramBytes) return { model, status: 'warning', reasons: [...reasons, 'low-free-vram'], missingFiles }
  if (primary.vramTotal >= model.recommendedVramBytes) {
    return { model, status: 'recommended', reasons: [...reasons, 'recommended-memory'], missingFiles }
  }
  return { model, status: 'available', reasons: [...reasons, 'minimum-memory'], missingFiles }
}

const STATUS_ORDER: Record<ModelFitStatus, number> = {
  recommended: 0,
  available: 1,
  warning: 2,
  unavailable: 3,
}

export function rankModels(snapshot: NodeCapabilitySnapshot, task: ModelTask): ModelFit[] {
  return MODEL_CATALOG
    .filter((model) => model.task === task)
    .map((model, index) => ({ fit: fitModel(snapshot, model), index }))
    .sort((left, right) => STATUS_ORDER[left.fit.status] - STATUS_ORDER[right.fit.status] || left.index - right.index)
    .map(({ fit }) => fit)
}

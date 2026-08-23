const OBJECT_INFO = [
  ['checkpoints', 'CheckpointLoaderSimple', 'ckpt_name'],
  ['unets', 'UNETLoader', 'unet_name'],
  ['clips', 'CLIPLoader', 'clip_name'],
  ['vaes', 'VAELoader', 'vae_name'],
  ['loras', 'LoraLoaderModelOnly', 'lora_name'],
]

function parseArgs(argv) {
  const values = { timeoutMs: 3_000 }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--base-url') values.baseUrl = argv[++index]
    else if (argument === '--timeout-ms') values.timeoutMs = Number(argv[++index])
    else throw new Error(`unknown-argument:${argument}`)
  }
  if (!values.baseUrl) throw new Error('base-url-required')
  const url = new URL(values.baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('base-url-protocol-invalid')
  if (!Number.isSafeInteger(values.timeoutMs) || values.timeoutMs <= 0) throw new Error('timeout-ms-invalid')
  values.baseUrl = url.href.replace(/\/$/, '')
  return values
}

async function request(baseUrl, path, timeoutMs) {
  return fetch(`${baseUrl}${path}`, {
    headers: { accept: path === '/' ? 'text/html' : 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

function hasModelField(payload, className, field) {
  return Array.isArray(payload?.[className]?.input?.required?.[field]?.[0])
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, checks: {}, errors: [error.message] })}\n`)
    process.exitCode = 2
    return
  }

  const checks = {
    html: false,
    systemStats: false,
    checkpoints: false,
    unets: false,
    clips: false,
    vaes: false,
    loras: false,
  }
  const errors = []

  try {
    const response = await request(options.baseUrl, '/', options.timeoutMs)
    if (!response.ok) errors.push(`html-http-${response.status}`)
    else {
      const html = await response.text()
      checks.html = /<title>FrameWeaver H3 Studio<\/title>/i.test(html)
      if (!checks.html) errors.push('html-title-missing')
    }
  } catch (error) {
    errors.push(error?.name === 'TimeoutError' ? 'html-timeout' : 'html-unavailable')
  }

  try {
    const response = await request(options.baseUrl, '/comfy/system_stats', options.timeoutMs)
    if (!response.ok) errors.push(`system-stats-http-${response.status}`)
    else {
      const payload = await response.json()
      checks.systemStats = Array.isArray(payload?.devices) && payload.devices.length > 0
      if (!checks.systemStats) errors.push('system-stats-invalid-payload')
    }
  } catch (error) {
    errors.push(error?.name === 'TimeoutError' ? 'system-stats-timeout' : 'system-stats-invalid-json')
  }

  await Promise.all(OBJECT_INFO.map(async ([name, className, field]) => {
    try {
      const response = await request(options.baseUrl, `/comfy/object_info/${className}`, options.timeoutMs)
      if (!response.ok) {
        errors.push(`${name}-http-${response.status}`)
        return
      }
      const payload = await response.json()
      checks[name] = hasModelField(payload, className, field)
      if (!checks[name]) errors.push(`${name}-invalid-payload`)
    } catch (error) {
      errors.push(error?.name === 'TimeoutError' ? `${name}-timeout` : `${name}-invalid-json`)
    }
  }))

  const ok = Object.values(checks).every(Boolean)
  process.stdout.write(`${JSON.stringify({ ok, checks, errors })}\n`)
  if (!ok) process.exitCode = 1
}

await main()

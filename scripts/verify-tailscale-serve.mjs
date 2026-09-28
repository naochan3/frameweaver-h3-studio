import { readFile } from 'node:fs/promises'

const document = await readFile('docs/TAILSCALE-MULTI-MACHINE.md', 'utf8')
const start = document.indexOf('## 2. Tailscale Serve')
const section = document.slice(start, document.indexOf('## 3.', start))

if (!section.includes('Stop-Process')) throw new Error('Tailscale Serve instructions must stop the existing WebUI listener')
if (!section.includes('--port 5180 --strictPort')) throw new Error('Tailscale Serve instructions must require port 5180')

console.log('Tailscale Serve instructions OK')

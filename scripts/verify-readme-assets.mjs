import { readFile } from 'node:fs/promises'

const expected = new Map([
  ['docs/assets/readme/studio-desktop.png', [2560, 1440]],
  ['docs/assets/readme/studio-mobile.png', [1170, 2532]],
])
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const readme = await readFile('README.md', 'utf8')

for (const [path, [width, height]] of expected) {
  if (!readme.includes(path)) throw new Error(`README does not reference ${path}`)
  const png = await readFile(path)
  if (!png.subarray(0, 8).equals(pngSignature)) throw new Error(`${path} is not PNG`)
  const actualWidth = png.readUInt32BE(16)
  const actualHeight = png.readUInt32BE(20)
  if (actualWidth !== width || actualHeight !== height) {
    throw new Error(`${path}: expected ${width}x${height}, got ${actualWidth}x${actualHeight}`)
  }
}

console.log(`README assets OK: ${expected.size}`)

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('theme usage', () => {
  it('uses accent tokens for accent surfaces and accessible Ocean buttons', async () => {
    const [css, main, picker, ...components] = await Promise.all([
      source('../index.css'),
      source('../main.tsx'),
      source('../components/ThemePicker.tsx'),
      ...['../components/Header.tsx', '../components/ImageStudio.tsx', '../components/RecipePanel.tsx', '../components/SourcePanel.tsx', '../components/HistoryDetail.tsx'].map(source),
    ])

    expect(css).toContain('--color-accent-500: #0e7490')
    expect(components.join('\n')).not.toMatch(/bg-orange-(?:50|100)/)
    expect(main).toContain('browserStorage()')
    expect(picker).toContain('browserStorage()')
    expect(css).toContain(":root[data-theme='dark'][data-color-theme='ocean']")
    expect(css).toContain(":root[data-theme='dark'][data-color-theme='violet']")
  })
})

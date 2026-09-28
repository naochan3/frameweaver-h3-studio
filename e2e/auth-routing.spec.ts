import { expect, test, type Page } from '@playwright/test'

async function mockAuthenticatedApp(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { enabled: true, authenticated: true, displayName: 'Test User' } }))
  await page.route('**/api/workers', (route) => route.fulfill({ json: { workers: [
    { id: 'rtx5060ti', label: 'RTX 5060 Ti', capabilities: ['image'], online: true, stale: false, free_vram_mb: 12288, queue_depth: 0 },
    { id: 'rtx4090', label: 'RTX 4090', capabilities: ['image', 'video'], online: true, stale: false, free_vram_mb: 20480, queue_depth: 0 },
  ] } }))
  await page.route('**/api/jobs?**', (route) => route.fulfill({ json: { jobs: [] } }))
  await page.route('**/api/fleet', (route) => route.fulfill({ json: { samples: [], at: '2026-08-22T00:00:00Z', collecting: false } }))
  await page.route('**/comfy/**', (route) => route.fulfill({ status: 404, json: {} }))
}

test('unauthenticated user sees only Discord login', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'authentication_required' } }))
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Discordでログイン' })).toHaveAttribute('href', '/auth/login')
  await expect(page.getByRole('button', { name: /生成/ })).toHaveCount(0)
})

test('authenticated desktop and mobile expose safe GPU selection without endpoint data', async ({ page }) => {
  await mockAuthenticatedApp(page)
  await page.goto('/')
  const selector = page.getByLabel('生成GPU')
  await expect(selector).toBeVisible()
  await expect(selector).toHaveValue('auto')
  await selector.selectOption('rtx5060ti')
  await expect(selector).toHaveValue('rtx5060ti')
  await expect(page.locator('body')).not.toContainText('tail37947a.ts.net')
})

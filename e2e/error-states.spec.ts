import { expect, test } from '@playwright/test'

for (const status of [403, 502, 503, 504]) {
  test(`auth error ${status} is bounded and does not expose the app`, async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status, json: { error: `safe_${status}` } }))
    await page.goto('/')
    await expect(page.getByText(`safe_${status}`)).toBeVisible()
    await expect(page.getByRole('button', { name: /生成/ })).toHaveCount(0)
  })
}

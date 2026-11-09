import { expect, randomIp, test } from './fixtures'
import { guestSay, startGuest } from './helpers'

/**
 * The site-wide guest cap (GUEST_SITE_DAILY_CAP, 120 in tests). This project
 * runs after all the others (playwright.config.ts) because it uses up the
 * day's guest messages for everyone.
 */
// The UI check needs the cap reached first.
test.describe.configure({ mode: 'serial' })

test('past the site-wide cap, guests are told to sign in', async ({ playwright, baseURL }) => {
  let sent = 0
  let capped: { status: number; error: string | null } | null = null
  for (let guest = 0; guest < 40 && !capped; guest++) {
    const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'cf-connecting-ip': randomIp() } })
    await startGuest(context)
    for (let i = 0; i < 5 && !capped; i++) {
      const result = await guestSay(context, `cap ${guest}.${i}`)
      if (result.status === 200) sent++
      else capped = result
    }
    await context.dispose()
  }
  expect(capped).toEqual({ status: 429, error: 'guest_site_cap', events: [] })
  expect(sent).toBeLessThanOrEqual(120)

  // Signing in still works past the guest cap.
  const page = await playwright.request.newContext({ baseURL })
  expect((await page.get('/api/health')).ok()).toBe(true)
  await page.dispose()
})

test('the UI says guest messages are used up and offers sign-in', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('wren:seen-how-it-works', '1'))
  await page.goto('/')
  await page.getByTestId('composer').fill('Anyone there?')
  await page.locator('.composer').getByTestId('send').click()
  const alert = page.getByTestId('chat-error').filter({ visible: true })
  await expect(alert).toContainText('Guest messages are used up for today; sign in to keep going.', { timeout: 20_000 })
  await alert.getByTestId('error-sign-in').click()
  await expect(page.getByTestId('sign-in')).toBeVisible()
})

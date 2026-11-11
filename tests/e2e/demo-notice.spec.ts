import { expect, randomIp, test } from './fixtures'
import { composer, isPhone, noHorizontalScroll, sendMessage, signIn, skipIntro } from './helpers'

/**
 * The free-demo notice (components/app/DemoNotice.tsx): everyone sees it above
 * the composer until they dismiss it or add their own key; "?" and the key
 * dialog show it again. Visitors from the EEA, Switzerland and the UK get a
 * firmer nudge, and everything still works. The test server lets a test say
 * where it visits from (X-Wren-Test-Country); production reads Cloudflare's
 * request.cf.country only (tests/unit/region.test.ts).
 */
const notice = (page: import('@playwright/test').Page) =>
  page.locator(isPhone(page) ? '.mcomp' : '.composer').getByTestId('demo-notice')

/** On a phone the notice starts as one line; "More" opens the rest. A no-op on desktop, where it is all showing. */
async function openNotice(page: import('@playwright/test').Page) {
  if (!isPhone(page)) return
  const more = notice(page).getByTestId('demo-more')
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click()
  await expect(notice(page).getByTestId('demo-full')).toBeVisible()
}

test.describe('from anywhere else', () => {
  test('phone: one line with More, then the rest inline; desktop shows it all', async ({ page }) => {
    await skipIntro(page)
    await page.goto('/')
    const box = notice(page)
    await expect(box).toBeVisible()
    if (!isPhone(page)) {
      await expect(box.getByTestId('demo-more')).toBeHidden()
      await expect(box.getByTestId('demo-full')).toBeVisible()
      return
    }
    const more = box.getByTestId('demo-more')
    const short = box.getByTestId('demo-short')
    await expect(short).toHaveText("Free demo. Don't share private info.")
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(box.getByTestId('demo-full')).toBeHidden()
    // One line (no wrap, not cut off), and the tap targets are 44px.
    expect(await short.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height < 24)).toBe(true)
    for (const id of ['demo-more', 'demo-dismiss']) {
      const r = (await box.getByTestId(id).boundingBox())!
      expect(r.width).toBeGreaterThanOrEqual(43.5)
      expect(r.height).toBeGreaterThanOrEqual(43.5)
    }
    const collapsed = (await box.boundingBox())!.height
    expect(collapsed).toBeLessThan(60)
    await noHorizontalScroll(page)

    // Keyboard: Enter opens it inline, and the rest is there.
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(more).toHaveText('Less')
    await expect(box.getByTestId('demo-full')).toContainText("Please don't share personal details")
    await expect(box.getByTestId('demo-own-key')).toBeVisible()
    await expect(box.getByTestId('demo-dismiss')).toBeVisible()
    await noHorizontalScroll(page)

    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(box.getByTestId('demo-full')).toBeHidden()
  })

  test('shows the free-demo notice, opens the own-key how-to, and stays dismissed', async ({ page }) => {
    await skipIntro(page)
    await page.goto('/')
    await expect(notice(page)).toBeVisible()
    await openNotice(page)
    await expect(notice(page)).toContainText("This is a free demo running on Google Gemini's free tier.")
    await expect(notice(page)).toContainText("Please don't share personal details")
    await expect(notice(page).getByTestId('demo-nudge')).toHaveCount(0)
    await noHorizontalScroll(page)

    await notice(page).getByTestId('demo-own-key').click()
    const dialog = page.getByTestId('key-dialog')
    await expect(dialog.getByTestId('demo-notice-box')).toBeVisible()
    await expect(dialog.getByTestId('key-how')).toContainText('Create API key')
    await expect(dialog.getByRole('link', { name: /AI Studio/ })).toHaveAttribute('href', 'https://aistudio.google.com/apikey')
    await expect(dialog).toContainText('Your key stays in this browser')
    await page.keyboard.press('Escape')

    await notice(page).getByTestId('demo-dismiss').click()
    await expect(page.getByTestId('demo-notice')).toHaveCount(0)
    await page.reload()
    await expect(composer(page)).toBeVisible()
    await expect(page.getByTestId('demo-notice')).toHaveCount(0)

    // "?" shows it again.
    await page.getByTestId(isPhone(page) ? 'help-phone' : 'help').click()
    await expect(page.getByTestId('how-it-works').getByTestId('demo-notice-box')).toContainText('free tier')
  })

  test('the first-visit dialog carries the notice and a way to add a key', async ({ page }) => {
    await page.goto('/')
    const how = page.getByTestId('how-it-works')
    await expect(how.getByTestId('demo-notice-box')).toContainText("don't share personal details")
    await how.getByTestId('how-own-key').click()
    await expect(page.getByTestId('key-dialog')).toBeVisible()
  })

  test('goes away once your own key is on', async ({ page }) => {
    await skipIntro(page)
    await page.addInitScript(() => window.localStorage.setItem('wren:gemini-key', 'AIzaTestKeyForTheDemoNotice0000'))
    await page.goto('/')
    await expect(composer(page)).toBeVisible()
    await expect(page.getByTestId('demo-notice')).toHaveCount(0)
  })
})

test.describe('from the UK', () => {
  test.use({ extraHTTPHeaders: { 'cf-connecting-ip': randomIp(), 'x-wren-test-country': 'GB' } })

  test('names the place, nudges toward your own key, and keeps everything working', async ({ page, baseURL }) => {
    await signIn(page, baseURL ?? '')
    await expect(notice(page).getByTestId('demo-nudge')).toHaveText(
      "You're visiting from the United Kingdom. Google's terms reserve Gemini's free tier from apps used in the UK, the EU/EEA and Switzerland, so please use Wren with your own Gemini key there."
    )
    await openNotice(page)
    await expect(notice(page)).toContainText("Please don't share personal details")
    await noHorizontalScroll(page)

    // Nothing is blocked: the mic and Research are on, and a message gets an answer.
    const bar = page.locator(isPhone(page) ? '.mcomp' : '.composer')
    await expect(bar.getByTestId('mic')).toBeEnabled()
    await expect(bar.getByTestId('research-toggle')).toBeEnabled()
    await sendMessage(page, 'Hello from London')
    await expect(page.getByTestId('answer').last()).toContainText('You said: "Hello from London"')
    expect((await page.request.get('/api/usage')).ok()).toBe(true)

    // The key dialog repeats the firmer nudge.
    await notice(page).getByTestId('demo-own-key').click()
    await expect(page.getByTestId('key-dialog')).toContainText("You're visiting from the United Kingdom.")
    await page.keyboard.press('Escape')

    // Memory carries the reminder too.
    await page.goto('/memory')
    await expect(page.getByTestId('memory-reminder')).toContainText("don't save personal details")
  })
})

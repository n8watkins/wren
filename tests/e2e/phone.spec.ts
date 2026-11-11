import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { composer, noHorizontalScroll, signIn, skipIntro } from './helpers'

/**
 * The first screen on phones, at the narrow widths people really use (iPhone
 * SE, the common iPhones and Androids, a small tablet): the "How Wren works"
 * sheet, the free-demo notice, the composer and the tips tour fit, nothing is
 * cut off or scrolls sideways, and every control is at least 44 px to tap.
 * The run's other specs cover 390 px; this one goes down to 320.
 */

const PHONES = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
]

/** Visible controls smaller than 44 px (WCAG 2.5.5), described for the failure message. */
async function smallTargets(page: Page, within: Locator = page.locator('body')): Promise<string[]> {
  // A dialog still opening is scaled a little; measure it once it has settled.
  await within.evaluate((root) => Promise.all(root.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))))
  return within.evaluate((root) => {
    const small: string[] = []
    for (const el of root.querySelectorAll<HTMLElement>('a[href], button, input, textarea, [role=button]')) {
      const box = el.getBoundingClientRect()
      if (!box.width || !box.height || el.closest('[hidden], [inert]')) continue
      if (box.bottom <= 0 || box.top >= window.innerHeight) continue
      // A link inside a sentence is exempt (WCAG 2.5.8), a link-styled button
      // in a paragraph too; so is the header's
      // ring and "?", whose hit areas are larger than they look (::after).
      if (getComputedStyle(el).display === 'inline' || el.matches('p .linkbtn, .mib, .ring2')) continue
      // Half a pixel of tolerance: layout rounds a 44 px control to 43.6 on some screens.
      if (box.width < 43.5 || box.height < 43.5) {
        const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40)
        small.push(`${name} (${Math.round(box.width)}x${Math.round(box.height)})`)
      }
    }
    return small
  })
}

/** True when nothing else is painted over the middle of the element. */
async function uncovered(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return top !== null && (el === top || el.contains(top))
  })
}

for (const size of PHONES) {
  test.describe(`${size.width} px`, () => {
    test.use({ viewport: size, isMobile: true, hasTouch: true })
    // These set their own phone sizes, so one project (desktop) runs them.
    test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'sizes set here'))

    test('a first visit: the sheet, then the welcome, the notice and the composer all fit', async ({ page }) => {
      await page.goto('/')
      const how = page.getByTestId('how-it-works')
      await expect(how).toBeVisible()
      await noHorizontalScroll(page)
      // Focus starts on the sheet's content: no ring on the close button.
      await expect(how.getByRole('button', { name: 'Close' })).not.toBeFocused()
      expect(await how.evaluate((dialog) => dialog.querySelector('.inner') === document.activeElement)).toBe(true)
      expect(await smallTargets(page, how)).toEqual([])
      await how.getByTestId('start-chatting').click()
      await expect(how).toBeHidden()

      // The welcome scrolls from its top: its heading is never cut off above.
      const welcome = page.getByTestId('welcome')
      const heading = welcome.getByRole('heading', { name: 'What are we working on?' })
      await welcome.evaluate((el) => el.scrollTo(0, 0))
      const header = (await page.locator('.mhd').boundingBox())!
      expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height)
      await expect(page.getByTestId('guest-intro')).toBeVisible()

      const notice = page.locator('.mcomp').getByTestId('demo-notice')
      await expect(notice).toBeVisible()
      await expect(notice).toContainText("Please don't share personal details")
      const box = composer(page)
      await expect(box).toBeInViewport({ ratio: 1 })
      expect(await uncovered(box)).toBe(true)
      expect(await uncovered(notice.getByTestId('demo-dismiss'))).toBe(true)
      expect(await smallTargets(page)).toEqual([])
      await noHorizontalScroll(page)

      // The notice goes once dismissed, and the composer stays put at the bottom.
      await notice.getByTestId('demo-dismiss').click()
      await expect(notice).toHaveCount(0)
      await expect(box).toBeInViewport({ ratio: 1 })
    })

    test('the tips tour: every tip is on screen and thumb-sized', async ({ page }) => {
      await page.goto('/')
      await page.getByTestId('how-it-works').getByRole('button', { name: 'Show me around' }).click()
      const tip = page.getByTestId('tip')
      for (const id of ['mic', 'res', 'mem', 'meter']) {
        await expect(tip).toHaveAttribute('data-tip-id', id)
        const box = (await tip.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(size.width)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.y + box.height).toBeLessThanOrEqual(size.height)
        expect(await smallTargets(page, tip)).toEqual([])
        await tip.getByTestId('tip-next').click()
      }
      await expect(tip).toHaveCount(0)
      await noHorizontalScroll(page)
    })

    test('signed in: the chat, the "Saved to Memory" reminder by tap, and Memory fit', async ({ page, baseURL }) => {
      await signIn(page, baseURL!)
      await composer(page).fill('My dog is called Juniper.')
      await page.locator('.mcomp').getByTestId('send').click()
      await expect(page.getByTestId('answer')).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
      const saved = page.getByTestId('memory-saved')
      await expect(saved).toContainText('Saved to Memory')

      // The free-demo reminder on a save is a tap away (no hover on a phone).
      const reminder = page.getByTestId('memory-saved-reminder')
      await expect(reminder).toHaveCount(0)
      await saved.getByTestId('memory-saved-why').tap()
      await expect(reminder).toContainText("don't save personal details")
      await expect(saved.getByTestId('memory-saved-why')).toHaveAttribute('aria-expanded', 'true')
      await saved.getByTestId('memory-saved-why').tap()
      await expect(reminder).toHaveCount(0)
      expect(await smallTargets(page, page.locator('.thread'))).toEqual([])
      await noHorizontalScroll(page)

      // Research mode: the question gets the mic's room.
      const mcomp = page.locator('.mcomp')
      await mcomp.getByTestId('research-toggle').tap()
      await expect(mcomp.getByTestId('mic')).toHaveCount(0)
      await expect(composer(page)).toHaveAttribute('placeholder', 'What to research?')
      await mcomp.getByTestId('research-toggle').tap()
      await expect(mcomp.getByTestId('mic')).toBeVisible()

      await page.goto('/memory')
      await expect(page.getByTestId('memory-item')).toHaveCount(1)
      expect(await smallTargets(page, page.locator('main'))).toEqual([])
      await noHorizontalScroll(page)
    })
  })
}

test('a guest on Memory or Runs gets no human check: only chat needs one', async ({ page }) => {
  await skipIntro(page)
  const starts: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/guest/start') || request.url().includes('challenges.cloudflare.com')) starts.push(request.url())
  })
  await page.goto('/memory')
  await expect(page.getByRole('button', { name: 'Sign in to start your memory' })).toBeVisible()
  await page.goto('/runs')
  await expect(page.getByRole('button', { name: 'Sign in to research' })).toBeVisible()
  await page.waitForTimeout(1_000)
  expect(starts).toEqual([])
})

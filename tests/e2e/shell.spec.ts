import { expect, test } from './fixtures'
import { isPhone, noHorizontalScroll, skipIntro } from './helpers'

test('first visit opens How Wren works; "?" reopens it', async ({ page }) => {
  await page.goto('/')
  const how = page.getByTestId('how-it-works')
  await expect(how).toBeVisible()
  await expect(how.getByRole('heading', { name: 'How Wren works' })).toBeVisible()
  await expect(how.locator('.howi')).toHaveCount(4)
  await noHorizontalScroll(page)
  await how.getByTestId('start-chatting').click()
  await expect(how).toBeHidden()

  await page.reload()
  await expect(page.getByTestId('welcome')).toBeVisible()
  await expect(how).toBeHidden()

  await page.getByTestId(isPhone(page) ? 'help-phone' : 'help').click()
  await expect(how).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(how).toBeHidden()
})

test('the guest shell matches the layout for this width', async ({ page }) => {
  await skipIntro(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible()
  if (isPhone(page)) {
    await expect(page.locator('.side')).toBeHidden()
    await expect(page.locator('.mnav')).toBeVisible()
    await expect(page.locator('.mnav a')).toHaveText(['Chat', 'Runs', 'Memory'])
    await expect(page.getByTestId('usage-ring')).toBeVisible()
    await page.getByTestId('title-menu').click()
    await expect(page.getByTestId('phone-menu')).toBeVisible()
    await expect(page.getByTestId('phone-menu').getByTestId('meter-chat')).toHaveText('0/5')
  } else {
    await expect(page.locator('.side')).toBeVisible()
    await expect(page.locator('.mnav')).toBeHidden()
    await expect(page.locator('.side').getByTestId('meter-chat')).toHaveText('0/5')
    await expect(page.locator('.side').getByTestId('open-sign-in')).toBeVisible()
  }
  await noHorizontalScroll(page)
})

test('Voice and Memory say they are coming, without pretending; Research says where it works', async ({ page }) => {
  await skipIntro(page)
  await page.goto('/')
  const scope = page.locator(isPhone(page) ? '.mcomp' : '.composer')
  await scope.locator('[data-tip="mic"]').click()
  const explainer = page.getByTestId('explainer')
  await expect(explainer).toContainText('Coming in the next update')
  await expect(explainer).toContainText('How talking will work')
  await explainer.getByRole('button', { name: 'Got it' }).click()
  await expect(explainer).toBeHidden()

  await scope.locator('[data-tip="res"]').click()
  await expect(explainer).toContainText('How research works')
  await expect(explainer).toContainText('Start a run from Research runs')
  await expect(explainer).not.toContainText('Coming in the next update')
  await page.keyboard.press('Escape')

  await page.goto('/memory')
  await expect(page.getByTestId('memory-page')).toContainText('Coming in the next update')
  await noHorizontalScroll(page)

  // Research works for people who sign in; a guest is asked to.
  await page.goto('/runs')
  await expect(page.getByTestId('runs-page')).not.toContainText('Coming in the next update')
  await page.getByTestId('runs-sign-in').click()
  await expect(page.getByTestId('sign-in')).toContainText('Sign in to research')
  await noHorizontalScroll(page)
})

test('the theme switch sticks across reloads', async ({ page }) => {
  await skipIntro(page)
  await page.goto('/')
  if (isPhone(page)) await page.getByTestId('title-menu').click()
  const theme = page.locator(isPhone(page) ? '.mmenu .theme' : '.side .theme')
  await theme.getByRole('button', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(bg).toBe('rgb(20, 16, 14)')
})

test('reduced motion stills the wren', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.addInitScript(() => localStorage.setItem('wren:seen-how-it-works', '1'))
  await page.goto('/')
  const tail = page.locator('.welcome svg.wren .tail')
  expect(await tail.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  await context.close()
})

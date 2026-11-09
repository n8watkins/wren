import { expect, test } from './fixtures'
import { isPhone, latestLink, meterChat, newEmail, skipIntro } from './helpers'

test('sign in by email from the sign-in modal', async ({ page }) => {
  await skipIntro(page)
  await page.goto('/')
  if (isPhone(page)) {
    await page.getByTestId('title-menu').click()
    await page.locator('.mmenu .row').getByRole('button', { name: 'Sign in' }).click()
  } else {
    await page.locator('.side').getByTestId('open-sign-in').click()
  }

  const dialog = page.getByTestId('sign-in')
  await expect(dialog).toBeVisible()
  // GitHub isn't configured in tests: the button says so instead of failing later.
  await expect(dialog.getByTestId('github-sign-in')).toBeDisabled()
  await expect(dialog).toContainText("GitHub sign-in isn’t set up on this preview yet")

  const email = newEmail()
  await dialog.getByLabel('Email').fill(email)
  await dialog.getByTestId('email-sign-in').click()
  await expect(dialog.getByTestId('link-sent')).toContainText(email)

  await page.goto(await latestLink(email))
  if (isPhone(page)) await page.getByTestId('title-menu').click()
  await expect(page.locator(isPhone(page) ? '.mmenu' : '.side').getByTestId('who')).toContainText(email)
  await expect(await meterChat(page)).toHaveText('0/50')
})

test('a sign-in link works once', async ({ page, baseURL }) => {
  const email = newEmail()
  await page.request.post('/api/auth/sign-in/magic-link', { data: { email, callbackURL: '/' }, headers: { origin: baseURL! } })
  const link = await latestLink(email)
  await page.goto(link)
  expect((await page.request.get('/api/usage')).ok()).toBe(true)
  await page.context().clearCookies()
  await page.goto(link)
  expect((await page.request.get('/api/usage')).status()).toBe(401)
})

test('signing out ends the session', async ({ page, baseURL }) => {
  await skipIntro(page)
  const email = newEmail()
  await page.request.post('/api/auth/sign-in/magic-link', { data: { email, callbackURL: '/' }, headers: { origin: baseURL! } })
  await page.goto(await latestLink(email))
  if (isPhone(page)) {
    await page.getByTestId('title-menu').click()
    await page.locator('.mmenu').getByRole('button', { name: 'Sign out' }).click()
  } else {
    await page.getByTestId('sign-out').click()
  }
  await expect(page.locator(isPhone(page) ? '.mmenu' : '.side').getByTestId('who')).toContainText('Not signed in', { timeout: 10_000 })
  expect((await page.request.get('/api/usage')).status()).toBe(401)
})

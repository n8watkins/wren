import { expect, test } from './fixtures'
import { composer, isPhone, latestLink, newEmail, skipIntro } from './helpers'

test('a guest is asked to sign in before the first message, then signs in by email', async ({ page }) => {
  await skipIntro(page)
  await page.goto('/')
  await composer(page).fill('Hello there')
  await page.locator(isPhone(page) ? '.mcomp' : '.composer').getByTestId('send').click()

  const dialog = page.getByTestId('sign-in')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Sign in to start chatting')
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

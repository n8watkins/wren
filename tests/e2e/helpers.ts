import { DatabaseSync } from 'node:sqlite'
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { localD1File } from '../../scripts/local-d1.mjs'

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 861

export function newEmail(tag = 'user'): string {
  return `e2e-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`
}

/** Reads the newest sign-in link sent to an address from the E2E outbox (no app route involved). */
export async function latestLink(email: string): Promise<string> {
  const file = localD1File('.wrangler/e2e/state')
  if (!file) throw new Error('no local E2E database')
  for (let attempt = 0; attempt < 20; attempt++) {
    const db = new DatabaseSync(file, { readOnly: true })
    const row = db.prepare('SELECT url FROM test_outbox WHERE email = ? ORDER BY id DESC LIMIT 1').get(email) as
      | { url: string }
      | undefined
    db.close()
    if (row) return row.url
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`no sign-in link for ${email}`)
}

/** Asks for a sign-in link the way the modal does, then follows it. */
export async function requestLink(request: APIRequestContext, baseURL: string, email: string): Promise<string> {
  const response = await request.post('/api/auth/sign-in/magic-link', {
    data: { email, callbackURL: '/' },
    headers: { origin: baseURL },
  })
  expect(response.ok()).toBe(true)
  return latestLink(email)
}

/** A signed-in page that has already seen "How Wren works". */
export async function signIn(page: Page, baseURL: string, email = newEmail()): Promise<string> {
  await skipIntro(page)
  const link = await requestLink(page.request, baseURL, email)
  await page.goto(link)
  await expect(page).toHaveURL(/\/$/)
  expect((await page.request.get('/api/usage')).ok()).toBe(true)
  return email
}

export async function skipIntro(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem('wren:seen-how-it-works', '1'))
}

export function composer(page: Page) {
  return page.getByTestId(isPhone(page) ? 'composer-phone' : 'composer')
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await page.locator(isPhone(page) ? '.mcomp' : '.composer').getByTestId('send').click()
}

export async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

/** The usage meter on screen: in the sidebar on a desktop, in the title menu on a phone. */
export async function meterChat(page: Page) {
  if (isPhone(page)) {
    const menu = page.getByTestId('phone-menu')
    if (!(await menu.isVisible())) await page.getByTestId('title-menu').click()
    return menu.getByTestId('meter-chat')
  }
  return page.locator('.side').getByTestId('meter-chat')
}

/** Starts a guest session the way the browser does after Turnstile (the mock siteverify accepts "test-ok…"). */
export async function startGuest(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/guest/start', { data: { token: 'test-ok' } })
  expect(response.ok()).toBe(true)
}

/** A guest message through the API; the parsed NDJSON events, or the error answer. */
export async function guestSay(request: APIRequestContext, text: string, history: { role: string; text: string }[] = []) {
  const response = await request.post('/api/guest/chat', { data: { text, history } })
  if (!response.ok()) return { status: response.status(), error: (await response.json()).error as string, events: [] }
  const events = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  return { status: response.status(), error: null, events }
}

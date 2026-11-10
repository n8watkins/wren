import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { composer, isPhone, noHorizontalScroll, sendMessage, signIn, skipIntro } from './helpers'

/**
 * Research in chat, at desktop and phone widths, against the Tavily and
 * Gemini mocks (tests/mocks): start a run from the composer or from an
 * answer, watch the live card, Stop it, reload into it, read the report that
 * lands in the chat, carry on talking about it and save its findings, and the
 * states for guests, runs used up, the network's cap and Tavily being down.
 */

const scope = (page: Page) => page.locator(isPhone(page) ? '.mcomp' : '.composer')

/** Turns on research mode, types the question and starts the run. */
async function research(page: Page, question: string) {
  await scope(page).getByTestId('research-toggle').click()
  await expect(scope(page).getByTestId('research-toggle')).toHaveAttribute('aria-pressed', 'true')
  await composer(page).fill(question)
  await scope(page).getByTestId('send').click()
}

/** Research runs used today, from the meter (sidebar on a desktop, title menu on a phone). */
async function researchMeter(page: Page) {
  if (isPhone(page)) {
    const menu = page.getByTestId('phone-menu')
    if (!(await menu.isVisible())) await page.getByTestId('title-menu').click()
    return menu.locator('.mrow', { hasText: 'Research' }).locator('.v')
  }
  return page.locator('.side .mrow', { hasText: 'Research' }).locator('.v')
}

async function closeMeter(page: Page) {
  if (isPhone(page) && (await page.getByTestId('phone-menu').isVisible())) await page.getByTestId('title-menu').click()
}

test('research from the composer: the report lands in the chat, the chat carries on about it, and its findings save', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await scope(page).getByTestId('research-toggle').click()
  await expect(page.getByTestId('research-hint').filter({ visible: true })).toHaveText(
    'Wren searches the web, reads the pages and cites them. 3 of 3 runs left today.'
  )
  await composer(page).fill('What should I look for in an e-bike under $1,500?')
  await scope(page).getByTestId('send').click()

  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('user-message')).toHaveText('What should I look for in an e-bike under $1,500?')
  await expect(page.getByTestId('research-ask')).toBeVisible()
  // Research mode turns itself off once the run starts.
  await expect(scope(page).getByTestId('research-toggle')).toHaveAttribute('aria-pressed', 'false')

  const card = page.getByTestId('research-card')
  await expect(card).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
  const report = card.getByTestId('research-report')
  await expect(report.locator('h2')).toHaveText('What to check')
  await expect(card.getByTestId('research-searched')).toHaveText('Searched with Tavily')
  // Citations link only to pages it read.
  const sourceUrls = await card.getByTestId('run-source').locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href')))
  expect(sourceUrls.length).toBeGreaterThanOrEqual(3)
  for (const href of await report.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href')))) expect(sourceUrls).toContain(href)
  await expect(report.locator('img, script')).toHaveCount(0)
  await expect(card.getByTestId('research-open-run')).toHaveAttribute('href', /\/runs\/[0-9a-f-]{36}$/)
  await expect(await researchMeter(page)).toHaveText('1/3')
  await closeMeter(page)
  await noHorizontalScroll(page)

  // The report is part of the conversation the model sees.
  await sendMessage(page, 'mock:history what did you just tell me?')
  const answer = page.getByTestId('answer').last()
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await expect(answer).toContainText('Your last turn began: Research report on "What should I look for in an e-bike under $1,500?"')
  await expect(answer).toContainText('Sources listed: yes')

  // Save findings to memory: once, as a note with the question and the pages it cites.
  const save = card.getByTestId('save-to-memory')
  await expect(save).toHaveText('Save findings to memory')
  await save.dblclick()
  await expect(card.locator('[data-testid=save-to-memory][data-saved]')).toHaveText('Saved to memory')
  const notes = (await (await page.request.get('/api/memory?kind=note')).json()).memories as { text: string }[]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toMatch(/^Research: What should I look for in an e-bike under \$1,500\?\n\nFor under \$1,500/)
  expect(notes[0].text).toContain('Sources:\n[1] How to buy an e-bike under $1,500 | Pedalwise - https://pedalwise.org/guides/e-bike-under-1500')

  // All of it is still there after a reload.
  await page.reload()
  await expect(page.getByTestId('research-card')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('research-report').locator('h2')).toHaveText('What to check')
  await expect(page.getByTestId('research-card').locator('[data-testid=save-to-memory][data-saved]')).toBeVisible()
  await expect(page.getByTestId('research-ask')).toBeVisible()
  await noHorizontalScroll(page)
})

test('the live card shows what it searched and read, and picks up again after a reload', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await research(page, 'mock:slow which e-bike should I buy?')
  const live = page.getByTestId('research-live')
  await expect(live).toBeVisible()
  await expect(live.getByTestId('run-status')).toHaveText(/Planning searches|Searching/)
  await expect(live.locator('[data-kind="search"]').first()).toContainText('5 results from Tavily', { timeout: 10_000 })
  await expect(live.getByTestId('research-searched')).toHaveText('Searched with Tavily')
  await noHorizontalScroll(page)

  await page.reload()
  await expect(page.getByTestId('research-live')).toBeVisible()
  await expect(page.getByTestId('research-card')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
  await expect(page.getByTestId('research-report').locator('h2')).toHaveText('What to check')
  await expect(page.getByTestId('research-live')).toHaveCount(0)
})

test('Stop ends the run, and it still counts', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await research(page, 'mock:slow stop me')
  const live = page.getByTestId('research-live')
  await expect(live.locator('[data-kind="search"]').first()).toBeVisible({ timeout: 10_000 })
  await live.getByTestId('research-stop').click()
  const card = page.getByTestId('research-card')
  await expect(card).toHaveAttribute('data-status', 'cancelled')
  await expect(card.getByTestId('research-cancelled')).toContainText('You stopped this run. It still counts as one of today’s.')
  await expect(card.getByTestId('research-report')).toHaveCount(0)
  await expect(await researchMeter(page)).toHaveText('1/3')
  await closeMeter(page)

  await page.reload()
  await expect(page.getByTestId('research-card')).toHaveAttribute('data-status', 'cancelled')
  await noHorizontalScroll(page)
})

test('Research this puts the question an answer was for into the composer, ready to research', async ({ page, baseURL }) => {
  test.skip(isPhone(page), 'Research this sits in the answer actions on a desktop; phones use the composer button')
  await signIn(page, baseURL!)
  await sendMessage(page, 'Which e-bike battery size do I need for a 20 km commute?')
  await expect(page.getByTestId('answer')).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  await page.getByTestId('research-this').click()
  await expect(composer(page)).toHaveValue('Which e-bike battery size do I need for a 20 km commute?')
  await expect(composer(page)).toBeFocused()
  await expect(scope(page).getByTestId('research-toggle')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('research-card')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
  // In the same chat, after the answer.
  await expect(page.getByTestId('user-message')).toHaveCount(2)
  await expect(page.getByTestId('answer')).toHaveCount(1)
})

test('guests are asked to sign in to research', async ({ page }) => {
  await skipIntro(page)
  await page.goto('/')
  await scope(page).getByTestId('research-toggle').click()
  await expect(page.getByTestId('sign-in')).toContainText('Sign in to research')
  const response = await page.request.post('/api/chat/research', { data: { question: 'e-bikes?' } })
  expect(response.status()).toBe(401)
})

test('with today’s runs used, research mode says so and can’t start one', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  for (let i = 0; i < 3; i++) {
    const started = await page.request.post('/api/runs', { data: { question: `mock:slow run ${i}` } })
    expect(started.status()).toBe(201)
    const { run } = await started.json()
    expect((await page.request.post(`/api/runs/${run.id}/cancel`)).ok()).toBe(true)
  }
  const refused = await page.request.post('/api/chat/research', { data: { question: 'one more?' } })
  expect(refused.status()).toBe(429)
  expect((await refused.json()).error).toBe('research_daily_limit')

  await page.reload()
  await scope(page).getByTestId('research-toggle').click()
  await composer(page).fill('One more question?')
  await expect(page.getByTestId('research-hint').filter({ visible: true })).toHaveText('No research runs left today. They come back at midnight UTC.')
  await expect(scope(page).getByTestId('send')).toBeDisabled()
  await noHorizontalScroll(page)
})

test('a network that used its runs is told so in the chat', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  // Failed runs give the person's run back, but each one counted for the network.
  for (let i = 0; i < 9; i++) {
    const started = await page.request.post('/api/runs', { data: { question: `mock:fail run ${i}` } })
    expect(started.status()).toBe(201)
    const { run } = await started.json()
    await expect
      .poll(async () => (await (await page.request.get(`/api/runs/${run.id}`)).json()).run.status, { timeout: 10_000 })
      .toBe('failed')
  }
  await page.reload()
  await research(page, 'Still allowed?')
  await expect(page.getByTestId('chat-error').filter({ visible: true })).toHaveText('This network has used today’s research runs. They come back at midnight UTC.')
  // The question stays, ready for later.
  await expect(composer(page)).toHaveValue('Still allowed?')
  await expect(page.getByTestId('research-card')).toHaveCount(0)
})

test('with Tavily out of credits the run stops, says so plainly and doesn’t count', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await research(page, 'mock:tavily-down which e-bike?')
  const card = page.getByTestId('research-card')
  await expect(card).toHaveAttribute('data-status', 'failed', { timeout: 30_000 })
  const failed = card.getByTestId('research-failed')
  await expect(failed).toContainText(
    'Stopped without a report. Tavily, the web search research uses, is out of credits right now. This run doesn’t count against today’s 3.'
  )
  // Tavily is the only search: nothing else searched.
  await expect(failed.getByTestId('research-searched')).toHaveCount(0)
  await expect(failed).not.toContainText('Google')
  await expect(failed.getByTestId('research-retry')).toBeVisible()
  await expect(await researchMeter(page)).toHaveText('0/3')
  await closeMeter(page)
  await noHorizontalScroll(page)

  // Try again starts the same question as a new run in the chat.
  await failed.getByTestId('research-retry').click()
  await expect(page.getByTestId('research-card')).toHaveCount(2)
  await expect(page.getByTestId('research-card').last()).toHaveAttribute('data-status', 'failed', { timeout: 30_000 })
})

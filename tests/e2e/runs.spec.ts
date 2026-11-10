import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { isPhone, noHorizontalScroll, signIn } from './helpers'

/** The Runs page at desktop and phone widths, against the Tavily and Gemini mocks. */

async function openRuns(page: Page) {
  if (isPhone(page)) await page.locator('.mnav').getByRole('link', { name: 'Runs' }).click()
  else await page.locator('.side').getByRole('link', { name: 'Research runs' }).click()
  await expect(page).toHaveURL(/\/runs$/)
  await expect(page.getByTestId('run-list').or(page.getByText('Your research runs will show up here.'))).toBeVisible()
}

async function startRun(page: Page, question: string) {
  await page.getByTestId('run-question').fill(question)
  await page.getByTestId('run-go').click()
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/)
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

test('start a run, watch it finish, and read the report with its sources', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await openRuns(page)
  await expect(page.getByTestId('runs-left')).toHaveText('3 of 3 runs left today')
  await startRun(page, 'What should I look for in an e-bike under $1,500?')

  const view = page.getByTestId('run-view')
  await expect(view).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('run-status')).toHaveText('Done')
  await expect(page.getByTestId('run-question-title')).toHaveText('What should I look for in an e-bike under $1,500?')

  // The report: citations link to sources that were read.
  const report = page.getByTestId('run-report')
  await expect(report.locator('h2')).toHaveText('What to check')
  const sources = page.getByTestId('run-source')
  const count = await sources.count()
  expect(count).toBeGreaterThanOrEqual(3)
  const sourceUrls = await sources.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href')))
  const citations = report.locator('a')
  expect(await citations.count()).toBeGreaterThan(0)
  for (const href of await citations.evaluateAll((links) => links.map((a) => a.getAttribute('href')))) {
    expect(sourceUrls).toContain(href)
  }
  await expect(citations.first()).toHaveText('[1]')
  await expect(citations.first()).toHaveAttribute('rel', /noopener/)
  await expect(citations.first()).toHaveAttribute('target', '_blank')

  // The steps, kept below the report: searched, read and skipped, with reasons.
  const steps = page.getByTestId('run-steps')
  await steps.locator('summary').click()
  await expect(steps.locator('[data-kind="search"]')).toHaveCount(3)
  await expect(steps.locator('[data-kind="search"]').first()).toContainText('Searched “e-bike under $1,500 buying guide”')
  await expect(steps.locator('[data-kind="search"]').first()).toContainText('5 results from Tavily')
  await expect(steps.locator('[data-kind="read"]')).toHaveCount(count)
  await expect(steps.locator('[data-kind="skip"]', { hasText: 'Router admin' }).first()).toContainText('a private or local address')
  await expect(steps).toContainText(`Cites`)

  await expect(await researchMeter(page)).toHaveText('1/3')
  if (isPhone(page)) await page.getByTestId('title-menu').click()
  await noHorizontalScroll(page)

  // Still there after a reload, and listed.
  await page.reload()
  await expect(page.getByTestId('run-report')).toBeVisible()
  await page.getByTestId('runs-back').click()
  await expect(page).toHaveURL(/\/runs$/)
  const row = page.getByTestId('run-row').first()
  await expect(row).toContainText('What should I look for in an e-bike under $1,500?')
  await expect(row).toContainText('Done')
  await expect(row).toContainText(`${count} sources`)
  await expect(page.getByTestId('runs-left')).toHaveText('2 of 3 runs left today')
  await noHorizontalScroll(page)
})

test('watch a run live and cancel it', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await openRuns(page)
  await startRun(page, 'mock:slow which e-bike?')
  const view = page.getByTestId('run-view')
  await expect(page.getByTestId('run-status')).toHaveText('Searching')
  await expect(view.locator('[data-kind="plan"]')).toContainText('Planned 3 searches')
  await expect(view.locator('[data-kind="search"]').first()).toContainText('5 results from Tavily')
  await page.getByTestId('run-cancel').click()
  await expect(view).toHaveAttribute('data-status', 'cancelled')
  await expect(page.getByTestId('run-cancelled')).toContainText('You cancelled this run')
  await expect(page.getByTestId('run-cancel')).toBeHidden()
  await expect(page.getByTestId('run-report')).toBeHidden()
  await noHorizontalScroll(page)
})

test('a run that fails says why and does not count', async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await openRuns(page)
  await startRun(page, 'mock:fail plan this')
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-status', 'failed')
  await expect(page.getByTestId('run-failed')).toContainText('Stopped without a report. Gemini didn’t answer.')
  await expect(page.getByTestId('run-failed')).toContainText('doesn’t count against today’s 3')
  await expect(page.getByTestId('run-retry')).toBeVisible()
  await expect(await researchMeter(page)).toHaveText('0/3')
  await noHorizontalScroll(page)
})

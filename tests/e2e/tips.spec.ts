import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { composer, isPhone } from './helpers'

/** The tips tour: a guided sequence with Next/Done, a step count, Skip tips, and X or Esc to end it. */

// A phone has no sidebar, so the Memory "+" and the meter aren't on screen: two tips instead of four.
const ids = (page: Page) => (isPhone(page) ? ['mic', 'res'] : ['mic', 'res', 'mem', 'meter'])

async function startTour(page: Page) {
  await page.goto('/')
  await page.getByTestId('how-it-works').getByRole('button', { name: 'Show me around' }).click()
  await expect(page.getByTestId('tip')).toHaveAttribute('data-tip-id', 'mic')
}

test('Next walks through every tip and Done ends the tour', async ({ page }) => {
  await startTour(page)
  const tip = page.getByTestId('tip')
  const steps = ids(page)
  for (const [i, id] of steps.entries()) {
    await expect(tip).toHaveAttribute('data-tip-id', id)
    await expect(tip.getByTestId('tip-step')).toHaveText(`${i + 1} of ${steps.length}`)
    await expect(tip.getByRole('button', { name: 'Skip tips' })).toBeVisible()
    const next = tip.getByTestId('tip-next')
    await expect(next).toHaveText(i === steps.length - 1 ? 'Done' : 'Next')

    // The tip sits fully on screen.
    const box = (await tip.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.y).toBeGreaterThanOrEqual(0)
    await next.click()
  }
  await expect(tip).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('welcome')).toBeVisible()
  await expect(tip).toHaveCount(0)
})

test('Enter and the Right arrow go to the next tip; typing in the composer does not', async ({ page }) => {
  await startTour(page)
  const tip = page.getByTestId('tip')
  await page.keyboard.press('ArrowRight')
  await expect(tip).toHaveAttribute('data-tip-id', 'res')
  await expect(tip.getByTestId('tip-step')).toHaveText(`2 of ${ids(page).length}`)

  await composer(page).click()
  await composer(page).pressSequentially('hello')
  await page.keyboard.press('ArrowRight')
  await expect(tip).toHaveAttribute('data-tip-id', 'res')

  await tip.getByTestId('tip-next').focus()
  await page.keyboard.press('Enter')
  if (isPhone(page)) await expect(tip).toHaveCount(0)
  else await expect(tip).toHaveAttribute('data-tip-id', 'mem')
})

for (const [how, end] of [
  ['X', (page: Page) => page.getByTestId('tip').getByRole('button', { name: 'Close tips' }).click()],
  ['Esc', (page: Page) => page.keyboard.press('Escape')],
  ['Skip tips', (page: Page) => page.getByTestId('tip').getByRole('button', { name: 'Skip tips' }).click()],
] as const) {
  test(`${how} ends the whole tour instead of advancing`, async ({ page }) => {
    await startTour(page)
    await end(page)
    await expect(page.getByTestId('tip')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('welcome')).toBeVisible()
    await expect(page.getByTestId('tip')).toHaveCount(0)
  })
}

test('"How this works" opens the explainer and the tour carries on after it', async ({ page }) => {
  await startTour(page)
  const tip = page.getByTestId('tip')
  await tip.getByRole('button', { name: 'How this works' }).click()
  const explainer = page.getByTestId('explainer')
  await expect(explainer).toContainText('How talking will work')
  await expect(tip).toHaveCount(0)
  await explainer.getByRole('button', { name: 'Got it' }).click()
  await expect(tip).toHaveAttribute('data-tip-id', 'mic')
})

test('the "?" dialog starts the tips again', async ({ page }) => {
  await startTour(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('tip')).toHaveCount(0)
  await page.getByTestId(isPhone(page) ? 'help-phone' : 'help').click()
  await page.getByTestId('how-it-works').getByRole('button', { name: 'Show me around' }).click()
  await expect(page.getByTestId('tip')).toHaveAttribute('data-tip-id', 'mic')
  await expect(page.getByTestId('tip-step')).toHaveText(`1 of ${ids(page).length}`)
})

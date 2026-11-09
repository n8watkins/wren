import { expect, test } from './fixtures'
import { isPhone } from './helpers'

test('"Show me around" walks through the tips one at a time', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('how-it-works').getByRole('button', { name: 'Show me around' }).click()
  const tip = page.getByTestId('tip')
  await expect(tip).toHaveCount(1)
  await expect(tip).toHaveAttribute('data-tip-id', 'mic')
  const total = isPhone(page) ? 2 : 4
  await expect(tip).toContainText(`1 of ${total}`)

  // The tip sits fully on screen, above its control.
  const box = await tip.boundingBox()
  const viewport = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  expect(box!.y).toBeGreaterThanOrEqual(0)

  await tip.getByRole('button', { name: 'How this works' }).click()
  await expect(page.getByTestId('explainer')).toContainText('How talking will work')
  await page.getByTestId('explainer').getByRole('button', { name: 'Got it' }).click()

  await tip.getByRole('button', { name: 'Close tip' }).click()
  await expect(tip).toHaveAttribute('data-tip-id', 'res')
  await tip.getByRole('button', { name: 'Close tip' }).click()
  if (!isPhone(page)) {
    await expect(tip).toHaveAttribute('data-tip-id', 'mem')
    await tip.getByRole('button', { name: 'Close tip' }).click()
    await expect(tip).toHaveAttribute('data-tip-id', 'meter')
    await tip.getByRole('button', { name: 'Close tip' }).click()
  }
  await expect(tip).toHaveCount(0)
  await page.reload()
  await expect(tip).toHaveCount(0)
})
